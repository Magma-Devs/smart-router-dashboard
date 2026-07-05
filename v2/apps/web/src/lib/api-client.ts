/**
 * Browser-facing API client. The base URL resolves ONCE per session from the
 * runtime-config route (/api/config — reads the container env at request
 * time), falling back to the build-time NEXT_PUBLIC_API_URL. This is what
 * lets a single published web image point at any api host.
 */
const BUILD_BASE =
  process.env.NEXT_PUBLIC_API_URL ??
  (typeof window !== "undefined" ? "" : "http://localhost:8000");

let basePromise: Promise<string> | null = null;

function resolveBase(): Promise<string> {
  if (typeof window === "undefined") return Promise.resolve(BUILD_BASE);
  if (!basePromise) {
    basePromise = fetch("/api/config")
      .then((r) => (r.ok ? (r.json() as Promise<{ apiUrl?: string }>) : {}))
      .then((c) => c.apiUrl ?? BUILD_BASE)
      .catch(() => BUILD_BASE);
  }
  return basePromise;
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
  const base = await resolveBase();
  const res = await fetch(`${base}${path}`);
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
  const base = await resolveBase();
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
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
