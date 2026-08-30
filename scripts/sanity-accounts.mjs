#!/usr/bin/env node
/**
 * MAG-2729 acceptance checks — the eleven Omer listed on the ticket, run against
 * a live deployment rather than asserted in unit tests.
 *
 *   make accounts-reset && make accounts      # a genuinely fresh install
 *   node scripts/sanity-accounts.mjs
 *
 * Why a live run and not vitest: several of these are only meaningful against a
 * real deployment. "A lower role is refused the action when it's attempted
 * directly, not just when the button is hidden" is a statement about the api
 * with a real token in hand. "Their next action is refused without them signing
 * out" is a statement about a session that already exists. And this ticket has
 * a documented history of defects that a green suite could not see — the CORS
 * preflight that blocked every mutation is the clearest one, invisible to
 * `app.inject()` because it never crosses an origin.
 *
 * Check 1 needs an install with no accounts, so the script refuses to run
 * against a deployment that has already been set up. That is the check.
 *
 * Env: API (default http://localhost:8000), WEB (http://localhost:3000),
 * AUTH_SECRET (must match the api's), SETUP_TOKEN.
 */

import { createHmac } from "node:crypto";

const API = process.env.API ?? "http://localhost:8000";
const WEB = process.env.WEB ?? "http://localhost:3000";
const SECRET = process.env.AUTH_SECRET ?? "dev-secret-change-me-please-32chars!";
const SETUP_TOKEN = process.env.SETUP_TOKEN ?? "installer-printed-this-token";
const SES_UI = process.env.SES_UI ?? "http://localhost:8005";

const ADMIN = { email: "ops.admin@magmadevs.com", password: "an-admin-passphrase-4417" };
const MEMBER = { email: "dana.okonkwo@dfns.co", password: "dana-chose-this-one-8890" };
const RESET_PW = "dana-picked-a-new-one-2231";

/** Every secret this run puts into the system. Check 11 asserts none of them
 *  ever appears as a value in the audit log. */
const SECRETS = [ADMIN.password, MEMBER.password, RESET_PW, SETUP_TOKEN];
const TOKENS_SEEN = [];

// ── tiny harness ────────────────────────────────────────────────────────────

let checkNo = 0;
const results = [];
let current = null;

function check(title) {
  current = { no: ++checkNo, title, asserts: [], ok: true };
  results.push(current);
  process.stdout.write(`\n\x1b[1m${current.no}. ${title}\x1b[0m\n`);
}

function ok(label, cond, detail = "") {
  const pass = !!cond;
  current.asserts.push({ label, pass });
  if (!pass) current.ok = false;
  const mark = pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  process.stdout.write(`   ${mark} ${label}${pass || !detail ? "" : `\n       ${detail}`}\n`);
}

function note(text) {
  process.stdout.write(`   \x1b[90m·\x1b[0m \x1b[90m${text}\x1b[0m\n`);
}

// ── http ────────────────────────────────────────────────────────────────────

async function call(method, path, { body, token, base = API, origin } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
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

// ── jwt, minted exactly as apps/web/src/auth.config.ts does ─────────────────

const b64 = (buf) => Buffer.from(buf).toString("base64url");

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
  const jwt = `${header}.${payload}.${sig}`;
  TOKENS_SEEN.push(jwt);
  return jwt;
}

const tokenFor = (signIn) =>
  mintToken({ userId: signIn.user.id, email: signIn.user.email, sessionId: signIn.sessionId });

/**
 * Wait past the current second before minting a token after a bulk revocation.
 *
 * `signed_out_all_at` and a JWT's `iat` both have one-second resolution, and
 * `checkSession` refuses a token whose `iat` is at or before the cutoff — the
 * comparison is `<=` on purpose, so somebody racing a sign-out cannot keep
 * their session. A script that resets a password and signs back in within the
 * same second therefore gets a token that is correctly refused. A human cannot
 * reach that window — the reset page does not sign you in, so they have to get
 * to /login and type — but this runner can, so it waits.
 */
const pastCutoff = () => new Promise((r) => setTimeout(r, 1100 - (Date.now() % 1000)));

// ── audit access ────────────────────────────────────────────────────────────

import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);

const PG = process.env.PG_CONTAINER ?? "smart-router-dashboard-dev-postgres-1";

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

// ── the run ─────────────────────────────────────────────────────────────────

