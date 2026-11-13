import type { MeTwoFactor } from "@/hooks/use-me";
import { isRateLimited } from "@/lib/retry";

/**
 * What the web server learned about the enrolment requirement while it
 * rendered the page, before any of it reached the browser.
 *
 *  - `none` — nothing was asked: the deployment has no accounts, or the screen
 *    sits under no layout that asks.
 *  - `unknown` — the deployment has accounts and the question went unanswered:
 *    no session token, the api down, slow, refusing or rate-limiting.
 *  - `known` — the api's own answer, from the live account row.
 */
export type EnrolmentVerdict =
  | { state: "none" }
  | { state: "unknown" }
  | { state: "known"; twoFactor: MeTwoFactor };

/** What the gate draws: the enrolment screen, the app, or a loading state. */
export type GateView = "enrol" | "app" | "wait";

/**
 * Where the browser's own read of `/api/account/me` stands.
 *
 *  - `pending` — not answered yet, or not yet asked: the session bridge has
 *    not run.
 *  - `retrying` — the api turned it away for now (429) and it asks again when
 *    the api said to. Still no answer, and one is coming.
 *  - `settled` — answered, or failed some other way, or there is nobody signed
 *    in to read for. A missing answer from here on is final until the next poll.
 */
export type LiveRead = "pending" | "retrying" | "settled";

/**
 * The browser read's state, from what `useMe` has. A 429 is not a settled
 * failure: the api is limiting requests, not refusing this person, and the read
 * asks again once the api's `Retry-After` has passed (`useApi`).
 */
export function liveReadOf(read: {
  /** The session bridge has run, so whether there is anybody to read for is known. */
  authReady: boolean;
  /** Somebody is signed in, so there is a read to make. */
  signedIn: boolean;
  /** The read has answered at least once. */
  answered: boolean;
  /** Its latest failure, if the latest attempt failed. */
  error: unknown;
}): LiveRead {
  if (!read.authReady) return "pending";
  if (!read.signedIn || read.answered) return "settled";
  if (read.error === undefined || read.error === null) return "pending";
  return isRateLimited(read.error) ? "retrying" : "settled";
}

/**
 * The gate's decision, kept pure so every combination can be tested.
 *
 * The browser's own read wins once it lands — it is the newer answer, and it is
 * the one `refresh()` updates when enrolment completes. Until then the server's
 * answer stands in, so a person who must enrol meets the enrolment screen in the
 * first paint rather than after the dashboard has been drawn and taken away.
 *
 * With no answer from either, the gate shows a loading state rather than guess,
 * for as long as the browser's read can still come back — including while it
 * waits out a 429. Once it has failed some other way, the app renders: the api
 * refuses an unenrolled session on every route but the enrolment pair, so the
 * dashboard shows its errors and nothing else.
 *
 * @param live     the browser's read of `/api/account/me`, null until it lands
 * @param verdict  the server's read, from the layout
 * @param read     where the browser's read stands
 */
export function gateView(
  live: MeTwoFactor | null,
  verdict: EnrolmentVerdict,
  read: LiveRead,
): { view: GateView; twoFactor: MeTwoFactor | null } {
  const twoFactor = live ?? (verdict.state === "known" ? verdict.twoFactor : null);
  if (twoFactor?.enrolmentRequired) return { view: "enrol", twoFactor };
  if (twoFactor) return { view: "app", twoFactor };
  if (verdict.state === "unknown" && read !== "settled") return { view: "wait", twoFactor: null };
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
