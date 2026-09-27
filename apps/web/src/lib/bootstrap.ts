import "server-only";
import { isRole, type Role } from "@sr/shared";
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

export interface InvitePreview {
  email: string;
  role: Role;
  expiresAt: string;
}

/**
 * What an invitation link is for, resolved server-side so the token never
 * reaches the client bundle as a fetch the browser has to make before the page
 * can render.
 *
 * Null covers every dead-link reason — used, revoked, expired, never issued.
 * They are deliberately not distinguished: the holder can't act on the
 * difference, and telling them apart would say which of them a guessed token
 * hit.
 */
export async function previewInvitation(token: string): Promise<InvitePreview | null> {
  try {
    const res = await fetch(`${INTERNAL_API_BASE_URL}/auth/invite/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<InvitePreview>;
    if (typeof body.email !== "string" || !isRole(body.role)) return null;
    return { email: body.email, role: body.role, expiresAt: body.expiresAt ?? "" };
  } catch {
    return null;
  }
}

/**
 * What a reset link is, as far as the page can tell without spending it.
 *
 *  - `live` — the api named the account it changes.
 *  - `dead` — used, expired or never issued; one answer for all of them.
 *  - `unknown` — the question went unanswered: rate-limited, the api down, a
 *    timeout. **Not the same as dead.** The preview is a server-side fetch, so
 *    its per-IP limit is shared by everyone this web pod serves; reporting that
 *    as "expired" would let anybody who loads `/reset/x` a few times a minute
 *    make every live link look dead. The page shows the form instead, and the
 *    submit — which goes from the browser — gets the real answer.
 */
export type ResetPreview =
  | { state: "live"; email: string }
  | { state: "dead" }
  | { state: "unknown" };

/**
 * Which account a reset link changes, without spending it.
 *
 * This page used to refuse to preview at all, on the argument that revealing
 * whose account a token belongs to turns a guessed token into a way to ask who
 * has an account. That argument does not hold: the token is 32 random bytes, so
 * anybody who can present a valid one can already set the password and read the
 * address from the inside. It gives away nothing the holder cannot take. And
 * MAG-2870 asks for the address on screen for a good reason — somebody with two
 * accounts needs to know which one they are changing.
 */
export async function previewReset(token: string): Promise<ResetPreview> {
  try {
    const res = await fetch(`${INTERNAL_API_BASE_URL}/auth/password/reset/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      cache: "no-store",
      signal: AbortSignal.timeout(3000),
    });
    // 410 is the api's one answer for every dead reason. Anything else that is
    // not a 200 says nothing about the link.
    if (res.status === 410) return { state: "dead" };
    if (!res.ok) return { state: "unknown" };
    const body = (await res.json()) as { email?: unknown };
    return typeof body.email === "string"
      ? { state: "live", email: body.email }
      : { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}
