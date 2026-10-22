import { describe, expect, it } from "vitest";
import { stepSeconds, WINDOWS, type MetricWindow } from "@sr/shared";
import {
  ACTIVITY_THROTTLE_MS, gatedPollMs, IDLE_PAUSE_AFTER_MS, IDLE_SLOW_AFTER_MS, idleGateApplies, idlePhase, idleStart, msToNextPhase,
  onActivity, onPhaseTimer, pollMsFor, pollMsForKey,
} from "../poll";

const S = 1_000;
const MIN = 60_000;

describe("pollMsFor", () => {
  it("polls short windows every 15 s, then every minute, 5 minutes and 15 minutes", () => {
    const cadence = Object.fromEntries((Object.keys(WINDOWS) as MetricWindow[]).map((w) => [w, pollMsFor(w)]));
    expect(cadence).toEqual({
      "5m": 15 * S, "15m": 15 * S, "30m": 15 * S, "1h": 15 * S,
      "3h": MIN, "6h": MIN, "12h": MIN,
      "1d": 5 * MIN, "3d": 5 * MIN,
      "7d": 15 * MIN, "14d": 15 * MIN, "21d": 15 * MIN, "30d": 15 * MIN,
    });
  });

  it("slides a window by under 1% of its length per poll from 30m up", () => {
    for (const w of Object.keys(WINDOWS) as MetricWindow[]) {
      if (w === "5m" || w === "15m") continue; // already at the 15 s scrape interval
      expect(pollMsFor(w) / (WINDOWS[w].rangeSeconds * S)).toBeLessThan(0.01);
    }
  });

  it("never polls slower than the window's chart draws a point", () => {
    for (const w of Object.keys(WINDOWS) as MetricWindow[]) {
      expect(pollMsFor(w)).toBeLessThanOrEqual(stepSeconds(w) * S);
    }
  });
});

describe("pollMsForKey", () => {
  it("holds a metrics read over a window to that window's cadence", () => {
    expect(pollMsForKey("/api/metrics/overview?window=7d", 15 * S)).toBe(15 * MIN);
    expect(pollMsForKey("/api/metrics/chain-series?spec=ETH1&window=3h&router=eth-prod", 15 * S)).toBe(MIN);
    expect(pollMsForKey("/api/metrics/upstreams?window=1d", 15 * S)).toBe(5 * MIN);
    expect(pollMsForKey("/api/metrics/overview?window=30m", 15 * S)).toBe(15 * S);
  });

  it("keeps the caller's interval when it is the longer one", () => {
    expect(pollMsForKey("/api/metrics/chains?window=30m", 30 * S)).toBe(30 * S);
    expect(pollMsForKey("/api/metrics/retries?window=3h", 2 * MIN)).toBe(2 * MIN);
  });

  it("never makes a key that doesn't poll start polling", () => {
    expect(pollMsForKey("/api/metrics/overview?window=7d", 0)).toBe(0);
  });

  it("reads a window as the api does: the 24h alias, and the default for one it doesn't know", () => {
    expect(pollMsForKey("/api/metrics/overview?window=24h", 15 * S)).toBe(5 * MIN);
    expect(pollMsForKey("/api/metrics/overview?window=2w", 15 * S)).toBe(15 * S);
    expect(pollMsForKey("/api/metrics/overview?window=", 15 * S)).toBe(15 * S);
  });

  it("leaves metrics reads without a window at the caller's interval", () => {
    expect(pollMsForKey("/api/metrics/pulse", 30 * S)).toBe(30 * S);
    expect(pollMsForKey("/api/metrics/block-heights?router=eth-prod", 15 * S)).toBe(15 * S);
    expect(pollMsForKey("/api/metrics/routers", 5 * MIN)).toBe(5 * MIN);
  });

  it("leaves every other route at the caller's interval, the log reads included", () => {
    expect(pollMsForKey("/api/error-requests?window=7d", 15 * S)).toBe(15 * S);
    expect(pollMsForKey("/api/error-requests/count?window=30d", 15 * S)).toBe(15 * S);
    expect(pollMsForKey("/api/transactions/over-time?window=30d", 15 * S)).toBe(15 * S);
    expect(pollMsForKey("/api/requests/abc?window=30d", 0)).toBe(0);
    expect(pollMsForKey("/api/config/routers", MIN)).toBe(MIN);
  });
});