const mode = (await call("GET", "/auth/bootstrap")).body?.mode ?? "unknown";
process.stdout.write(
  `\x1b[1mMAG-2729 acceptance checks\x1b[0m  ·  ${API}  ·  DEPLOYMENT_MODE=${mode}\n`,
);

// 1 ──────────────────────────────────────────────────────────────────────────
check("Create an account through the install");
{
  const boot = await call("GET", "/auth/bootstrap");
  if (boot.body?.needsSetup !== true) {
    process.stdout.write(
      "\n\x1b[31mThis deployment already has accounts.\x1b[0m Check 1 is about a fresh install:\n" +
        "  make accounts-reset && make accounts\n",
    );
    process.exit(2);
  }
  ok("a fresh install reports that it needs setting up", boot.body.needsSetup === true);

  // "nothing else in the dashboard is reachable until it exists"
  const guarded = await Promise.all([
    call("GET", "/api/team/members"),
    call("GET", "/api/metrics/overview"),
    call("GET", "/api/account/sessions"),
  ]);
  ok(
    "every /api/* route refuses an unauthenticated caller",
    guarded.every((r) => r.status === 401),
    guarded.map((r) => r.status).join(", "),
  );

  const home = await call("GET", "/", { base: WEB });
  const login = await call("GET", "/login?callbackUrl=%2F", { base: WEB });
  ok("the web sends an anonymous visitor to sign in", home.status === 307);
  ok(
    "and sign-in sends them on to first-run setup",
    login.status === 307 && String(login.headers.get("location")).includes("/setup"),
    String(login.headers.get("location")),
  );

  const wrongToken = await call("POST", "/auth/setup", {
    body: { token: "not-the-installers-token", email: ADMIN.email, password: ADMIN.password },
  });
  ok("setup without the installer's token is refused", wrongToken.status === 403);

  const created = await call("POST", "/auth/setup", {
    body: { token: SETUP_TOKEN, ...ADMIN, name: "Ops Admin" },
  });
  ok("the first account is created", created.status === 201, `${created.status} ${created.text}`);
  ok("and it is an admin", created.body?.user?.role === "admin", created.body?.user?.role);

  const after = await call("GET", "/auth/bootstrap");
  ok("the install no longer needs setting up", after.body?.needsSetup === false);
  const claimed = await call("POST", "/auth/setup", {
    body: { token: SETUP_TOKEN, email: "someone@else.co", password: "another-passphrase-99" },
  });
  ok("and setup cannot be claimed twice", claimed.status === 409);
}

const adminSignIn = (await call("POST", "/auth/sign-in", { body: ADMIN })).body;
const adminToken = tokenFor(adminSignIn);

// 2 ──────────────────────────────────────────────────────────────────────────
check("Create an account on managed — the person sets their own password");
{
  if (mode !== "managed") {
    note(`skipped: this deployment is ${mode}. Re-run with DEPLOYMENT_MODE=managed.`);
    note("On-prem is covered by check 3, which is the same flow without the email.");
    results.pop();
    checkNo--;
  } else {
    const inv = await call("POST", "/api/team/invites", {
      token: adminToken,
      body: { email: MEMBER.email, role: "read_only" },
    });
    ok("an invitation is created", inv.status === 201);
    ok(
      "the response carries no password anywhere",
      !JSON.stringify(inv.body ?? {}).includes("password"),
    );

    const inbox = await mailbox();
    if (inbox.length) {
      // A transport is running, so managed behaves the way it will in
      // production: the link goes to the recipient and to nobody else.
      const mail = inbox[inbox.length - 1];
      ok("the invitation was emailed", inv.body?.delivery === "email");
      ok("and the link is NOT returned to the admin", !inv.body?.url);
      ok(
        "it reached the invited address",
        mail.destination?.to?.[0] === MEMBER.email,
        JSON.stringify(mail.destination),
      );
      ok(
        "with the customer named in the subject",
        /You've been added to .+ on Smart Router/.test(mail.subject ?? ""),
        mail.subject,
      );
      ok("as text as well as HTML", !!mail.body?.text && !!mail.body?.html);
      ok("with a reply-to that somebody reads", (mail.replyTo ?? []).length > 0);
    } else {
      note("no transport configured — the link falls back to the admin");
      ok("the fallback is declared rather than silent", inv.body?.deliveryFallback === true);
      ok("and the link is handed over", !!inv.body?.url);
    }

    // Whether emailed or fallen back, the holder chooses the value.
    const url = inv.body?.url ?? (await linkFor("invite"));
    const redeemed = await call("POST", "/auth/invite/accept", {
      body: { token: url.split("/").pop(), password: MEMBER.password, name: "Dana Okonkwo" },
    });
    ok("the invited person sets their own password", redeemed.status === 201);
    ok("the account is theirs", redeemed.body?.user?.email === MEMBER.email);

    // MAG-2729, decided 26 Aug 2026. The two-step managed flow leaves a Magma
    // operator account on the deployment permanently, and the rule it answers
    // to is now visibility rather than absence: "no hidden Magma account, and
    // none the customer can't see in their member list."
    const roster = await call("GET", "/api/team/members", { token: adminToken });
    const rows = roster.body?.members ?? [];
    const ours = rows.find((m) => m.email === ADMIN.email);
    const theirs = rows.find((m) => m.email === MEMBER.email);
    ok("the Magma operator account is labelled as ours", ours?.isMagmaAccount === true);
    ok("the customer's own person is not", theirs?.isMagmaAccount === false);
    ok("and neither is hidden from the list", !!ours && !!theirs);

    const csv = await call("GET", "/api/team/members.csv", { token: adminToken });
    ok(
      "the export carries the same label, unfiltered",
      /\bmagma_account\b/.test(csv.text ?? "") &&
        (csv.text ?? "").split("\n").some((r) => r.includes(ADMIN.email) && /,yes\s*$/.test(r)),
    );
  }
}

