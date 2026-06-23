import { describe, expect, it } from "vitest";
import {
  selector,
  rangeFor,
  qRequestsTotal,
  qAvailability,
  qErrorRate,
  qLatencyQuantile,
  qLatestBlock,
} from "../promql/builders.js";
import { buildChainMetaByIndex } from "../constants/chains.js";
import { isMetricWindow } from "../constants/windows.js";

describe("selector", () => {
  it("drops undefined and empty labels", () => {
    expect(selector({ spec: "ETH1", method: undefined, foo: "" })).toBe('{spec="ETH1"}');
  });
  it("returns empty string when nothing is set", () => {
    expect(selector({ spec: undefined })).toBe("");
  });
  it("joins multiple labels", () => {
    expect(selector({ spec: "ETH1", score_type: "composite" })).toBe(
      '{spec="ETH1",score_type="composite"}',
    );
  });
});

describe("rangeFor", () => {
  it("maps a window to its second-range", () => {
    expect(rangeFor("1d")).toBe("86400s");
    expect(rangeFor("5m")).toBe("300s");
  });
});

describe("query builders use the real metric names", () => {
  it("qRequestsTotal targets smartrouter_requests_total", () => {
    expect(qRequestsTotal("ETH1", "1d")).toBe(
      'sum(increase(smartrouter_requests_total{spec="ETH1"}[86400s]))',
    );
  });
  it("qAvailability is success/total", () => {
    expect(qAvailability("ETH1", "1h")).toContain("smartrouter_requests_success_total");
    expect(qAvailability("ETH1", "1h")).toContain("smartrouter_requests_total");
  });
  it("qErrorRate is 1 - availability", () => {
    expect(qErrorRate("ETH1", "1h").startsWith("1 - (")).toBe(true);
  });
  it("qLatencyQuantile uses histogram_quantile on the bucket series", () => {
    const q = qLatencyQuantile(0.95, "ETH1", "1d");
    expect(q).toContain("histogram_quantile(0.95");
    expect(q).toContain("smartrouter_end_to_end_latency_milliseconds_bucket");
  });
  it("qLatestBlock aggregates by spec", () => {
    expect(qLatestBlock()).toBe("max by (spec) (smartrouter_latest_block)");
  });
});

describe("buildChainMetaByIndex", () => {
  it("resolves a known spec", () => {
    const m = buildChainMetaByIndex("ETH1");
    expect(m.name).toBe("Ethereum");
    expect(m.color).toBe("#627EEA");
  });
  it("synthesises a fallback for an unknown spec", () => {
    const m = buildChainMetaByIndex("WEIRD9");
    expect(m.name).toBe("WEIRD9");
    expect(m.spec).toBe("WEIRD9");
  });
});

describe("isMetricWindow", () => {
  it("accepts a valid window", () => {
    expect(isMetricWindow("30d")).toBe(true);
  });
  it("rejects an invalid window", () => {
    expect(isMetricWindow("99y")).toBe(false);
  });
});
