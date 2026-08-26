import { describe, expect, it } from "vitest";
import type { UpstreamMetrics } from "@sr/shared";
import {
  pollColor,
  pollSummary,
  qosHint,
  qosIsStale,
  qosValue,
} from "../upstream-signals";

const upstream = (over: Partial<UpstreamMetrics> = {}): UpstreamMetrics => ({
  endpointId: "eth-primary",
  spec: "ETH1",
  requests: 0,
  uptime: null,
  p95Ms: null,
  errorRate: null,
  scores: {},
  scoreSource: null,
  polls: null,
  health: "unknown",
  latestBlock: null,
  blockLag: null,
  behindSec: null,
  stale: false,
  role: null,
  apiInterface: null,
  inFlight: 0,
  routerIds: [],
  ...over,
});

describe("qosValue", () => {
  it("scales the 0..1 composite to the 0..100 figure every surface renders", () => {
    expect(qosValue(upstream({ scores: { composite: 0.9812 } }))).toBeCloseTo(98.12);
  });

  it("is null when no score was reported, never 0", () => {
    // 0 is a real QoS — an upstream scored down to nothing. Collapsing "absent"
    // into it would paint a healthy idle backup red.
    expect(qosValue(upstream())).toBeNull();
    expect(qosValue(upstream({ scores: { composite: 0 } }))).toBe(0);
  });
});

describe("qosIsStale", () => {
  it("marks the routing-path score on an idle row — it can be any age", () => {
    expect(qosIsStale(upstream({ scoreSource: "endpoint", requests: 0 }))).toBe(true);
  });

  it("does not mark the sampler's score, which is refreshed without traffic", () => {
    // The whole point of preferring the optimizer gauge: no traffic needed, so
    // an idle row's score is current and must not be dimmed as if it were old.
    expect(qosIsStale(upstream({ scoreSource: "optimizer", requests: 0 }))).toBe(false);
  });

  it("does not mark the routing-path score on a row that served traffic", () => {
    expect(qosIsStale(upstream({ scoreSource: "endpoint", requests: 4200 }))).toBe(false);
  });

  it("does not mark a row with no score at all", () => {
    expect(qosIsStale(upstream())).toBe(false);
  });
});

describe("qosHint", () => {
  it("gives every source its own explanation, and says so when there is none", () => {
    const optimizer = qosHint(upstream({ scoreSource: "optimizer" }));
    const idle = qosHint(upstream({ scoreSource: "endpoint", requests: 0 }));
    const busy = qosHint(upstream({ scoreSource: "endpoint", requests: 10 }));
    const none = qosHint(upstream());
    for (const hint of [optimizer, idle, busy, none]) expect(hint).toBeTruthy();
    expect(new Set([optimizer, idle, busy, none]).size).toBe(4);
  });

  it("warns about age only on the row where the score can be old", () => {
    expect(qosHint(upstream({ scoreSource: "endpoint", requests: 0 }))).toMatch(/may be old/);
    expect(qosHint(upstream({ scoreSource: "optimizer", requests: 0 }))).not.toMatch(/old/);
  });
});

describe("pollSummary", () => {
  it("is null when the router does not publish the family at all", () => {
    // An older router: absent is not the same as zero, and the UI omits the
    // row rather than reporting "not polled".
    expect(pollSummary(null)).toBeNull();
  });

  it("says nothing was asked when both counters are zero", () => {
    // NOT "healthy". A poll gate suppresses polls that served traffic or a
    // peer's poll already made redundant, so zero failures proves nothing.
    expect(pollSummary({ ok: 0, failed: 0 })).toBe("none in this window");
  });

  it("says nothing about failures when there were none", () => {
    expect(pollSummary({ ok: 288, failed: 0 })).toBe("288 answered");
  });

  it("names the failures when there were some", () => {
    expect(pollSummary({ ok: 280, failed: 8 })).toBe("280 answered · 8 failed");
    expect(pollSummary({ ok: 0, failed: 12 })).toBe("0 answered · 12 failed");
  });

  it("does not repeat the label it sits under", () => {
    // The field is already labelled "Block polls" — repeating the words in the
    // value is what made this read as a sentence instead of a figure.
    for (const p of [{ ok: 288, failed: 0 }, { ok: 280, failed: 8 }, { ok: 0, failed: 0 }]) {
      expect(pollSummary(p)).not.toMatch(/block|poll/i);
    }
  });

  it("shortens counts that would otherwise dominate the line", () => {
    expect(pollSummary({ ok: 12400, failed: 0 })).toBe("12.4k answered");
  });
});

describe("pollColor", () => {
  it("stays neutral for both cases it cannot judge", () => {
    expect(pollColor(null)).toBe("var(--text-4)");
    expect(pollColor({ ok: 0, failed: 0 })).toBe("var(--text-4)");
  });

  it("separates a clean run from a partial failure from a total one", () => {
    expect(pollColor({ ok: 288, failed: 0 })).toBe("var(--ok)");
    expect(pollColor({ ok: 280, failed: 8 })).toBe("var(--warn)");
    expect(pollColor({ ok: 0, failed: 12 })).toBe("var(--err)");
  });
});
