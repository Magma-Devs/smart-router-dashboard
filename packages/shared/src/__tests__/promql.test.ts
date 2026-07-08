import { describe, expect, it } from "vitest";
import {
  selector,
  rangeFor,
  qRequestsTotal,
  qAvailability,
  qErrorRate,
  qLatencyQuantile,
  qLatestBlock,
  qErrorCount,
  qErrorsBy,
  qRequestsBy,
  qAvailabilitySeriesExpr,
  qErrorRateSeriesExpr,
  qErrorCountSeriesExpr,
  qRpsSeriesExpr,
  qLatencySeriesExpr,
  qPerUpstreamRpsExpr,
  qPerSpecRpsExpr,
  qBackupShareExpr,
  qEndpointLatencyQuantile,
  qEndpointLatencySeriesExpr,
  qUpstreamVolumeSeriesExpr,
  qUpstreamReadVolumeSeriesExpr,
  qUpstreamErrorRate,
  qBlockLagByEndpoint,
  qEndpointBlockLagSeriesExpr,
  qChainDown,
  qScoreExpr,
  qOptimizerScore,
  qConsistencyCaught,
  qCsm,
  qLatencyDistribution,
  qPresence,
} from "../promql/builders.js";
import { buildChainMetaByIndex } from "../constants/chains.js";
import {
  WINDOWS,
  WINDOW_OPTIONS,
  isMetricWindow,
  toMetricWindow,
  stepSeconds,
} from "../constants/windows.js";

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
  it("qAvailability is success/total, clamped to ≤ 1", () => {
    expect(qAvailability("ETH1", "1h")).toContain("smartrouter_requests_success_total");
    expect(qAvailability("ETH1", "1h")).toContain("smartrouter_requests_total");
    // clamp_max(…, 1): increase() extrapolation can push the ratio > 1 on a
    // young counter, which would render as a >100% success rate.
    expect(qAvailability("ETH1", "1h")).toContain("clamp_max(");
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
  it("resolves a known spec: name, family, and a local icon path", () => {
    const m = buildChainMetaByIndex("ETH1");
    expect(m.name).toBe("Ethereum");
    expect(m.family).toBe("evm");
    expect(m.iconUrl).toBe("/chains/ethereum.svg");
  });
  it("resolves the display name from the chain map (not the raw index)", () => {
    // Regression: these specs used to fall through to `name: <index>` and the
    // UI showed "HYPERLIQUID" / "APT1" / "BTC" — now the real spec name shows.
    expect(buildChainMetaByIndex("HYPERLIQUID").name).toBe("Hyperliquid");
    expect(buildChainMetaByIndex("APT1").name).toBe("Aptos");
    expect(buildChainMetaByIndex("BTC").name).toBe("Bitcoin");
  });
  it("carries the vendored icon + family for a range of chains", () => {
    expect(buildChainMetaByIndex("HYPERLIQUID").iconUrl).toBe("/chains/hyperliquid.svg");
    expect(buildChainMetaByIndex("COSMOSHUB").family).toBe("cosmos");
    expect(buildChainMetaByIndex("BTC").family).toBe("bitcoin");
  });
  it("flags mainnet vs testnet", () => {
    expect(buildChainMetaByIndex("ETH1").mainnet).toBe(true);
    expect(buildChainMetaByIndex("HYPERLIQUIDT").mainnet).toBe(false);
  });
  it("keeps the testnet qualifier on testnet specs", () => {
    expect(buildChainMetaByIndex("HYPERLIQUIDT").name).toBe("Hyperliquid Testnet");
  });
  it("falls back to the raw index + default icon for an unknown spec", () => {
    const m = buildChainMetaByIndex("WEIRD9");
    expect(m.name).toBe("WEIRD9");
    expect(m.spec).toBe("WEIRD9");
    expect(m.iconUrl).toBe("/chains/default.svg");
    expect(m.family).toBe("evm");
  });
});

describe("isMetricWindow", () => {
  it("accepts a valid window", () => {
    expect(isMetricWindow("30d")).toBe(true);
  });
  it("accepts the design's new windows", () => {
    for (const w of ["15m", "30m", "3h", "12h", "3d", "14d", "21d"]) {
      expect(isMetricWindow(w)).toBe(true);
    }
  });
  it("rejects an invalid window", () => {
    expect(isMetricWindow("99y")).toBe(false);
    expect(isMetricWindow("24h")).toBe(false); // alias, not a key
  });
});

