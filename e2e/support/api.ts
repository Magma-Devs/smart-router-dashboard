import { createHmac } from "node:crypto";
import { API_URL, AUTH_SECRET, OPERATOR, SETUP_TOKEN } from "./env.js";
import { Authenticator } from "./totp.js";

/**
 * Talking to the api directly, for everything a spec needs to be *true* rather
 * than to *watch happen*.
 *
 * Seeding through the browser would mean redeeming an invitation and enrolling
 * an authenticator on screen before every test that needs an enrolled account —
 * four more page loads and, more to the point, four more `/auth/*` calls from
 * one address against a limiter that allows ten a minute. The browser is
 * reserved for the surface under test; the state it starts from is set up here.
 */

/**
 * A distinct client address per call.
 *
 * `/auth/*` is limited to ten requests a minute **per IP**, and the api derives
 * that address from `X-Forwarded-For` — `TRUST_PROXY` defaults to trusting one
 * hop, which is the deployment shape behind our ingress. Seeding the whole
 * suite from one address exhausts the bucket and the failures look like the
 * product refusing valid credentials.
 *
 * The range is 198.51.100.0/24 (TEST-NET-2, reserved for documentation), so
 * nothing here can be confused for a real client in a log.
 */
let ipCounter = 0;
export function nextClientIp(): string {
  ipCounter = (ipCounter % 250) + 1;
  return `198.51.100.${ipCounter}`;
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T | null;
  text: string;
}

export async function apiCall<T = unknown>(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; ip?: string } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? nextClientIp() };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(API_URL + path, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: T | null = null;
  try {
    body = JSON.parse(text) as T;
  } catch {
    /* not json — `text` carries it */
  }
  return { status: res.status, body, text };
}

function expectOk<T>(res: ApiResponse<T>, what: string): T {
  if (res.status >= 300 || res.body === null) {
    throw new Error(`${what}: HTTP ${res.status} ${res.text}`);
  }
  return res.body;
}

// ── sessions ────────────────────────────────────────────────────────────────

const SESSION_JWT_ISSUER = "smart-router-dashboard-web";
const SESSION_JWT_AUDIENCE = "smart-router-dashboard-api";
const b64url = (s: string) => Buffer.from(s).toString("base64url");

/**
 * The Bearer the api accepts, signed here rather than obtained from the web.
 *
 * The web mints this same token in `auth.config.ts`'s `jwt.encode`, from the
 * same secret and the same claims — this is not a bypass, it is the other half
 * of a contract the api enforces on every request. Note `sid`: the api refuses
 * any token whose session id resolves to nothing, so it has to be a real one
 * from a real sign-in. There is no shortcut past that, by design.
 */
export function bearerFor(userId: string, email: string, sessionId: string, role = "admin") {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      sub: userId,
      email,
      role,
      sid: sessionId,
      iss: SESSION_JWT_ISSUER,
      aud: SESSION_JWT_AUDIENCE,
      iat: now,
      exp: now + 3600,
    }),
  );
  const sig = createHmac("sha256", AUTH_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

interface SignInBody {
  user?: { id: string; email: string; role: string };
  sessionId?: string;
  twoFactorRequired?: boolean;
  challenge?: string;
}

/** Both factors, ending in a Bearer. `authenticator` is omitted for an account
 *  that has none — then the password alone opens the session. */
export async function signInApi(
  email: string,
  password: string,
  authenticator?: Authenticator,
): Promise<{ token: string; userId: string; sessionId: string }> {
  const ip = nextClientIp();
  const first = expectOk(
    await apiCall<SignInBody>("POST", "/auth/sign-in", { body: { email, password }, ip }),
    `sign-in ${email}`,
  );

  let done = first;
  if (first.twoFactorRequired) {
    if (!authenticator) throw new Error(`${email} wants a code and no authenticator was given`);
    done = expectOk(
      await apiCall<SignInBody>("POST", "/auth/2fa/verify", {
        body: { challenge: first.challenge, code: await authenticator.next() },
        ip: nextClientIp(),
      }),
      `2fa verify ${email}`,
    );
  }

  if (!done.sessionId || !done.user) throw new Error(`sign-in ${email}: no session opened`);
  return {
    token: bearerFor(done.user.id, done.user.email, done.sessionId, done.user.role),
    userId: done.user.id,
    sessionId: done.sessionId,
  };
}

// ── accounts ────────────────────────────────────────────────────────────────

export async function needsSetup(): Promise<boolean> {
  const res = await apiCall<{ needsSetup: boolean }>("GET", "/auth/bootstrap");
  return res.body?.needsSetup === true;
}

/** The installer's first account. Only possible while the deployment has none. */
export async function createFirstAdmin(): Promise<void> {
  expectOk(
    await apiCall("POST", "/auth/setup", {
      body: {
        token: SETUP_TOKEN,
        email: OPERATOR.email,
        password: OPERATOR.password,
        name: OPERATOR.name,
      },
    }),
    "first-run setup",
  );
}

/** Scan the QR, type the code back: an account with a working authenticator. */
export async function enrolAuthenticator(token: string): Promise<Authenticator> {
  const begun = expectOk(
    await apiCall<{ secret: string; qrSvg: string }>("POST", "/api/account/2fa/begin", {
      token,
      body: {},
    }),
    "2fa begin",
  );
  const authenticator = new Authenticator(begun.secret);
  expectOk(
    await apiCall("POST", "/api/account/2fa/confirm", {
      token,
      body: { code: await authenticator.next() },
    }),
    "2fa confirm",
  );
  return authenticator;
}

export interface SeededMember {
  email: string;
  password: string;
  name: string;
  userId: string;
  /** Present only when the member enrolled. */
  authenticator?: Authenticator;
}

/**
 * A member of the team, created the way members are actually created: an admin
 * invites an address, the invitation is redeemed with a password of the
 * recipient's choosing.
 *
 * On-prem hands the link back in the response because there is no mail server —
 * which is what makes this reachable without reading a mailbox.
 */
export async function inviteMember(
  adminToken: string,
  member: { email: string; password: string; name: string; role?: string },
): Promise<SeededMember> {
  const created = expectOk(
    await apiCall<{ url?: string }>("POST", "/api/team/invites", {
      token: adminToken,
      body: { email: member.email, role: member.role ?? "requester" },
    }),
    `invite ${member.email}`,
  );
  const rawToken = created.url?.split("/invite/")[1];
  if (!rawToken) throw new Error(`invite ${member.email}: on-prem returned no link`);

  const redeemed = expectOk(
    await apiCall<{ user: { id: string } }>("POST", "/auth/invite/accept", {
      body: { token: rawToken, password: member.password, name: member.name },
    }),
    `redeem ${member.email}`,
  );

  return {
    email: member.email,
    password: member.password,
    name: member.name,
    userId: redeemed.user.id,
  };
}
