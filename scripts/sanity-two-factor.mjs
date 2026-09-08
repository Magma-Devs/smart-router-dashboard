#!/usr/bin/env node
/**
 * MAG-2730 acceptance checks — the ticket's own "done when" list, run against a
 * live deployment rather than asserted in unit tests.
 *
 *   make accounts-reset && make accounts      # a genuinely fresh install
 *   node scripts/sanity-two-factor.mjs
 *
 * Why a live run: most of this list is about what a *deployment* does. "A user
 * with 2FA set up cannot sign in without the code" is a statement about two HTTP
 * calls in sequence; "the secret cannot be read back out by anyone, including
 * us" is a statement about every read surface at once, including the CSV export
 * and the database; and the host recovery commands do not exist inside the api
 * process at all.
 *
 * Two items cannot be checked in wall-clock time and say so rather than being
 * quietly skipped: the thirtieth day, and the fifteen-minute lockout expiring.
 * Both are asserted at the boundary the api reports instead.
 *
 * Env: API (default http://localhost:8000), AUTH_SECRET, SETUP_TOKEN,
 * PG_CONTAINER, API_CONTAINER.
 */

import { createHmac } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const API = process.env.API ?? "http://localhost:8000";
const SECRET = process.env.AUTH_SECRET ?? "dev-secret-change-me-please-32chars!";
const SETUP_TOKEN = process.env.SETUP_TOKEN ?? "installer-printed-this-token";
const PG = process.env.PG_CONTAINER ?? "smart-router-dashboard-dev-postgres-1";
const API_CT = process.env.API_CONTAINER ?? "smart-router-dashboard-dev-api-1";

const ADMIN = { email: "ops.admin@magmadevs.com", password: "an-admin-passphrase-4417" };
const MEMBER = { email: "dana.okonkwo@dfns.co", password: "dana-chose-this-one-8890" };

// ── harness ─────────────────────────────────────────────────────────────────

let checkNo = 0;
const results = [];
let current = null;

function check(title) {
  current = { no: ++checkNo, title, ok: true };
  results.push(current);
  process.stdout.write(`\n\x1b[1m${current.no}. ${title}\x1b[0m\n`);
}
function ok(label, cond, detail = "") {
  const pass = !!cond;
  if (!pass) current.ok = false;
  const mark = pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  process.stdout.write(`   ${mark} ${label}${pass || !detail ? "" : `\n       ${detail}`}\n`);
}
function note(text) {
  process.stdout.write(`   \x1b[90m·\x1b[0m \x1b[90m${text}\x1b[0m\n`);
}

