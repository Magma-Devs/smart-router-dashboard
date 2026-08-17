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
async function requestContext(): Promise<{ base: string; headers: Record<string, string> }> {
  const cfg = await resolveConfig();
  const headers: Record<string, string> = {};
  if (cfg.authMode === "enabled") {
    const { authReady, getAuthToken } = await import("./auth-store");
    await authReady();
    const token = getAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return { base: cfg.base, headers };
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

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const { base, headers } = await requestContext();
  const res = await fetch(`${base}${path}`, { headers });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      /* keep default */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const { base, headers } = await requestContext();
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
  const { base, headers } = await requestContext();
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
    throw new ApiError(res.status, message);
  }
  // 204 and friends have no body; callers of those ignore the result.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Download a file the api generates (the member CSV). Goes through the same
 *  auth context, then hands the browser a blob — an `<a href>` to the api
 *  would carry no Authorization header. */
export async function apiDownload(path: string, filename: string): Promise<void> {
  const { base, headers } = await requestContext();
  const res = await fetch(`${base}${path}`, { headers });
  if (!res.ok) throw new ApiError(res.status, `Export failed (${res.status})`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