describe("the idle gate", () => {
  const T0 = 1_700_000_000_000;

  it("slows after 10 minutes without activity and pauses after an hour", () => {
    expect(idlePhase(0)).toBe("active");
    expect(idlePhase(IDLE_SLOW_AFTER_MS - 1)).toBe("active");
    expect(idlePhase(IDLE_SLOW_AFTER_MS)).toBe("slow");
    expect(idlePhase(IDLE_PAUSE_AFTER_MS - 1)).toBe("slow");
    expect(idlePhase(IDLE_PAUSE_AFTER_MS)).toBe("paused");
    expect([IDLE_SLOW_AFTER_MS, IDLE_PAUSE_AFTER_MS]).toEqual([10 * MIN, 60 * MIN]);
  });

  it("says when the phase next moves on its own, and nothing once paused", () => {
    expect(msToNextPhase(0)).toBe(10 * MIN);
    expect(msToNextPhase(3 * MIN)).toBe(7 * MIN);
    expect(msToNextPhase(10 * MIN)).toBe(50 * MIN);
    expect(msToNextPhase(60 * MIN)).toBeNull();
  });

  it("multiplies an interval by 4 once idle and never makes 0 poll", () => {
    expect(gatedPollMs(15 * S, "active")).toBe(15 * S);
    expect(gatedPollMs(15 * S, "slow")).toBe(MIN);
    expect(gatedPollMs(15 * MIN, "slow")).toBe(60 * MIN);
    // Paused ticks are SWR no-ops (`isPaused`); the timer keeps the slowed pace.
    expect(gatedPollMs(15 * S, "paused")).toBe(MIN);
    for (const phase of ["active", "slow", "paused"] as const) expect(gatedPollMs(0, phase)).toBe(0);
  });

  it("counts activity at most once a throttle interval while active", () => {
    const s = idleStart(T0);
    expect(onActivity(s, T0 + ACTIVITY_THROTTLE_MS - 1)).toBe(s);
    const later = onActivity(s, T0 + ACTIVITY_THROTTLE_MS);
    expect(later).toEqual({ lastActivityAt: T0 + ACTIVITY_THROTTLE_MS, phase: "active", resumes: 0 });
  });

  it("walks active, slow, paused, and back on the first activity", () => {
    let s = idleStart(T0);
    expect(onPhaseTimer(s, T0 + 5 * MIN)).toBe(s);
    s = onPhaseTimer(s, T0 + 10 * MIN);
    expect(s.phase).toBe("slow");
    expect(onPhaseTimer(s, T0 + 30 * MIN)).toBe(s);
    s = onPhaseTimer(s, T0 + 60 * MIN);
    expect(s.phase).toBe("paused");
    s = onActivity(s, T0 + 90 * MIN);
    expect(s).toEqual({ lastActivityAt: T0 + 90 * MIN, phase: "active", resumes: 1 });
  });

  it("resumes from a slowdown too, not only from a pause", () => {
    const slow = onPhaseTimer(idleStart(T0, 2), T0 + 20 * MIN);
    expect(onActivity(slow, T0 + 20 * MIN + 1)).toEqual(idleStart(T0 + 20 * MIN + 1, 3));
  });

  it("resumes by the clock when the phase timer is late (a laptop waking up)", () => {
    const s = idleStart(T0);
    expect(onActivity(s, T0 + 2 * 60 * MIN).resumes).toBe(1);
  });

  it("keeps a timer that fires after activity from slowing anything", () => {
    const s = onActivity(idleStart(T0), T0 + 8 * MIN);
    expect(onPhaseTimer(s, T0 + 10 * MIN)).toBe(s);
    expect(msToNextPhase(T0 + 10 * MIN - s.lastActivityAt)).toBe(8 * MIN);
  });

  it("re-anchors on a clock that went backwards rather than never slowing", () => {
    const s = idleStart(T0);
    expect(onActivity(s, T0 - 5 * MIN).lastActivityAt).toBe(T0 - 5 * MIN);
  });
});

describe("idleGateApplies", () => {
  it("leaves the standalone page alone: it is for screens nobody touches", () => {
    expect(idleGateApplies("/standalone")).toBe(false);
    expect(idleGateApplies("/standalone/")).toBe(false);
    expect(idleGateApplies("/standalone/anything")).toBe(false);
  });

  it("holds every other page, including one whose name only starts the same", () => {
    for (const path of ["/", "/metrics", "/overview", "/upstreams", "/team", "/account", "/standalones", "/metrics/standalone"]) {
      expect(idleGateApplies(path)).toBe(true);
    }
  });
});
