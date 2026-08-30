/**
 * Browser-facing API client. The base URL resolves ONCE per session from the
 * runtime-config route (/api/config — reads the container env at request
 * time), falling back to the build-time NEXT_PUBLIC_API_URL. This is what
 * lets a single published web image point at any api host.
 */
const BUILD_BASE =
  process.env.NEXT_PUBLIC_API_URL ?? (typeof window !== "undefined" ? "" : "http://localhost:8000");

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

/**
 * The deployment's auth mode.
 *
 * For surfaces that only exist when it is on — the audit log is Postgres-backed
 * and its routes are not registered at all in `disabled` mode. Asking here beats
 * inferring from a 404: a 404 could equally be a broken deploy, and telling
 * someone to set an environment variable when the real fault is routing sends
 * them somewhere useless. Shares the memoised config fetch, so this costs
 * nothing after the first call.
 */
export async function getAuthMode(): Promise<RuntimeConfig["authMode"]> {
  return (await resolveConfig()).authMode;
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
 * So the first 401 on a request we actually authenticated ends the session
 * here too, and goes to /login.
 *
 * Three things it deliberately does not fire on:
 *
 *  - **403.** Wrong role, not a dead session. The person is signed in and
 *    stays signed in; a demoted admin must not be thrown out of the app.
 *  - **503.** The auth database is unreachable. Signing everybody out during a
 *    database blip would turn a short outage into a support queue.
 *  - **A request that carried no token.** In AUTH_MODE=enabled a page can load
 *    before the session bridge has run, and the public pages (login, invite
 *    redemption, reset) legitimately call the api with nobody signed in. A 401
 *    there means "not signed in yet", which is not something to react to.
 */
let endingSession = false;

/**
 * Exported so the rule can be tested without a browser. The three exclusions
 * above are the whole of it, and each one is a way of being wrong that would
 * be worse than the problem being solved.
 */
export function shouldEndSession(status: number, authenticated: boolean): boolean {
  return status === 401 && authenticated;
}

function noteAuthFailure(status: number, authenticated: boolean): void {
  if (!shouldEndSession(status, authenticated)) return;
  if (endingSession) return; // concurrent panels all 401 at once; act once
  endingSession = true;
  void import("next-auth/react").then(({ signOut }) => signOut({ redirectTo: "/login" }));
}

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const { base, headers, authenticated } = await requestContext();
  const res = await fetch(`${base}${path}`, { headers });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      /* keep default */
    }
    noteAuthFailure(res.status, authenticated);
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

/**
 * Fetch a file and hand it to the browser as a download.
 *
 * Not an `<a href>`: the API is a separate origin behind a Bearer token, and a
 * plain link sends no Authorization header — it would 401, or worse, quietly
 * download the error page as a .csv. So the token goes on a fetch and the body
 * becomes an object URL.
 *
 * The server names the file (`Content-Disposition`); `fallbackName` is only
 * used when it doesn't.
 */
export async function apiDownload(path: string, fallbackName: string): Promise<void> {
  const { base, headers, authenticated } = await requestContext();
  const res = await fetch(`${base}${path}`, { headers });
  if (!res.ok) {
    // A download is as good a place as any to discover the session died — and
    // without this, the browser silently saves the 401 body as a .csv.
    noteAuthFailure(res.status, authenticated);
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = body.message;
    } catch {
      /* keep the status-code message */
    }
    throw new ApiError(res.status, message);
  }

  const disposition = res.headers.get("content-disposition") ?? "";
  const named = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
  const url = URL.createObjectURL(await res.blob());
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = named ?? fallbackName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoking immediately can race the click in some browsers; a tick is
    // enough and leaking the blob for the life of the tab is not acceptable.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const { base, headers, authenticated } = await requestContext();
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const json = (await res.json()) as { message?: string };
      if (json.message) message = json.message;
    } catch {
      /* keep default */
    }
    noteAuthFailure(res.status, authenticated);
    throw new ApiError(res.status, message);
  }
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
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const json = (await res.json()) as { message?: string };
      if (json.message) message = json.message;
    } catch {
      /* keep default */
    }
    noteAuthFailure(res.status, authenticated);
    throw new ApiError(res.status, message);
  }
  // 204 and friends have no body; callers of those ignore the result.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
