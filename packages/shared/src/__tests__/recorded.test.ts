import { afterEach, describe, expect, it } from "vitest";
import { applyScope } from "../promql/scope.js";
import {
  RECORDED,
  RECORDED_CHART_FLOOR,
  isRecordedMetric,
  recordedReadsFor,
  recordedReadsPolicy,
  recordedSeriesFor,
  recordedWindows,
  setRecordedReads,
} from "../promql/recorded.js";
import { WINDOWS } from "../constants/windows.js";
import {
  qAvailability,
  qAvailabilitySeriesExpr,
  qBackupShareExpr,
  qClientRequestsBy,
  qClientRequestsTotal,
  qClientRpsSeriesExpr,
  qEndpointLatencyByEndpointSeriesExpr,
  qEndpointLatencyQuantile,
  qEndpointLatencyQuantileBySpec,
  qEndpointLatencySeriesExpr,
  qEndpointRelaysBySpec,
  qEndpointRequests,
  qErrorCount,
  qErrorCountSeriesExpr,
  qErrorRate,
  qErrorRateSeriesExpr,
  qErrorsBy,
  qErrorsByUpstream,
  qGroupedAvailability,
  qGroupedClientRequests,
  qGroupedLatencyQuantile,
  qLatencyDistribution,
  qLatencyQuantile,
  qLatencySeriesExpr,
  qMethodLatencyQuantile,
  qPerSpecClientRpsSeriesExpr,
  qPerSpecLatencySeriesExpr,
  qPerSpecRpsExpr,
  qPerUpstreamRpsExpr,
  qReadRequestsByMethod,
  qRequestsBy,
  qRequestsByUpstream,
  qRequestsTotal,
  qRetriesTotal,
  qRpsSeriesExpr,
  qUpstreamAvailability,
  qUpstreamErrorRate,
  qUpstreamFailedCount,
  qUpstreamFailedSeriesExpr,
  qUpstreamRelays,
  qUpstreamRequestsTotal,
  qUpstreamRpsByUpstreamSeriesExpr,
  qUpstreamSuccesses,
  qUpstreamVolumeSeriesExpr,
} from "../promql/builders.js";

const REF = { spec: "ETH1", endpointId: "eth-lava" };
// A raw family name standing on its own — not the one inside a recorded name
// (`spec_router:smartrouter_requests_total:rate2m` carries it between colons).
const RAW_FAMILIES = /(?<![:a-z_])(smartrouter_requests_(?:total|success_total|read_total)|smartrouter_end_to_end_latency_milliseconds_(?:bucket|count)|rpc_endpoint_end_to_end_latency_milliseconds_bucket|rpc_endpoint_total_relays_serviced)(?![:a-z_])/;
const RECORDED_NAME = /\b[a-z_]+:(?:smartrouter|rpc_endpoint)_[a-z_]+:rate2m\b/;

/** Every builder that reads a family the rules record, called for one window. */
const BUILDERS: Array<[string, (w: "1h" | "6h" | "1d") => string]> = [
  ["qRequestsTotal", (w) => qRequestsTotal("ETH1", w, "21600s")],
  ["qClientRequestsTotal", (w) => qClientRequestsTotal(undefined, w)],
  ["qClientRequestsBy spec", (w) => qClientRequestsBy("spec", w)],
  ["qAvailability", (w) => qAvailability("ETH1", w, "21600s")],
  ["qErrorRate", (w) => qErrorRate(undefined, w)],
  ["qLatencyQuantile", (w) => qLatencyQuantile(0.95, "ETH1", w, "21600s")],
  ["qEndpointRequests", (w) => qEndpointRequests("ETH1", w)],
  ["qEndpointRelaysBySpec", (w) => qEndpointRelaysBySpec(w, "ETH1")],
  ["qEndpointLatencyQuantileBySpec", (w) => qEndpointLatencyQuantileBySpec(0.95, w)],
  ["qErrorCount", (w) => qErrorCount("ETH1", w, "21600s")],
  ["qErrorsBy spec", (w) => qErrorsBy("spec", w)],
  ["qErrorsBy provider_address", (w) => qErrorsBy("provider_address", w, "ETH1")],
  ["qErrorsBy method", (w) => qErrorsBy("method", w, "ETH1")],
  ["qErrorsByUpstream", (w) => qErrorsByUpstream(w, "ETH1")],
  ["qRequestsBy method", (w) => qRequestsBy("method", w, "ETH1")],
  ["qRequestsByUpstream", (w) => qRequestsByUpstream(w)],
  ["qUpstreamRelays", (w) => qUpstreamRelays(w, "ETH1")],
  ["qUpstreamSuccesses", (w) => qUpstreamSuccesses(w, "ETH1")],
  ["qReadRequestsByMethod", (w) => qReadRequestsByMethod(w, "ETH1")],
  ["qGroupedClientRequests", (w) => qGroupedClientRequests(["spec", "router"], w)],
  ["qGroupedAvailability", (w) => qGroupedAvailability(["spec"], w)],
  ["qGroupedLatencyQuantile", (w) => qGroupedLatencyQuantile(0.95, ["spec", "router"], w, "ETH1")],
  ["qEndpointLatencyQuantile", (w) => qEndpointLatencyQuantile(0.95, REF, w)],
  ["qUpstreamErrorRate", (w) => qUpstreamErrorRate(REF, w)],
  ["qUpstreamRequestsTotal", (w) => qUpstreamRequestsTotal(REF, w)],
  ["qUpstreamAvailability", (w) => qUpstreamAvailability(REF, w)],
  ["qUpstreamFailedCount", (w) => qUpstreamFailedCount(REF, w)],
  ["qLatencyDistribution", (w) => qLatencyDistribution(w, "ETH1")],
];

