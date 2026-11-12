import { describe, expect, it } from "vitest";
import { gateView, parseTwoFactor, type EnrolmentVerdict } from "../enrolment-gate";
import type { MeTwoFactor } from "@/hooks/use-me";

/**
 * The two-factor gate's decision: the enrolment screen, the dashboard, or an
 * empty page while it cannot tell.
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
    expect(gateView(null, known(required), false)).toEqual({ view: "enrol", twoFactor: required });
  });

  it("carries the server's grace-period end, so the screen's words are right from the start", () => {
    expect(gateView(null, known(lapsed), false).twoFactor?.graceEndsAt).toBe(lapsed.graceEndsAt);
  });

  it.each([
    ["enrolled", enrolled],
    ["in the grace period", inGrace],
  ])("renders the dashboard for an account %s", (_, twoFactor) => {
    expect(gateView(null, known(twoFactor), false).view).toBe("app");
  });

  it("draws nothing while neither side has answered", () => {
    expect(gateView(null, unknown, false)).toEqual({ view: "wait", twoFactor: null });
  });

  it("renders the dashboard where accounts are off — nothing would ever end a wait there", () => {
    expect(gateView(null, none, false).view).toBe("app");
    expect(gateView(null, none, true).view).toBe("app");
  });
});

describe("gateView — once the browser's read has landed", () => {
  it("lets the browser's newer answer lift the block, as enrolling in place does", () => {
    expect(gateView(enrolled, known(required), true).view).toBe("app");
  });

  it("lets the browser's newer answer shut a dashboard the server had opened", () => {
    // An admin reset this person's two-factor after the page was rendered.
    expect(gateView(required, known(enrolled), true).view).toBe("enrol");
  });

  it("shuts the dashboard on the browser's answer alone", () => {
    expect(gateView(required, unknown, true).view).toBe("enrol");
    expect(gateView(required, none, true).view).toBe("enrol");
  });
});

describe("gateView — when the browser's read fails", () => {
  it("keeps the dashboard shut on the server's 'required'", () => {
    expect(gateView(null, known(required), true).view).toBe("enrol");
  });

  it("stops waiting and renders the app, whose every request the api refuses anyway", () => {
    expect(gateView(null, unknown, true).view).toBe("app");
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
