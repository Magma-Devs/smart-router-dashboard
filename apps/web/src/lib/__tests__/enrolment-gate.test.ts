import { describe, expect, it } from "vitest";
import { gateView, liveReadOf, parseTwoFactor, type EnrolmentVerdict } from "../enrolment-gate";
import { ApiError } from "../api-client";
import type { MeTwoFactor } from "@/hooks/use-me";

/**
 * The two-factor gate's decision: the enrolment screen, the dashboard, or a
 * loading state while it cannot tell.
 *
 * What this guards: a member who must enrol never sees the dashboard, not even
 * for the moment the browser's own read takes — the server's answer decides
 * the first render. And the gate never weakens: a "required" from either side
 * shuts the dashboard.
 */

const required: MeTwoFactor = { enrolled: false, enrolmentRequired: true, graceEndsAt: null, daysLeft: null };
const lapsed: MeTwoFactor = {
  enrolled: false,
  enrolmentRequired: true,
  graceEndsAt: "2026-10-01T00:00:00.000Z",
  daysLeft: 0,
};
const enrolled: MeTwoFactor = { enrolled: true, enrolmentRequired: false, graceEndsAt: null, daysLeft: null };
const inGrace: MeTwoFactor = {
  enrolled: false,
  enrolmentRequired: false,
  graceEndsAt: "2026-12-01T00:00:00.000Z",
  daysLeft: 19,
};

const none: EnrolmentVerdict = { state: "none" };
const unknown: EnrolmentVerdict = { state: "unknown" };
const known = (twoFactor: MeTwoFactor): EnrolmentVerdict => ({ state: "known", twoFactor });

describe("gateView — before the browser's read lands", () => {
  it("shows the enrolment screen on the first render when the server says so", () => {
    expect(gateView(null, known(required), "pending")).toEqual({ view: "enrol", twoFactor: required });
  });

  it("carries the server's grace-period end, so the screen's words are right from the start", () => {
    expect(gateView(null, known(lapsed), "pending").twoFactor?.graceEndsAt).toBe(lapsed.graceEndsAt);
  });

  it.each([
    ["enrolled", enrolled],
    ["in the grace period", inGrace],
  ])("renders the dashboard for an account %s", (_, twoFactor) => {
    expect(gateView(null, known(twoFactor), "pending").view).toBe("app");
  });

  it("shows the loading state while neither side has answered", () => {
    expect(gateView(null, unknown, "pending")).toEqual({ view: "wait", twoFactor: null });
  });

  it("renders the dashboard where accounts are off — nothing would ever end a wait there", () => {
    expect(gateView(null, none, "pending").view).toBe("app");
    expect(gateView(null, none, "settled").view).toBe("app");
  });
});

describe("gateView — once the browser's read has landed", () => {
  it("lets the browser's newer answer lift the block, as enrolling in place does", () => {
    expect(gateView(enrolled, known(required), "settled").view).toBe("app");
  });

  it("lets the browser's newer answer shut a dashboard the server had opened", () => {
    // An admin reset this person's two-factor after the page was rendered.
    expect(gateView(required, known(enrolled), "settled").view).toBe("enrol");
  });

  it("shuts the dashboard on the browser's answer alone", () => {
    expect(gateView(required, unknown, "settled").view).toBe("enrol");
    expect(gateView(required, none, "settled").view).toBe("enrol");
  });
});

describe("gateView — when the browser's read fails", () => {
  it("keeps the dashboard shut on the server's 'required'", () => {
    expect(gateView(null, known(required), "settled").view).toBe("enrol");
  });

  it("stops waiting and renders the app, whose every request the api refuses anyway", () => {
    expect(gateView(null, unknown, "settled").view).toBe("app");
  });
});

describe("gateView — while the browser's read waits out a 429", () => {
  // The layout's read comes from the web pod, so a 429 or a timeout there is
  // `unknown`, and the browser's own read decides. A 429 on that one too is
  // "ask later", so the gate keeps waiting with something on screen rather
  // than render the app with nothing answered.
  it("keeps the loading state when the server's read went unanswered too", () => {
    expect(gateView(null, unknown, "retrying")).toEqual({ view: "wait", twoFactor: null });
  });

  it("keeps the dashboard shut on the server's 'required'", () => {
    expect(gateView(null, known(required), "retrying").view).toBe("enrol");
  });

  it("renders the dashboard on the server's 'not required'", () => {
    expect(gateView(null, known(enrolled), "retrying").view).toBe("app");
  });

  it("renders the dashboard where accounts are off", () => {
    expect(gateView(null, none, "retrying").view).toBe("app");
  });
});

describe("liveReadOf", () => {
  const read = (over: Partial<Parameters<typeof liveReadOf>[0]>) =>
    liveReadOf({ authReady: true, signedIn: true, answered: false, error: undefined, ...over });

  it("is pending before the session bridge has run, whatever else it has", () => {
    expect(read({ authReady: false })).toBe("pending");
    expect(read({ authReady: false, error: new ApiError(500, "no") })).toBe("pending");
  });

  it("is settled with nobody signed in — there is no read to wait for", () => {
    expect(read({ signedIn: false })).toBe("settled");
  });

  it("is pending while the first read is in flight", () => {
    expect(read({})).toBe("pending");
  });

  it("is retrying on a 429, which says 'later', not 'no'", () => {
    expect(read({ error: new ApiError(429, "Rate limit exceeded", undefined, Date.now() + 30_000) })).toBe(
      "retrying",
    );
    // A 429 that named no time still retries, on the usual backoff.
    expect(read({ error: new ApiError(429, "Rate limit exceeded") })).toBe("retrying");
  });

  it.each([
    ["a 500", new ApiError(500, "Internal Server Error")],
    ["a 503", new ApiError(503, "auth database not ready", "AUTH_UNAVAILABLE")],
    ["a network failure", new TypeError("Failed to fetch")],
  ])("is settled on %s", (_, error) => {
    expect(read({ error })).toBe("settled");
  });

  it("is settled once it has answered, even when a later poll is refused", () => {
    expect(read({ answered: true, error: new ApiError(429, "Rate limit exceeded") })).toBe("settled");
  });
});

describe("parseTwoFactor", () => {
  it("reads the api's block", () => {
    expect(
      parseTwoFactor({ enrolled: false, enrolmentRequired: true, graceEndsAt: null, daysLeft: null }),
    ).toEqual(required);
    expect(parseTwoFactor({ ...inGrace })).toEqual(inGrace);
  });

  it.each([
    ["nothing", undefined],
    ["null", null],
    ["a string", "required"],
    ["a block missing enrolmentRequired", { enrolled: false }],
    ["a block with a string for a flag", { enrolled: false, enrolmentRequired: "true" }],
  ])("is no answer for %s — never a 'not required'", (_, raw) => {
    expect(parseTwoFactor(raw)).toBeNull();
  });

  it("drops a grace end or a day count of the wrong type rather than trusting it", () => {
    expect(
      parseTwoFactor({ enrolled: false, enrolmentRequired: true, graceEndsAt: 5, daysLeft: "3" }),
    ).toEqual(required);
  });
});
