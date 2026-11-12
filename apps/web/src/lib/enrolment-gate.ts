import type { MeTwoFactor } from "@/hooks/use-me";

/**
 * What the web server learned about the enrolment requirement while it
 * rendered the page, before any of it reached the browser.
 *
 *  - `none` — nothing was asked: the deployment has no accounts, or the screen
 *    sits under no layout that asks.
 *  - `unknown` — the deployment has accounts and the question went unanswered:
 *    no session token, the api down, slow or refusing.
 *  - `known` — the api's own answer, from the live account row.
 */
export type EnrolmentVerdict =
  | { state: "none" }
  | { state: "unknown" }
  | { state: "known"; twoFactor: MeTwoFactor };

/** What the gate draws: the enrolment screen, the app, or nothing yet. */
export type GateView = "enrol" | "app" | "wait";

/**
 * The gate's decision, kept pure so every combination can be tested.
 *
 * The browser's own read wins once it lands — it is the newer answer, and it is
 * the one `refresh()` updates when enrolment completes. Until then the server's
 * answer stands in, so a person who must enrol meets the enrolment screen in the
 * first paint rather than after the dashboard has been drawn and taken away.
 *
 * With no answer from either, the gate waits rather than guess, but only while
 * the browser's read can still come back. Once it has failed too, the app
 * renders: the api refuses an unenrolled session on every route but the
 * enrolment pair, so the dashboard shows its errors and nothing else.
 *
 * @param live     the browser's read of `/api/account/me`, null until it lands
 * @param verdict  the server's read, from the layout
 * @param settled  the browser's read has answered or failed, or cannot be made
 */
export function gateView(
  live: MeTwoFactor | null,
  verdict: EnrolmentVerdict,
  settled: boolean,
): { view: GateView; twoFactor: MeTwoFactor | null } {
  const twoFactor = live ?? (verdict.state === "known" ? verdict.twoFactor : null);
  if (twoFactor?.enrolmentRequired) return { view: "enrol", twoFactor };
  if (twoFactor) return { view: "app", twoFactor };
  if (verdict.state === "unknown" && !settled) return { view: "wait", twoFactor: null };
  return { view: "app", twoFactor: null };
}

/**
 * The `twoFactor` block of an `/api/account/me` answer, or null when it is not
 * one. A body the gate cannot read is no answer, never a "not required".
 */
export function parseTwoFactor(raw: unknown): MeTwoFactor | null {
  if (!raw || typeof raw !== "object") return null;
  const tf = raw as Record<string, unknown>;
  if (typeof tf.enrolled !== "boolean" || typeof tf.enrolmentRequired !== "boolean") return null;
  return {
    enrolled: tf.enrolled,
    enrolmentRequired: tf.enrolmentRequired,
    graceEndsAt: typeof tf.graceEndsAt === "string" ? tf.graceEndsAt : null,
    daysLeft: typeof tf.daysLeft === "number" ? tf.daysLeft : null,
  };
}
