import "server-only";
import { INTERNAL_API_BASE_URL } from "@/lib/internal-api";
import { forwardedForThisRequest } from "@/lib/forwarded-client";
import { parseTwoFactor, type EnrolmentVerdict } from "@/lib/enrolment-gate";

/** Long enough for a healthy api, short enough that a hung one costs the page
 *  load little: on a timeout the gate waits for the browser's own read. */
const VERDICT_TIMEOUT_MS = 2000;

/**
 * Whether the signed-in person must enrol before they see the dashboard, asked
 * while the page is rendered on the server.
 *
 * The browser asks the same question, but only after Auth.js has handed it a
 * token and its own `/api/account/me` call has come back — too late to decide
 * the first paint, which would then be the dashboard, replaced a moment later
 * by the enrolment screen. Asked here, the answer is in the first HTML.
 *
 * `/api/account/me` is one of the three routes the api leaves open to an
 * unenrolled session, and it reads the live account row, so this is the api's
 * decision rather than a second copy of it. The web never decides on its own:
 * any failure is `unknown` — a 429 included, which it does not wait out — and
 * the gate then waits for the browser's read.
 */
export async function readEnrolmentVerdict(): Promise<EnrolmentVerdict> {
  if (process.env.AUTH_MODE !== "enabled") return { state: "none" };
  try {
    // Loaded here, not at the top: without accounts there is no Auth.js to
    // load, and the layouts that call this render in both modes.
    const { auth } = await import("@/auth");
    const token = (await auth())?.accessToken;
    if (!token) return { state: "unknown" };
    const res = await fetch(`${INTERNAL_API_BASE_URL}/api/account/me`, {
      // Vouched for, so the api counts this read against the reader's own
      // session. Sent bare it would come from this container, and every page
      // load by everybody would spend one shared per-address allowance.
      headers: { Authorization: `Bearer ${token}`, ...(await forwardedForThisRequest()) },
      cache: "no-store",
      signal: AbortSignal.timeout(VERDICT_TIMEOUT_MS),
    });
    if (!res.ok) return { state: "unknown" };
    const body = (await res.json()) as { twoFactor?: unknown } | null;
    const twoFactor = parseTwoFactor(body?.twoFactor);
    return twoFactor ? { state: "known", twoFactor } : { state: "unknown" };
  } catch {
    return { state: "unknown" };
  }
}
