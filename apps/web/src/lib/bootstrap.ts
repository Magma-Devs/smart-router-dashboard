import "server-only";

/**
 * First-run state, read server-side.
 *
 * Deliberately **not** in the edge proxy: the proxy runs on every request and
 * cannot reach Postgres, so asking it to answer this would mean a fetch per
 * navigation. The two pages that actually care — `/login` and `/setup` — ask
 * once, when they render.
 */
export interface BootstrapState {
  needsSetup: boolean;
  mode: "managed" | "onprem";
}

const INTERNAL_BASE =
  process.env.INTERNAL_API_BASE_URL ??
  process.env.DASHBOARD_API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:8000";

/**
 * Returns null when the api can't be reached or hasn't got a database yet.
 *
 * Callers treat null as "carry on as normal" rather than "needs setup":
 * bouncing everyone to a setup page because the api was briefly unreachable
 * would be a self-inflicted outage, and worse, would show the setup form on a
 * deployment that already has accounts.
 */
export async function fetchBootstrap(): Promise<BootstrapState | null> {
  try {
    const res = await fetch(`${INTERNAL_BASE}/auth/bootstrap`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<BootstrapState>;
    if (typeof body.needsSetup !== "boolean") return null;
    return { needsSetup: body.needsSetup, mode: body.mode === "managed" ? "managed" : "onprem" };
  } catch {
    return null;
  }
}