/**
 * The most recent link that reached the recipient, by whichever route managed
 * mode is using.
 *
 * Preference matters. If a SES mock is running the message genuinely went
 * through the transport, so reading it from the inbox proves delivery rather
 * than proving a link was generated. The api log is the fallback for a managed
 * deployment with no transport wired up, where the body is logged instead.
 */
async function linkFor(kind) {
  const inbox = await mailbox();
  if (inbox.length) {
    const latest = inbox[inbox.length - 1];
    const found = String(latest.body?.text ?? "").match(
      new RegExp(`https?://\\S*?/${kind}/[A-Za-z0-9_-]+`),
    );
    if (found) return found[0];
  }
  const { stdout } = await exec("docker", [
    "logs",
    "--since",
    "2m",
    process.env.API_CONTAINER ?? "smart-router-dashboard-dev-api-1",
  ]);
  const all = stdout.match(new RegExp(`https?://[^\\s"']*/${kind}/[A-Za-z0-9_-]+`, "g")) ?? [];
  return all[all.length - 1] ?? "";
}

/** Everything the SES mock has been handed, oldest first. Empty when no mock
 *  is running, which is how `linkFor` decides which route to read. */
async function mailbox() {
  try {
    const res = await fetch(`${SES_UI}/store`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return [];
    return (await res.json()).emails ?? [];
  } catch {
    return [];
  }
}

// 3 ──────────────────────────────────────────────────────────────────────────
check("An admin invites someone and they join with exactly the role picked");
{
  const email = mode === "managed" ? "second.member@dfns.co" : MEMBER.email;
  const inv = await call("POST", "/api/team/invites", {
    token: adminToken,
    body: { email, role: "approver" },
  });
  ok("the invitation is created", inv.status === 201, `${inv.status} ${inv.text}`);
  if (mode !== "managed") {
    ok("on-prem it returns a link and sends no email", inv.body?.delivery === "link");
    ok("the link is shown once, not stored for re-reading", !!inv.body?.url);
  }
  const url = inv.body?.url ?? (await linkFor("invite"));
  const token = url.split("/").pop();

  const preview = await call("POST", "/auth/invite/preview", { body: { token } });
  ok("the link says who it is for and what it grants", preview.body?.role === "approver");

  const redeemed = await call("POST", "/auth/invite/accept", {
    body: { token, password: MEMBER.password, name: "Dana Okonkwo" },
  });
  ok("they join", redeemed.status === 201, `${redeemed.status} ${redeemed.text}`);
  ok(
    "with exactly the role that was picked",
    redeemed.body?.user?.role === "approver",
    redeemed.body?.user?.role,
  );
  globalThis.__member = redeemed.body;
  globalThis.__memberEmail = email;
  globalThis.__usedInviteToken = token;
}

// 4 ──────────────────────────────────────────────────────────────────────────
check("An invite already used is refused — and one cannot be redirected to another address");
{
  const again = await call("POST", "/auth/invite/accept", {
    body: { token: globalThis.__usedInviteToken, password: "a-different-passphrase-55" },
  });
  ok("a second redemption is refused", [400, 404, 410].includes(again.status), `${again.status}`);

  const preview = await call("POST", "/auth/invite/preview", {
    body: { token: globalThis.__usedInviteToken },
  });
  ok("and the link no longer previews", preview.status >= 400);

  // "opened by a different address": the redeemer supplies no address at all —
  // the account is created from the invitation row — so a mismatch cannot be
  // expressed. Asserted as the property that replaced the check.
  const fresh = await call("POST", "/api/team/invites", {
    token: adminToken,
    body: { email: "Mixed.Case@dfns.co", role: "read_only" },
  });
  const t = (fresh.body?.url ?? (await linkFor("invite"))).split("/").pop();
  const claimed = await call("POST", "/auth/invite/accept", {
    body: { token: t, password: "mixed-case-passphrase-31", email: "attacker@evil.co" },
  });
  ok(
    "an address submitted alongside the token is ignored",
    claimed.body?.user?.email === "mixed.case@dfns.co",
    claimed.body?.user?.email,
  );
  note("the account is built from the invitation row, so there is no address to disagree with");
  globalThis.__spare = claimed.body;
}

// 5 ──────────────────────────────────────────────────────────────────────────
check("A lower role is refused the action when it is attempted directly");
{
  const memberSignIn = (
    await call("POST", "/auth/sign-in", {
      body: { email: globalThis.__memberEmail, password: MEMBER.password },
    })
  ).body;
  const approverToken = tokenFor(memberSignIn);
  globalThis.__memberId = memberSignIn.user.id;
  globalThis.__approverToken = approverToken;

  const reads = await call("GET", "/api/team/members", { token: approverToken });
  ok("an approver may read the member list", reads.status === 200);

  const attempts = [
    [
      "invite somebody",
      await call("POST", "/api/team/invites", {
        token: approverToken,
        body: { email: "x@y.co", role: "admin" },
      }),
    ],
    [
      "change a role",
      await call("PATCH", `/api/team/members/${globalThis.__spare.user.id}`, {
        token: approverToken,
        body: { role: "admin" },
      }),
    ],
    [
      "remove a member",
      await call("DELETE", `/api/team/members/${globalThis.__spare.user.id}`, {
        token: approverToken,
      }),
    ],
    [
      "mint a reset link",
      await call("POST", `/api/team/members/${globalThis.__spare.user.id}/reset-link`, {
        token: approverToken,
      }),
    ],
  ];
  for (const [what, res] of attempts) {
    ok(`refused directly at the api: ${what}`, res.status === 403, `got ${res.status}`);
  }
  note("no UI involved — these are raw calls with a valid approver token");
}

// 6 ──────────────────────────────────────────────────────────────────────────
check("Demote someone who is signed in — their next action is refused");
{
  const token = globalThis.__approverToken;
  const promoted = await call("PATCH", `/api/team/members/${globalThis.__memberId}`, {
    token: adminToken,
    body: { role: "admin" },
  });
  ok("the admin promotes them", promoted.status === 200);

  const allowed = await call("POST", "/api/team/invites", {
    token,
    body: { email: "promoted.probe@dfns.co", role: "read_only" },
  });
  ok(
    "their EXISTING token can now invite — no new sign-in",
    allowed.status === 201,
    `${allowed.status}`,
  );
  if (allowed.status === 201) {
    await call("DELETE", `/api/team/invites/${allowed.body.invite.id}`, { token: adminToken });
  }

  const demoted = await call("PATCH", `/api/team/members/${globalThis.__memberId}`, {
    token: adminToken,
    body: { role: "read_only" },
  });
  ok("the admin demotes them", demoted.status === 200);

  const refused = await call("POST", "/api/team/invites", {
    token,
    body: { email: "after.demotion@dfns.co", role: "read_only" },
  });
  ok(
    "the same token is refused on the very next request",
    refused.status === 403,
    `got ${refused.status}`,
  );
  note("the role is read from the row per request, not from the token");
}

// 7 ──────────────────────────────────────────────────────────────────────────
check("Nobody can demote or remove themselves");
{
  const meId = adminSignIn.user.id;
  const demote = await call("PATCH", `/api/team/members/${meId}`, {
    token: adminToken,
    body: { role: "read_only" },
  });
  ok("an admin cannot change their own role", demote.status === 409, `${demote.status}`);
  note(String(demote.body?.message ?? ""));

  const remove = await call("DELETE", `/api/team/members/${meId}`, { token: adminToken });
  ok("an admin cannot remove themselves", remove.status === 409, `${remove.status}`);
  note(String(remove.body?.message ?? ""));
}

// 8 ──────────────────────────────────────────────────────────────────────────
check("Forgot password — sets a new password, does not sign in, ends other sessions");
{
  // Two live sessions for the target, so "ends their other sessions" is visible.
  const s1 = (
    await call("POST", "/auth/sign-in", {
      body: { email: globalThis.__memberEmail, password: MEMBER.password },
    })
  ).body;
  const s2 = (
    await call("POST", "/auth/sign-in", {
      body: { email: globalThis.__memberEmail, password: MEMBER.password },
    })
  ).body;
  const t1 = tokenFor(s1);
  const t2 = tokenFor(s2);
  ok(
    "they are signed in on two devices",
    (await call("GET", "/api/account/sessions", { token: t1 })).status === 200,
  );

  let resetUrl;
  if (mode === "managed") {
    const forgot = await call("POST", "/auth/password/forgot", {
      body: { email: globalThis.__memberEmail },
    });
    ok("forgot-password answers 202", forgot.status === 202);
    const unknown = await call("POST", "/auth/password/forgot", {
      body: { email: "nobody@nowhere.co" },
    });
    ok("and answers identically for an address with no account", unknown.status === 202);
    resetUrl = await linkFor("reset");
  } else {
    const link = await call("POST", `/api/team/members/${globalThis.__memberId}/reset-link`, {
      token: adminToken,
    });
    ok("on-prem an admin generates the link", link.status === 200);
    ok("the response contains no password field", !JSON.stringify(link.body).includes("password"));
    resetUrl = link.body?.url ?? "";
  }
  ok("a reset link exists", !!resetUrl, resetUrl);
  const resetToken = resetUrl.split("/").pop();
  globalThis.__usedResetToken = resetToken;

  const done = await call("POST", "/auth/password/reset", {
    body: { token: resetToken, password: RESET_PW },
  });
  ok("the holder sets the new password", done.status === 200, `${done.status} ${done.text}`);
  ok("it does NOT sign them in", !done.body?.sessionId, JSON.stringify(done.body));

  ok(
    "their first session is dead",
    (await call("GET", "/api/account/sessions", { token: t1 })).status === 401,
  );
  ok(
    "their second session is dead",
    (await call("GET", "/api/account/sessions", { token: t2 })).status === 401,
  );

  await pastCutoff();
  const signedIn = await call("POST", "/auth/sign-in", {
    body: { email: globalThis.__memberEmail, password: RESET_PW },
  });
  ok("the new password works", signedIn.status === 200, `${signedIn.status}`);
  const old = await call("POST", "/auth/sign-in", {
    body: { email: globalThis.__memberEmail, password: MEMBER.password },
  });
  ok("the old one does not", old.status === 401);
  globalThis.__memberToken = tokenFor(signedIn.body);
}

// 9 ──────────────────────────────────────────────────────────────────────────
check("An expired reset link and an already-used one give the same message");
{
  const used = await call("POST", "/auth/password/reset/preview", {
    body: { token: globalThis.__usedResetToken },
  });
  const never = await call("POST", "/auth/password/reset/preview", {
    body: { token: "a-token-that-was-never-issued" },
  });
  ok(
    "both are refused",
    used.status >= 400 && never.status >= 400,
    `${used.status} / ${never.status}`,
  );
  ok("with the same status", used.status === never.status, `${used.status} vs ${never.status}`);
  ok(
    "and the same message",
    used.body?.message === never.body?.message,
    `"${used.body?.message}" vs "${never.body?.message}"`,
  );
  note(`both say: "${used.body?.message}"`);

  const usedSubmit = await call("POST", "/auth/password/reset", {
    body: { token: globalThis.__usedResetToken, password: "yet-another-passphrase-7" },
  });
  const neverSubmit = await call("POST", "/auth/password/reset", {
    body: { token: "a-token-that-was-never-issued", password: "yet-another-passphrase-7" },
  });
  ok(
    "submitting either is refused the same way",
    usedSubmit.status === neverSubmit.status &&
      usedSubmit.body?.message === neverSubmit.body?.message,
    `${usedSubmit.status} / ${neverSubmit.status}`,
  );
}

// 10 ─────────────────────────────────────────────────────────────────────────
check("Remove a person — session ends, history stays, the email can be invited again");
{
  const token = globalThis.__memberToken;
  const alive = await call("GET", "/api/team/members", { token });
  ok("they are signed in right now", alive.status === 200, `got ${alive.status} ${alive.text}`);

  const removed = await call("DELETE", `/api/team/members/${globalThis.__memberId}`, {
    token: adminToken,
  });
  ok("the admin removes them", removed.status === 200, `${removed.status}`);

  const next = await call("GET", "/api/team/members", { token });
  ok("their very next request is refused", next.status === 401, `got ${next.status}`);

  const list = await call("GET", "/api/team/members", { token: adminToken });
  ok(
    "they are gone from the member list",
    !list.body.members.some((m) => m.email === globalThis.__memberEmail),
  );

  const rows = await sql(
    `select count(*) from audit_events where target_name = '${globalThis.__memberEmail}'`,
  );
  ok("their name survives in the audit log", Number(rows[0][0]) > 0, `${rows[0][0]} rows`);

  const reinvite = await call("POST", "/api/team/invites", {
    token: adminToken,
    body: { email: globalThis.__memberEmail, role: "requester" },
  });
  ok("their address can be invited again", reinvite.status === 201, `${reinvite.status}`);
}

// 11 ─────────────────────────────────────────────────────────────────────────
check("The log has a row for each of the above, and no secret appears as a value");
{
  // A failed sign-in, explicitly called out in the list.
  await call("POST", "/auth/sign-in", {
    body: { email: ADMIN.email, password: "definitely-wrong" },
  });

  const rows = await sql(
    "select action, count(*) from audit_events group by action order by action",
  );
  const seen = new Set(rows.map((r) => r[0]));
  const expected = [
    "setup.completed",
    "signin.succeeded",
    "signin.failed",
    "member.invited",
    "invite.redeemed",
    "invite.revoked",
    "member.role_changed",
    "member.removed",
    "password.reset_link_generated",
    "password.reset_completed",
  ];
  for (const action of expected) {
    if (action === "password.reset_link_generated" && mode === "managed") continue;
    ok(`logged: ${action}`, seen.has(action));
  }
  if (mode === "managed")
    ok("logged: password.reset_requested", seen.has("password.reset_requested"));
  note(`${rows.length} distinct actions, ${rows.reduce((n, r) => n + Number(r[1]), 0)} rows total`);

  // Every value the log holds, scanned for anything secret this run created.
  const dump = await sql(
    "select coalesce(action,'')||' '||coalesce(actor_name,'')||' '||coalesce(actor_email,'')||" +
      "' '||coalesce(target_name,'')||' '||coalesce(target_id,'')||' '||coalesce(note,'')||" +
      "' '||coalesce(client,'')||' '||coalesce(ip::text,'') from audit_events",
  );
  const changes = await sql(
    "select field||' '||from_value||' '||to_value from audit_event_changes",
  );
  const haystack = [...dump, ...changes].flat().join("\n");

  for (const secret of SECRETS) {
    ok(
      `no password or setup token in the log: ${secret.slice(0, 12)}…`,
      !haystack.includes(secret),
    );
  }
  const leakedJwt = TOKENS_SEEN.find((t) => haystack.includes(t));
  ok("no session token in the log", !leakedJwt);
  const linkish = haystack.match(/https?:\/\/[^\s]*\/(invite|reset)\/[A-Za-z0-9_-]{16,}/);
  ok("no invitation or reset link in the log", !linkish, linkish?.[0]);
}

// ── report ──────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.ok);
const passed = results.length - failed.length;
process.stdout.write(
  `\n\x1b[1m${passed}/${results.length} checks pass\x1b[0m  (DEPLOYMENT_MODE=${mode})\n`,
);
for (const r of failed) {
  process.stdout.write(`  \x1b[31mfailed\x1b[0m ${r.no}. ${r.title}\n`);
  for (const a of r.asserts.filter((a) => !a.pass)) process.stdout.write(`         ${a.label}\n`);
}
process.stdout.write("\n");
process.exit(failed.length ? 1 : 0);