/** Chart-series builders: recorded from the chart floor (12h) up, raw below it even under the policy. */
const SERIES: Array<[string, (w: "1h" | "6h" | "1d") => string]> = [
  ["qAvailabilitySeriesExpr", (w) => qAvailabilitySeriesExpr("2m", "ETH1", w)],
  ["qErrorRateSeriesExpr", (w) => qErrorRateSeriesExpr("2m", undefined, w)],
  ["qErrorCountSeriesExpr", (w) => qErrorCountSeriesExpr("2m", "ETH1", w)],
  ["qRpsSeriesExpr", (w) => qRpsSeriesExpr("2m", undefined, w)],
  ["qClientRpsSeriesExpr", (w) => qClientRpsSeriesExpr("2m", "ETH1", w)],
  ["qLatencySeriesExpr", (w) => qLatencySeriesExpr(0.5, "2m", "ETH1", w)],
  ["qPerSpecLatencySeriesExpr", (w) => qPerSpecLatencySeriesExpr(0.95, "2m", w)],
  ["qPerSpecClientRpsSeriesExpr", (w) => qPerSpecClientRpsSeriesExpr("2m", undefined, w)],
  ["qPerUpstreamRpsExpr", (w) => qPerUpstreamRpsExpr("2m", "ETH1", w)],
  ["qPerSpecRpsExpr", (w) => qPerSpecRpsExpr("2m", w)],
  ["qBackupShareExpr", (w) => qBackupShareExpr("ETH1", ["Blockdaemon"], "2m", w)],
  ["qEndpointLatencySeriesExpr", (w) => qEndpointLatencySeriesExpr(0.95, REF, "2m", w)],
  ["qEndpointLatencyByEndpointSeriesExpr", (w) => qEndpointLatencyByEndpointSeriesExpr(0.95, "ETH1", "10m", "2m", w)],
  ["qUpstreamRpsByUpstreamSeriesExpr", (w) => qUpstreamRpsByUpstreamSeriesExpr("ETH1", "10m", "2m", "1m", w)],
  ["qUpstreamVolumeSeriesExpr", (w) => qUpstreamVolumeSeriesExpr(REF, "2m", w)],
  ["qUpstreamFailedSeriesExpr", (w) => qUpstreamFailedSeriesExpr(REF, "2m", w)],
];

/** Builders that read a family the rules record under a label they do not keep, or one they do not record at all. */
const STAYS_RAW: Array<[string, (w: "6h") => string]> = [
  ["qClientRequestsBy function", (w) => qClientRequestsBy("function", w)],
  ["qMethodLatencyQuantile", (w) => qMethodLatencyQuantile(0.95, w, "ETH1")],
  ["qRetriesTotal", (w) => qRetriesTotal("recovered", w)],
];

afterEach(() => setRecordedReads({ from: null, available: false }));

describe("recorded reads policy", () => {
  it("is off until the api sets it", () => {
    expect(recordedReadsPolicy()).toEqual({ from: null, available: false, historySeconds: null });
    expect(recordedReadsFor("7d")).toBe(false);
  });

  it("reads recorded series only where the history covers the window — twice for a read with a prior window", () => {
    // Rules that started six hours ago: 3h and 6h windows are covered, a day is not.
    setRecordedReads({ from: "3h", available: true, historySeconds: 6 * 3600 });
    expect(recordedReadsFor("3h")).toBe(true);
    expect(recordedReadsFor("6h")).toBe(true);
    expect(recordedReadsFor("1d")).toBe(false);
    // A read that also wants the window before needs twice the history.
    expect(recordedReadsFor("3h", 2)).toBe(true);
    expect(recordedReadsFor("6h", 2)).toBe(false);
    // The builders ask that way: a KPI with an offset stays raw at 6h, its current-only form switches.
    expect(qClientRequestsTotal(undefined, "6h", "21600s")).not.toMatch(RECORDED_NAME);
    expect(qClientRequestsTotal(undefined, "6h")).toMatch(RECORDED_NAME);
    // No measurement is no history.
    setRecordedReads({ from: "3h", available: true });
    expect(recordedReadsFor("3h")).toBe(false);
    expect(recordedWindows()).toEqual({ recorded: [], raw: Object.keys(WINDOWS) });
  });

  it("applies from the floor window up, only while the series are fresh", () => {
    setRecordedReads({ from: "3h", available: true, historySeconds: 2_592_000 });
    expect(recordedReadsFor("1h")).toBe(false);
    expect(recordedReadsFor("3h")).toBe(true);
    expect(recordedReadsFor("30d")).toBe(true);
    setRecordedReads({ from: "3h", available: false, historySeconds: 2_592_000 });
    expect(recordedReadsFor("30d")).toBe(false);
  });

  it("keeps chart series on raw reads below the chart floor", () => {
    setRecordedReads({ from: "3h", available: true, historySeconds: 2_592_000 });
    expect(RECORDED_CHART_FLOOR).toBe("12h");
    expect(recordedSeriesFor("6h")).toBe(false);
    expect(recordedSeriesFor("12h")).toBe(true);
    expect(recordedSeriesFor("7d")).toBe(true);
    expect(recordedSeriesFor(undefined)).toBe(false);
    setRecordedReads({ from: "3h", available: false, historySeconds: 2_592_000 });
    expect(recordedSeriesFor("7d")).toBe(false);
  });

  it("names exactly the recorded series", () => {
    for (const name of Object.values(RECORDED)) expect(isRecordedMetric(name)).toBe(true);
    expect(isRecordedMetric("smartrouter_requests_total")).toBe(false);
    expect(isRecordedMetric("spec_router:smartrouter_requests_total:rate5m")).toBe(false);
  });
});