describe("windows catalog", () => {
  it("has 13 windows and 12 design select options", () => {
    expect(Object.keys(WINDOWS)).toHaveLength(13);
    expect(WINDOW_OPTIONS).toHaveLength(12);
    expect(WINDOW_OPTIONS).not.toContain("1h"); // 1h exists but is not a select option
  });
  it("every step targets ≤220 points and ≥15s resolution", () => {
    for (const key of Object.keys(WINDOWS) as (keyof typeof WINDOWS)[]) {
      const s = stepSeconds(key);
      expect(s).toBeGreaterThanOrEqual(15);
      expect(WINDOWS[key].rangeSeconds / s).toBeLessThanOrEqual(220);
      expect(WINDOWS[key].rangeSeconds / s).toBeGreaterThanOrEqual(15);
    }
  });
  it("toMetricWindow resolves keys, aliases, and garbage", () => {
    expect(toMetricWindow("7d")).toBe("7d");
    expect(toMetricWindow("24h")).toBe("1d");
    expect(toMetricWindow("bogus")).toBe("1d");
    expect(toMetricWindow(undefined)).toBe("1d");
  });
});

describe("offset (prior-window) variants", () => {
  it("qRequestsTotal appends offset to the range selector", () => {
    expect(qRequestsTotal("ETH1", "1d", "86400s")).toBe(
      'sum(increase(smartrouter_requests_total{spec="ETH1"}[86400s] offset 86400s))',
    );
  });
  it("qAvailability offsets both legs", () => {
    const q = qAvailability(undefined, "1h", "3600s");
    expect(q.match(/offset 3600s/g)).toHaveLength(2);
  });
  it("qLatencyQuantile offsets the bucket rate", () => {
    expect(qLatencyQuantile(0.95, undefined, "1h", "3600s")).toContain("[3600s] offset 3600s");
  });
  it("no offset ⇒ unchanged output", () => {
    expect(qRequestsTotal("ETH1", "1d")).not.toContain("offset");
  });
});

describe("derived error math", () => {
  it("qErrorCount is clamp_min(total − success, 0)", () => {
    expect(qErrorCount("ETH1", "1d")).toBe(
      'clamp_min(sum(increase(smartrouter_requests_total{spec="ETH1"}[86400s])) - sum(increase(smartrouter_requests_success_total{spec="ETH1"}[86400s])), 0)',
    );
  });
  it("qErrorsBy keeps all-error groups via `or … * 0`", () => {
    const q = qErrorsBy("provider_address", "1d");
    expect(q).toContain("sum by (provider_address)");
    expect(q).toContain("or sum by (provider_address) (increase(smartrouter_requests_total[86400s])) * 0");
    expect(q.startsWith("clamp_min(")).toBe(true);
  });
  it("qRequestsBy groups requests by the label", () => {
    expect(qRequestsBy("method", "1h", "ETH1")).toBe(
      'sum by (method) (increase(smartrouter_requests_total{spec="ETH1"}[3600s]))',
    );
  });
});

describe("series expressions", () => {
  it("availability series is a rate ratio over the step, clamped to ≤ 1", () => {
    // clamp_max(…, 1) guards against rate() extrapolation pushing the ratio
    // above 1 on a counter younger than the step window (the >100% artifact).
    expect(qAvailabilitySeriesExpr("10m", "ETH1")).toBe(
      'clamp_max(sum(rate(smartrouter_requests_success_total{spec="ETH1"}[10m])) / sum(rate(smartrouter_requests_total{spec="ETH1"}[10m])), 1)',
    );
  });
  it("error-rate series is 1 − availability series", () => {
    expect(qErrorRateSeriesExpr("10m").startsWith("1 - (")).toBe(true);
  });
  it("error-count series clamps at zero", () => {
    expect(qErrorCountSeriesExpr("10m")).toContain("clamp_min(");
  });
  it("rps series uses rate over the step", () => {
    expect(qRpsSeriesExpr("30s")).toBe("sum(rate(smartrouter_requests_total[30s]))");
  });
  it("latency series drops the spec grouping (single-chain scope)", () => {
    expect(qLatencySeriesExpr(0.5, "10m", "ETH1")).toBe(
      'histogram_quantile(0.5, sum by (le) (rate(smartrouter_end_to_end_latency_milliseconds_bucket{spec="ETH1"}[10m])))',
    );
  });
  it("per-upstream and per-spec stacks group correctly", () => {
    expect(qPerUpstreamRpsExpr("10m")).toContain("sum by (provider_address)");
    expect(qPerSpecRpsExpr("10m")).toContain("sum by (spec)");
  });
  it("backup share regex-escapes upstream names", () => {
    const q = qBackupShareExpr("ETH1", ["eth.backup"], "10m");
    expect(q).toContain('provider_address=~"eth\\\\.backup"');
    expect(q).toContain('{spec="ETH1"}');
  });
});

