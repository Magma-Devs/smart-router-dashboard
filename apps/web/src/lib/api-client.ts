/**
 * Browser-facing API client. The base URL resolves ONCE per session from the
 * runtime-config route (/api/config — reads the container env at request
 * time), falling back to the build-time NEXT_PUBLIC_API_URL. This is what
 * lets a single published web image point at any api host.
 */
const BUILD_BASE =
  process.env.NEXT_PUBLIC_API_URL ??
  (typeof window !== "undefined" ? "" : "http://localhost:8000");

interface RuntimeConfig {
  base: string;
  authMode: "disabled" | "enabled";
}

let configPromise: Promise<RuntimeConfig> | null = null;

function resolveConfig(): Promise<RuntimeConfig> {
  if (typeof window === "undefined") {
    return Promise.resolve({ base: BUILD_BASE, authMode: "disabled" });
  }
  if (!configPromise) {
    configPromise = fetch("/api/config")
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{ apiUrl?: string; authMode?: string }>)
          : ({} as { apiUrl?: string; authMode?: string }),
      )
      .then((c) => ({
        base: c.apiUrl ?? BUILD_BASE,
        authMode: (c.authMode === "enabled" ? "enabled" : "disabled") as RuntimeConfig["authMode"],
      }))
      .catch(() => ({ base: BUILD_BASE, authMode: "disabled" as const }));
  }
  return configPromise;
}

/** Resolve base + (in AUTH_MODE=enabled) wait for the session bridge so
 *  the first page-load fetches don't race the token and 401. */
async function requestContext(): Promise<{
  base: string;
  headers: Record<string, string>;
  authenticated: boolean;
}> {
  const cfg = await resolveConfig();
  const headers: Record<string, string> = {};
  if (cfg.authMode === "enabled") {
    const { authReady, getAuthToken } = await import("./auth-store");
    await authReady();
    const token = getAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return { base: cfg.base, headers, authenticated: !!headers.Authorization };
}

/**
 * The api's base URL, resolved the same way every other call resolves it.
 *
 * For the handful of unauthenticated flows that talk to the api directly and
 * must not wait for the session bridge — first-run setup, and later invite
 * redemption and password reset. There is no session to attach yet, and
 * `requestContext()` would block on one that is never coming.
 */
export async function apiUrl(): Promise<string> {
  return (await resolveConfig()).base;
}

/**
 * A session that has ended somewhere else.
 *
 * Revoking a session is a server-side act — it cannot reach into the browser
 * holding it. So a device that has been signed out from the sessions list, or
 * by a password reset, or by being removed from the team, keeps its rendered
 * page and looks signed in until it next speaks to the api. That is precisely
 * the device somebody clicked "sign out" *about*, and leaving it looking
 * usable is the wrong answer on a screen whose purpose is cutting off access
 * you did not authorise.
 *
 * So when the api's session gate says the session is over, the browser signs
 * out too and goes to /login. The gate says so with a machine-readable `code`
 * (AUTH_ERROR_CODES in the api's plugins/auth.ts), and only these end it:
 *
 *  - **401 SESSION_INVALID** — revoked, expired, or cut off by "sign out
 *    everywhere".
 *  - **401 AUTH_REQUIRED on a request that carried a token** — the token itself
 *    was refused (expired, or signed with a rotated secret).
 *  - **403 ACCOUNT_INACTIVE** — the account was removed or suspended.
 *
 * Everything else is left alone, and each exclusion is a way of being wrong
 * that would be worse than the staleness:
 *
 *  - **A route's own 401.** "That current password is not correct" is a 401 with
 *    no code; signing someone out for a typo would be absurd.
 *  - **403 FORBIDDEN.** Wrong role, not a dead session — a demoted admin stays
 *    signed in, and the api already refuses the action.
 *  - **503.** The auth database is unreachable. Signing everybody out during a
 *    database blip would turn a short outage into a support queue.
 *  - **A request that carried no token.** A page can load before the session
 *    bridge has run, and the public pages (login, invite redemption, reset) call
 *    the api with nobody signed in. Reacting there would bounce /login to /login.
 */
const SESSION_OVER = new Set(["401 SESSION_INVALID", "401 AUTH_REQUIRED", "403 ACCOUNT_INACTIVE"]);

let endingSession = false;

/** Exported so the rule can be tested without a browser. */
export function shouldEndSession(
  status: number,
  code: string | undefined,
  authenticated: boolean,
): boolean {
  return authenticated && SESSION_OVER.has(`${status} ${code ?? ""}`);
}

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    /** The api's machine-readable reason, when it gave one. */
    public code?: string,
  ) {
    super(message);
  }
}

/** Every failed call ends here: read the api's message and code, end the
 *  session if the gate says it is over, and hand back the error to throw. */
async function failure(
  res: Response,
  authenticated: boolean,
  fallback = `Request failed (${res.status})`,
): Promise<ApiError> {
  let message = fallback;
  let code: string | undefined;
  try {
    const json = (await res.json()) as { message?: string; code?: string };
    if (json.message) message = json.message;
    code = json.code;
  } catch {
    /* keep the fallback */
  }
  if (shouldEndSession(res.status, code, authenticated) && !endingSession) {
    endingSession = true; // concurrent panels all fail at once; act once
    void import("next-auth/react").then(({ signOut }) => signOut({ redirectTo: "/login" }));
  }
  return new ApiError(res.status, message, code);
}

export async function apiGet<T>(path: string): Promise<T> {
  const { base, headers, authenticated } = await requestContext();
  const res = await fetch(`${base}${path}`, { headers });
  if (!res.ok) throw await failure(res, authenticated);
  return (await res.json()) as T;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const { base, headers, authenticated } = await requestContext();
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res, authenticated);
  return (await res.json()) as T;
}

/**
 * PATCH / DELETE, sharing the error handling above. Split from `apiPost`
 * rather than generalising it, because the two callers that need a method
 * shouldn't force every existing call site to pass one.
 */
export async function apiSend<T>(
  method: "PATCH" | "DELETE" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const { base, headers, authenticated } = await requestContext();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await failure(res, authenticated);
  // 204 and friends have no body; callers of those ignore the result.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Download a file the api generates (the member CSV). Goes through the same
 *  auth context, then hands the browser a blob — an `<a href>` to the api
 *  would carry no Authorization header. */
export async function apiDownload(path: string, filename: string): Promise<void> {
  const { base, headers, authenticated } = await requestContext();
  const res = await fetch(`${base}${path}`, { headers });
  if (!res.ok) throw await failure(res, authenticated, `Export failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  // Attached for the click, and the URL revoked well after it: some browsers
  // ignore a click on a detached anchor, and some cancel a download whose URL
  // is revoked before they have read it.
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
