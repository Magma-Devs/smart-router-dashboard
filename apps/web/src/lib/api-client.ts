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
  const { base, headers } = await requestContext();
  const res = await fetch(`${base}${path}`, { headers });
  if (!res.ok) {
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
