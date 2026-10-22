import { describe, expect, it } from "vitest";
import { stepSeconds, WINDOWS, type MetricWindow } from "@sr/shared";
import { pollMsFor, pollMsForKey } from "../poll";

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