async function call(method, path, { body, token } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(API + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

const b64 = (s) => Buffer.from(s).toString("base64url");
function mintToken({ userId, email, sessionId, role = "admin" }) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64(
    JSON.stringify({
      sub: userId,
      email,
      role,
      sid: sessionId,
      iss: "smart-router-dashboard-web",
      aud: "smart-router-dashboard-api",
      iat: now,
      exp: now + 3600,
    }),
  );
  const sig = createHmac("sha256", SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}
const tokenFor = (r) =>
  mintToken({ userId: r.user.id, email: r.user.email, sessionId: r.sessionId });

async function sql(query) {
  const { stdout } = await exec("docker", [
    "exec",
    PG,
    "psql",
    "-U",
    "sr",
    "-d",
    "sr_dashboard",
    "-tAF|",
    "-c",
    query,
  ]);
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("|"));
}

/**
 * The token out of a link the api logged rather than returned.
 *
 * Managed mode withholds invitation and reset links from the response — they go
 * to the recipient and nowhere else — so on that shape this is the only place a
 * script can reach one. On-prem never needs it.
 */
async function linkTokenFromLog(kind) {
  const { stdout } = await exec("docker", ["logs", "--tail", "400", API_CT]);
  const re =
    kind === "invite" ? /\/invite\/([A-Za-z0-9_-]{20,})/g : /\/reset\/([A-Za-z0-9_-]{20,})/g;
  const found = [...stdout.matchAll(re)].map((m) => m[1]);
  return found[found.length - 1] ?? null;
}

// ── TOTP, matching apps/api/src/services/totp.ts ────────────────────────────

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32decode(text) {
  let bits = 0,
    value = 0;
  const out = [];
  for (const c of text.replace(/[\s=-]/g, "").toUpperCase()) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
const stepNow = () => Math.floor(Date.now() / 30000);
function totpCode(secret, step = stepNow()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const d = createHmac("sha1", b32decode(secret)).update(counter).digest();
  const o = d[d.length - 1] & 0x0f;
  const n =
    ((d[o] & 0x7f) << 24) |
    ((d[o + 1] & 0xff) << 16) |
    ((d[o + 2] & 0xff) << 8) |
    (d[o + 3] & 0xff);
  return String(n % 1000000).padStart(6, "0");
}

async function enrol(token) {
  const begun = await call("POST", "/api/account/2fa/begin", { token, body: {} });
  if (begun.status !== 200) throw new Error(`enrol begin: ${begun.status} ${begun.text}`);
  const secret = begun.body.secret;
  const done = await call("POST", "/api/account/2fa/confirm", {
    token,
    body: { code: totpCode(secret) },
  });
  if (done.status !== 200) throw new Error(`enrol confirm: ${done.status} ${done.text}`);
  return { secret, qrSvg: begun.body.qrSvg };
}

/** Both factors. Uses the next step, because enrolment just spent this one. */
async function signInFully(creds, secret, step = stepNow() + 1) {
  const first = await call("POST", "/auth/sign-in", { body: creds });
  if (!first.body?.twoFactorRequired) return first;
  return call("POST", "/auth/2fa/verify", {
    body: { challenge: first.body.challenge, code: totpCode(secret, step) },
  });
}

// ── the run ─────────────────────────────────────────────────────────────────

const boot = await call("GET", "/auth/bootstrap");
if (boot.body?.needsSetup !== true) {
  process.stdout.write(
    "\n\x1b[31mThis deployment already has accounts.\x1b[0m These checks start from a fresh install:\n" +
      "  make accounts-reset && make accounts\n",
  );
  process.exit(2);
}
process.stdout.write(
  `\x1b[1mMAG-2730 acceptance checks\x1b[0m  ·  ${API}  ·  DEPLOYMENT_MODE=${boot.body.mode}\n`,
);

// 1 ──────────────────────────────────────────────────────────────────────────
check("The first admin can defer setup and reach the dashboard, with a countdown");
await call("POST", "/auth/setup", { body: { token: SETUP_TOKEN, ...ADMIN, name: "Ops Admin" } });
const adminIn = (await call("POST", "/auth/sign-in", { body: ADMIN })).body;
ok("the first admin signs in with a password alone", !!adminIn?.sessionId);
let adminToken = tokenFor(adminIn);

const me = await call("GET", "/api/account/me", { token: adminToken });
ok(
  "the dashboard opens",
  (await call("GET", "/api/metrics/specs", { token: adminToken })).status === 200,
);
ok("2FA is reported as not set up", me.body?.twoFactor?.enrolled === false);
ok(
  "with a countdown of 30 days",
  me.body?.twoFactor?.daysLeft === 30,
  String(me.body?.twoFactor?.daysLeft),
);
ok("and it is not yet required", me.body?.twoFactor?.enrolmentRequired === false);

// 2 ──────────────────────────────────────────────────────────────────────────
check("That admin cannot send an invite until they have set it up");
const blockedInvite = await call("POST", "/api/team/invites", {
  token: adminToken,
  body: { email: MEMBER.email, role: "approver" },
});
ok("the invite is refused", blockedInvite.status === 403, `${blockedInvite.status}`);
ok("with a reason the UI can act on", blockedInvite.body?.code === "TWO_FACTOR_REQUIRED");

// 3 ──────────────────────────────────────────────────────────────────────────
check("Blocked from the dashboard 30 days after first sign-in");
{
  const [[stamp]] = await sql(
    `select first_signin_at is not null from users where email = '${ADMIN.email}'`,
  );
  ok("first_signin_at is stamped, which is what the clock counts from", stamp === "t");
  // The thirtieth day cannot be waited for. Move the stamp back and read the
  // api's own answer — the same function the gate consults.
  await sql(
    `update users set first_signin_at = now() - interval '31 days' where email = '${ADMIN.email}'`,
  );
  const past = await call("GET", "/api/account/me", { token: adminToken });
  ok("past thirty days, enrolment is required", past.body?.twoFactor?.enrolmentRequired === true);
  ok(
    "and the dashboard is shut",
    (await call("GET", "/api/metrics/specs", { token: adminToken })).status === 403,
  );
  await sql(`update users set first_signin_at = now() where email = '${ADMIN.email}'`);
  note("the thirtieth day is asserted by moving first_signin_at, not by waiting");
}

// 4 ──────────────────────────────────────────────────────────────────────────
check("Setting it up: a QR, the same secret as text, and a code to confirm");
const adminEnrolment = await enrol(adminToken);
ok("a QR comes back as SVG", adminEnrolment.qrSvg.startsWith("<svg"));
ok("with the secret as text beside it", /^[A-Z2-7]{32}$/.test(adminEnrolment.secret));
ok(
  "the dashboard is open again",
  (await call("GET", "/api/metrics/specs", { token: adminToken })).status === 200,
);
ok(
  "and the invite now goes through",
  (
    await call("POST", "/api/team/invites", {
      token: adminToken,
      body: { email: MEMBER.email, role: "approver" },
    })
  ).status === 201,
);

// 5 ──────────────────────────────────────────────────────────────────────────
check("Anyone joining by invite cannot reach the dashboard without setting it up");
const invites = await call("GET", "/api/team/invites", { token: adminToken });
const inviteId = invites.body?.invites?.[0]?.id;
const resent = await call("POST", `/api/team/invites/${inviteId}/resend`, { token: adminToken });
// On managed the response withholds the link — it goes to the recipient and
// nowhere else, which is the point of having a transport. Fall back to the line
// the api logs, so this runs in both deployment shapes.
const token =
  String(resent.body?.url ?? "")
    .split("/")
    .pop() || (await linkTokenFromLog("invite"));
if (!token) throw new Error("could not obtain an invitation token");
const joined = await call("POST", "/auth/invite/accept", {
  body: { token, password: MEMBER.password, name: "Dana Okonkwo" },
});
ok("they join", joined.status === 201, `${joined.status} ${joined.text}`);
const memberToken = tokenFor(joined.body);
ok(
  "and the dashboard is shut until they enrol",
  (await call("GET", "/api/metrics/specs", { token: memberToken })).status === 403,
);
ok(
  "with no grace period at all",
  (await call("GET", "/api/account/me", { token: memberToken })).body?.twoFactor?.daysLeft === null,
);
const memberEnrolment = await enrol(memberToken);
ok(
  "enrolling opens it",
  (await call("GET", "/api/metrics/specs", { token: memberToken })).status === 200,
);

// 6 ──────────────────────────────────────────────────────────────────────────
check("A user with 2FA set up cannot sign in without the code");
{
  const first = await call("POST", "/auth/sign-in", { body: MEMBER });
  ok("the password alone is not a sign-in", first.body?.twoFactorRequired === true);
  ok("and it opens no session", first.body?.sessionId === undefined);
  ok("a challenge comes back instead", typeof first.body?.challenge === "string");
}

// 7 ──────────────────────────────────────────────────────────────────────────
check("A wrong code, a reused code, and a sixth attempt each behave as described");
{
  const start = await call("POST", "/auth/sign-in", { body: MEMBER });
  const wrong = await call("POST", "/auth/2fa/verify", {
    body: { challenge: start.body.challenge, code: "000000" },
  });
  ok("a wrong code is refused", wrong.status === 401);
  ok(
    "with a generic message naming neither factor",
    wrong.body?.message === "Invalid email or password",
    wrong.body?.message,
  );

  // Reuse: sign in properly, then present the same code again.
  const step = stepNow() + 1;
  const good = await signInFully(MEMBER, memberEnrolment.secret, step);
  ok("the right code signs them in", good.status === 200, `${good.status}`);
  const replay = await signInFully(MEMBER, memberEnrolment.secret, step);
  ok("the same code cannot be used twice, inside its own window", replay.status === 401);

  // Five failures, then the wall. Four wrong passwords and one wrong code, to
  // show they land in the same counter.
  for (let i = 0; i < 4; i++) {
    await call("POST", "/auth/sign-in", { body: { ...MEMBER, password: "wrong" } });
  }
  const fifth = await call("POST", "/auth/sign-in", { body: MEMBER });
  await call("POST", "/auth/2fa/verify", {
    body: { challenge: fifth.body?.challenge, code: "000000" },
  });
  const sixth = await call("POST", "/auth/sign-in", { body: MEMBER });
  ok("a sixth attempt is locked out", sixth.status === 423, `${sixth.status}`);
  note("failed codes and failed passwords share one counter — five total, not five each");
  await sql(`delete from login_attempts where email = lower('${MEMBER.email}')`);
}

// 8 ──────────────────────────────────────────────────────────────────────────
check("A code from a phone whose clock is 20 seconds out still works");
{
  // 20s out lands in the neighbouring step at least a third of the time; the
  // window is what makes it work whenever it does.
  for (const offset of [-1, +1]) {
    const first = await call("POST", "/auth/sign-in", { body: MEMBER });
    const res = await call("POST", "/auth/2fa/verify", {
      body: {
        challenge: first.body.challenge,
        code: totpCode(memberEnrolment.secret, stepNow() + offset),
      },
    });
    ok(
      `a code ${offset < 0 ? "one step behind" : "one step ahead"} is accepted`,
      res.status === 200,
      `${res.status}`,
    );
  }
  const far = await call("POST", "/auth/sign-in", { body: MEMBER });
  const tooFar = await call("POST", "/auth/2fa/verify", {
    body: { challenge: far.body.challenge, code: totpCode(memberEnrolment.secret, stepNow() + 5) },
  });
  ok("but five steps out is not", tooFar.status === 401);
}

// 9 ──────────────────────────────────────────────────────────────────────────
check("An admin can see who has 2FA, and reset it for someone who lost their phone");
{
  const members = await call("GET", "/api/team/members", { token: adminToken });
  const rows = members.body?.members ?? [];
  ok(
    "the member list carries a real 2FA value, not a dash",
    rows.every((m) => typeof m.twoFactorEnabled === "boolean"),
  );
  ok(
    "and says both people have it",
    rows.every((m) => m.twoFactorEnabled === true),
  );

  const csv = await call("GET", "/api/team/members.csv", { token: adminToken });
  ok(
    "the CSV export has a two_factor column",
    csv.text.split("\n")[0].split(",").includes("two_factor"),
    csv.text.split("\n")[0],
  );
  {
    const lines = csv.text.trim().split("\n");
    const col = lines[0].split(",").indexOf("two_factor");
    ok(
      "and every data row in it says yes",
      col !== -1 && lines.length > 1 && lines.slice(1).every((l) => l.split(",")[col] === "yes"),
      lines.slice(1).join(" · "),
    );
  }

  const memberId = rows.find((m) => m.email === MEMBER.email)?.id;
  const reset = await call("POST", `/api/team/members/${memberId}/2fa/reset`, {
    token: adminToken,
  });
  ok("the admin can reset it", reset.status === 200, `${reset.status} ${reset.text}`);

  const [[secretGone]] = await sql(
    `select totp_secret is null and totp_enrolled_at is null from users where id = '${memberId}'`,
  );
  ok("the old secret is destroyed, not disabled", secretGone === "t");
  ok(
    "their sessions ended immediately",
    (await call("GET", "/api/account/me", { token: memberToken })).status === 401,
  );

  const backIn = await call("POST", "/auth/sign-in", { body: MEMBER });
  ok("they sign in with their password alone", backIn.status === 200 && !!backIn.body?.sessionId);
  const told = await call("GET", "/api/account/me", { token: tokenFor(backIn.body) });
  ok(
    "and are told, by being asked to set it up again",
    told.body?.twoFactor?.enrolmentRequired === true,
  );

  const [[actor, target]] = await sql(
    `select actor_name, target_name from audit_events where action = '2fa.reset' limit 1`,
  );
  ok("the log names both people", !!actor && target === MEMBER.email, `${actor} → ${target}`);
}

// 10 ─────────────────────────────────────────────────────────────────────────
check("A deployment with no working admin can be recovered from the host");
{
  /**
   * The dev stack runs `tsx watch src/main.ts`, so there is no `dist/` in that
   * container — the published image runs `node dist/recover.js`, which is what
   * TWO-FACTOR.md documents for a real deployment. `RECOVER_CMD` overrides this
   * for a run against one.
   */
  const RECOVER = (
    process.env.RECOVER_CMD ?? "pnpm --filter @sr/api exec tsx src/recover.ts"
  ).split(" ");
  const run = async (...args) => {
    const { stdout } = await exec("docker", ["exec", API_CT, ...RECOVER, ...args]);
    return stdout;
  };

  const out = await run("reset-2fa", "--email", ADMIN.email, "--by", "victoria");
  ok("reset-2fa clears the authenticator", out.includes(ADMIN.email));
  const [[gone]] = await sql(
    `select totp_secret is null from users where email = '${ADMIN.email}'`,
  );
  ok("and the secret is gone", gone === "t");

  const link = await run("reset-password", "--email", ADMIN.email, "--by", "victoria");
  ok("reset-password prints a one-time link", /\/reset\/[A-Za-z0-9_-]+/.test(link));
  const [[hashUnchanged]] = await sql(
    `select password_hash is not null from users where email = '${ADMIN.email}'`,
  );
  ok("and does not set a password", hashUnchanged === "t");

  await sql(`update users set role = 'read_only' where email = '${ADMIN.email}'`);
  await run("promote-admin", "--email", ADMIN.email, "--by", "victoria");
  const [[role]] = await sql(`select role from users where email = '${ADMIN.email}'`);
  ok("promote-admin restores an admin", role === "admin");

  const rows = await sql(
    `select actor_kind, actor_name, note, ip is null and client is null and session_id is null
       from audit_events where action = 'host.recovery' order by occurred_at`,
  );
  ok("three recovery rows are in the log", rows.length === 3, String(rows.length));
  ok(
    "each names the operator",
    rows.every((r) => r[1].includes("victoria")),
  );
  ok(
    "each names the command",
    rows.some((r) => r[2].includes("reset-2fa")) &&
      rows.some((r) => r[2].includes("promote-admin")),
  );
  ok(
    "and carries no browser context, because there is no browser",
    rows.every((r) => r[3] === "t"),
  );
  ok(
    "the attribution says it is what the shell reported, not what it proved",
    rows.every((r) => r[2].includes("not an authenticated identity")),
  );
}

// 11 ─────────────────────────────────────────────────────────────────────────
check("The secret cannot be read back out by anyone, including us");
{
  const secrets = [adminEnrolment.secret, memberEnrolment.secret];

  const [[stored]] = await sql(
    `select coalesce(totp_secret, '') from users where email = '${MEMBER.email}'`,
  ).catch(() => [[""]]);
  ok(
    "the database column holds an envelope, never the secret",
    secrets.every((s) => !stored.includes(s)),
    stored.slice(0, 24),
  );

  const surfaces = await Promise.all([
    call("GET", "/api/account/me", { token: adminToken }),
    call("GET", "/api/team/members", { token: adminToken }),
    call("GET", "/api/team/members.csv", { token: adminToken }),
  ]);
  ok(
    "no read surface returns it",
    surfaces.every((r) => secrets.every((s) => !r.text.includes(s))),
  );

  const auditText = (
    await sql(`select coalesce(note,'') || coalesce(actor_name,'') from audit_events`)
  )
    .map((r) => r[0])
    .join("\n");
  ok(
    "and it is nowhere in the audit log",
    secrets.every((s) => !auditText.includes(s)),
  );

  // Asked of the MEMBER, not the admin: check 10's reset cleared the admin's,
  // so asking there would test the un-enrolled path and pass for the wrong
  // reason. Their session died with the reset, so sign in again first.
  const memberBack = await signInFully(MEMBER, memberEnrolment.secret);
  const reoffer = await call("POST", "/api/account/2fa/begin", {
    token: tokenFor(memberBack.body),
    body: {},
  });
  ok(
    "an enrolled account cannot re-offer its own secret",
    reoffer.status === 409,
    `${reoffer.status}`,
  );
  ok("and the refusal carries nothing to read back", !reoffer.text.includes(secrets[1]));
}

// ── summary ─────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.ok).length;
process.stdout.write(
  `\n\x1b[1m${passed}/${results.length}\x1b[0m checks passed\n` +
    results
      .map((r) => `  ${r.ok ? "\x1b[32m✓" : "\x1b[31m✗"}\x1b[0m ${r.no}. ${r.title}`)
      .join("\n") +
    "\n",
);
process.exit(passed === results.length ? 0 : 1);
