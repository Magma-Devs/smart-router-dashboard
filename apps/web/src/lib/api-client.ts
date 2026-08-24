/**
 * Browser-facing API client. The base URL resolves ONCE per session from the
 * runtime-config route (/api/config — reads the container env at request
 * time), falling back to the build-time NEXT_PUBLIC_API_URL. This is what
 * lets a single published web image point at any api host.
 */
const BUILD_BASE =
  process.env.NEXT_PUBLIC_API_URL ??
  (typeof window !== "undefined" ? "" : "http://localhost:8000");

const BUILD_SPI_URL = process.env.NEXT_PUBLIC_SPI_URL ?? "https://providers-status.magmadevs.com";

export interface RuntimeConfig {
  base: string;
  authMode: "disabled" | "enabled";
  /** Status Page Index the vendor chips link out to (DASHBOARD_SPI_URL). */
  spiUrl: string;
}

let configPromise: Promise<RuntimeConfig> | null = null;

/**
 * The runtime config, fetched ONCE per session and shared by every caller —
 * the promise is the memo. Anything that needs a runtime value takes it from
 * here rather than fetching `/api/config` itself: a per-component fetch turns
 * one request into one per rendered component (a dozen upstream cards each
 * asking for the same three strings).
 */
export function resolveConfig(): Promise<RuntimeConfig> {
  if (typeof window === "undefined") {
    return Promise.resolve({ base: BUILD_BASE, authMode: "disabled", spiUrl: BUILD_SPI_URL });
  }
  if (!configPromise) {
    type ConfigBody = { apiUrl?: string; authMode?: string; spiUrl?: string };
    configPromise = fetch("/api/config")
      .then((r) => (r.ok ? (r.json() as Promise<ConfigBody>) : ({} as ConfigBody)))
      .then((c) => ({
        base: c.apiUrl ?? BUILD_BASE,
        authMode: (c.authMode === "enabled" ? "enabled" : "disabled") as RuntimeConfig["authMode"],
        spiUrl: c.spiUrl ?? BUILD_SPI_URL,
      }))
      .catch(() => ({ base: BUILD_BASE, authMode: "disabled" as const, spiUrl: BUILD_SPI_URL }));
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
