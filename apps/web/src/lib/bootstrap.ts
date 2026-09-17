import "server-only";
import { INTERNAL_API_BASE_URL } from "@/lib/internal-api";

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
    const res = await fetch(`${INTERNAL_API_BASE_URL}/auth/bootstrap`, {
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