describe("endpoint-scope builders", () => {
  it("endpoint latency quantile targets rpc_endpoint buckets", () => {
    expect(qEndpointLatencyQuantile(0.99, "eth-lava", "1d")).toBe(
      'histogram_quantile(0.99, sum by (le) (rate(rpc_endpoint_end_to_end_latency_milliseconds_bucket{endpoint_id="eth-lava"}[86400s])))',
    );
  });
  it("endpoint latency series uses the step", () => {
    expect(qEndpointLatencySeriesExpr(0.5, "eth-lava", "10m")).toContain("[10m]");
  });
  it("provider volume + read volume target router counters by provider_address", () => {
    expect(qUpstreamVolumeSeriesExpr("eth-lava", "10m")).toContain(
      'smartrouter_requests_total{provider_address="eth-lava"}',
    );
    expect(qUpstreamReadVolumeSeriesExpr("eth-lava", "10m")).toContain(
      'smartrouter_requests_read_total{provider_address="eth-lava"}',
    );
  });
  it("provider error rate is 1 − success/total scoped by provider_address", () => {
    const q = qUpstreamErrorRate("eth-lava", "1d");
    expect(q.startsWith("1 - (")).toBe(true);
    expect(q).toContain('provider_address="eth-lava"');
  });
});

describe("health / lag / score / gauge builders", () => {
  it("block lag joins spec-max against each endpoint", () => {
    const q = qBlockLagByEndpoint("ETH1");
    expect(q).toContain("max by (spec) (rpc_endpoint_latest_block");
    expect(q).toContain("on(spec) group_right()");
  });
  it("single-endpoint block-lag series subtracts max()s", () => {
    expect(qEndpointBlockLagSeriesExpr("ETH1", "eth-lava")).toBe(
      'max(rpc_endpoint_latest_block{spec="ETH1"}) - max(rpc_endpoint_latest_block{spec="ETH1",endpoint_id="eth-lava"})',
    );
  });
  it("chain-down is a bool comparison on the spec max", () => {
    expect(qChainDown()).toBe("max by (spec) (rpc_endpoint_overall_health) == bool 0");
  });
  it("score expressions target both scopes", () => {
    expect(qScoreExpr("composite", "ETH1", "eth-lava")).toBe(
      'avg(rpc_endpoint_selection_score{spec="ETH1",endpoint_id="eth-lava",score_type="composite"})',
    );
    expect(qOptimizerScore("composite", "ETH1")).toBe(
      'avg(rpc_optimizer_selection_score{spec="ETH1",score_type="composite"})',
    );
  });
  it("consistency caught sums the success counter", () => {
    expect(qConsistencyCaught("1d")).toBe(
      "sum(increase(smartrouter_consistency_success_total[86400s]))",
    );
  });
  it("csm gauge probe matches the four csm series", () => {
    const q = qCsm();
    for (const m of [
      "smartrouter_csm_blocked_providers",
      "smartrouter_csm_blocked_backup_providers",
      "smartrouter_csm_reported_providers",
      "smartrouter_csm_sticky_sessions",
    ]) {
      expect(q).toContain(m);
    }
  });
  it("latency distribution groups increase by le", () => {
    expect(qLatencyDistribution("1d", "ETH1")).toBe(
      'sum by (le) (increase(smartrouter_end_to_end_latency_milliseconds_bucket{spec="ETH1"}[86400s]))',
    );
  });
  it("presence probes count the metric by name", () => {
    expect(qPresence("smartrouter_retries_total")).toBe(
      'count({__name__="smartrouter_retries_total"})',
    );
  });
});