describe("builders under the recorded reads policy", () => {
  it.each(BUILDERS)("%s reads the recorded series at 6h and the raw family at 1h", (_name, build) => {
    const rawSixHours = build("6h");
    const rawOneHour = build("1h");
    setRecordedReads({ from: "3h", available: true, historySeconds: 2_592_000 });
    const recorded = build("6h");
    expect(recorded).not.toBe(rawSixHours);
    expect(recorded).toMatch(RECORDED_NAME);
    expect(recorded).not.toMatch(RAW_FAMILIES);
    // Every read keeps its chain filter, grouping and offset.
    for (const token of ['spec="ETH1"', "offset 21600s", "sum by (spec, router", "provider_address", "by (method)"]) {
      if (rawSixHours.includes(token)) expect(recorded).toContain(token);
    }
    expect(build("1h")).toBe(rawOneHour);
  });

  it.each(BUILDERS)("%s reads raw while the series are stale", (_name, build) => {
    const raw = build("6h");
    setRecordedReads({ from: "3h", available: false, historySeconds: 2_592_000 });
    expect(build("6h")).toBe(raw);
  });

  it.each(SERIES)("%s reads the recorded series at 1d and raw at 6h, below the chart floor", (_name, build) => {
    const rawDay = build("1d");
    const rawSixHours = build("6h");
    setRecordedReads({ from: "3h", available: true, historySeconds: 2_592_000 });
    const recorded = build("1d");
    expect(recorded).not.toBe(rawDay);
    expect(recorded).toMatch(RECORDED_NAME);
    expect(recorded).not.toMatch(RAW_FAMILIES);
    expect(build("6h")).toBe(rawSixHours);
  });

  it.each(STAYS_RAW)("%s stays raw under the policy", (_name, build) => {
    const raw = build("6h");
    setRecordedReads({ from: "3h", available: true, historySeconds: 2_592_000 });
    expect(build("6h")).toBe(raw);
  });

  it("scales a count by the ruler interval and leaves a ratio and a quantile unscaled", () => {
    setRecordedReads({ from: "3h", available: true, historySeconds: 2_592_000 });
    expect(qClientRequestsTotal(undefined, "6h")).toBe(
      `round(sum(sum_over_time(${RECORDED.clientRequests}[21600s])) * 60)`,
    );
    expect(qAvailability(undefined, "1d", "86400s")).toBe(
      `clamp_max(sum(sum_over_time(${RECORDED.success}[86400s] offset 86400s)) / sum(sum_over_time(${RECORDED.requests}[86400s] offset 86400s)), 1)`,
    );
    expect(qLatencyQuantile(0.95, "ETH1", "7d")).toBe(
      `histogram_quantile(0.95, sum by (le) (sum_over_time(${RECORDED.latencyBucket}{spec="ETH1"}[604800s])))`,
    );
    expect(qLatencySeriesExpr(0.5, "10m", undefined, "1d")).toBe(
      `histogram_quantile(0.5, sum by (le) (avg_over_time(${RECORDED.latencyBucket}[10m])))`,
    );
  });
});

describe("router scope on recorded reads", () => {
  it("reaches every recorded series the way it reaches the raw families", () => {
    setRecordedReads({ from: "3h", available: true, historySeconds: 2_592_000 });
    const scope = { label: "router", value: "eth-router" };
    const reads = [...BUILDERS.map(([, b]) => b("6h")), ...SERIES.map(([, b]) => b("1d"))];
    for (const expr of reads) {
      const scoped = applyScope(expr, scope);
      const names = scoped.match(/[a-z_]+:(?:smartrouter|rpc_endpoint)_[a-z_]+:rate2m(\{[^}]*\})?/g) ?? [];
      expect(names.length).toBeGreaterThan(0);
      for (const n of names) expect(n).toContain('router="eth-router"');
    }
  });
});
