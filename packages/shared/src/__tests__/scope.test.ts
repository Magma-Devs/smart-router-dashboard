import { describe, expect, it } from "vitest";
import {
  applyScope,
  isValidScope,
  isValidScopeLabel,
  isValidScopeValue,
  type MetricScope,
} from "../promql/scope.js";
import {
  qAvailability,
  qBlockLagByEndpoint,
  qChainDown,
  qEndpointPolls,
  qCsm,
  qOptimizerScoresByEndpoint,
  qErrorRate,
  qLatencyQuantile,
  qLatencySeriesExpr,
  qPerUpstreamRpsExpr,
  qPresence,
  qRequestsTotal,
  qScoreExpr,
} from "../promql/builders.js";

const SCOPE: MetricScope = { label: "service", value: "ethereum-router" };
const M = 'service="ethereum-router"';

describe("applyScope", () => {
  it("adds the matcher to a bare metric name", () => {
    expect(applyScope("smartrouter_overall_health", SCOPE)).toBe(
      `smartrouter_overall_health{${M}}`,
    );
  });

  it("merges into a selector that already carries labels", () => {
    expect(applyScope('smartrouter_requests_total{spec="ETH1"}', SCOPE)).toBe(
      `smartrouter_requests_total{${M},spec="ETH1"}`,
    );
  });

  it("leaves an empty selector without a dangling comma", () => {
    expect(applyScope("smartrouter_requests_total{}", SCOPE)).toBe(
      `smartrouter_requests_total{${M}}`,
    );
  });

  it("scopes a metric name quoted inside __name__ WITHOUT rewriting the string", () => {
    // The naive regex breaks exactly here: it would splice the matcher inside
    // the quotes and produce an unparseable query.
    expect(applyScope('count({__name__="smartrouter_retries_total"})', SCOPE)).toBe(
      `count({${M},__name__="smartrouter_retries_total"})`,
    );
  });

  it("scopes a regex __name__ selector once", () => {
    const expr = '{__name__=~"smartrouter_csm_blocked_providers|smartrouter_csm_sticky_sessions"}';
    expect(applyScope(expr, SCOPE)).toBe(
      `{${M},__name__=~"smartrouter_csm_blocked_providers|smartrouter_csm_sticky_sessions"}`,
    );
  });

  it("never touches function names, keywords or grouping labels", () => {
    const expr = "histogram_quantile(0.95, sum by (spec, le) (rate(x[5m])))";
    expect(applyScope(expr, SCOPE)).toBe(expr);
  });

  it("keeps range selectors and offsets intact", () => {
    expect(applyScope("increase(smartrouter_requests_total[3600s] offset 86400s)", SCOPE)).toBe(
      `increase(smartrouter_requests_total{${M}}[3600s] offset 86400s)`,
    );
  });

  it("scopes every selector when one expression has several", () => {
    const out = applyScope(
      'sum(smartrouter_requests_total{spec="ETH1"}) - sum(smartrouter_requests_success_total)',
      SCOPE,
    );
    expect(out).toBe(
      `sum(smartrouter_requests_total{${M},spec="ETH1"}) - sum(smartrouter_requests_success_total{${M}})`,
    );
  });

  it("leaves the shared cache sidecar's metrics cluster-wide", () => {
    // The cache is a separate process shared by every router: it carries no
    // router's target label, so scoping it would report zero rather than
    // "not attributable".
    expect(applyScope("increase(cache_total_hits[300s])", SCOPE)).toBe(
      "increase(cache_total_hits[300s])",
    );
  });

  it("covers metric families not in the catalog via the prefix rule", () => {
    expect(applyScope("smartrouter_some_future_total", SCOPE)).toBe(
      `smartrouter_some_future_total{${M}}`,
    );
    expect(applyScope("rpc_endpoint_future_gauge", SCOPE)).toBe(
      `rpc_endpoint_future_gauge{${M}}`,
    );
  });

  it("is a no-op without a scope", () => {
    const expr = 'sum(smartrouter_requests_total{spec="ETH1"})';
    expect(applyScope(expr, null)).toBe(expr);
    expect(applyScope(expr, undefined)).toBe(expr);
  });

  it("is a no-op for a malformed scope — never a silently different query", () => {
    const expr = "sum(smartrouter_requests_total)";
    expect(applyScope(expr, { label: "svc-name", value: "x" })).toBe(expr);
    expect(applyScope(expr, { label: "service", value: 'x" or spec="ETH1' })).toBe(expr);
    expect(applyScope(expr, { label: "service", value: "" })).toBe(expr);
  });

  /* Every real builder output must come back with the scope on each of its
     selectors and no selector left bare — a drift here silently returns
     cluster-wide numbers under a per-router view. */
  it("scopes every selector of every real builder shape", () => {
    const expressions = [
      qRequestsTotal("ETH1", "1d"),
      qRequestsTotal(undefined, "1d", "86400s"),
      qAvailability("ETH1", "1d"),
      qErrorRate("ETH1", "1d"),
      qLatencyQuantile(0.95, "ETH1", "1d"),
      qLatencySeriesExpr(0.5, "1d"),
      qPerUpstreamRpsExpr("ETH1", "1d"),
      qBlockLagByEndpoint("ETH1"),
      qChainDown(),
      qScoreExpr("composite", "ETH1"),
      // The roster's traffic-free reads. The optimizer one is a BARE metric
      // name when unfiltered — the shape a naive walker mangles.
      qOptimizerScoresByEndpoint(),
      qOptimizerScoresByEndpoint("ETH1"),
      qEndpointPolls("ok", "ETH1", "1d"),
      qEndpointPolls("failed", undefined, "1d"),
      qCsm(),
      qPresence("smartrouter_retries_total"),
    ];

    for (const expr of expressions) {
      const scoped = applyScope(expr, SCOPE);
      // Same number of selectors, each carrying the matcher exactly once.
      const braces = (scoped.match(/\{/g) ?? []).length;
      const matchers = scoped.split(M).length - 1;
      expect({ expr, braces, matchers }).toEqual({ expr, braces, matchers: braces });
      // …and no quoted string was rewritten (the `{__name__="…"}` trap).
      const quoted = scoped.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
      expect(quoted.filter((s) => s.includes("service="))).toEqual([]);
    }
  });
});

describe("scope validation", () => {
  it("accepts Prometheus label names, rejects the rest", () => {
    expect(isValidScopeLabel("service")).toBe(true);
    expect(isValidScopeLabel("_job")).toBe(true);
    expect(isValidScopeLabel("app.kubernetes.io/name")).toBe(false);
    expect(isValidScopeLabel("2fast")).toBe(false);
    expect(isValidScopeLabel("")).toBe(false);
  });

  it("rejects values that could break out of the matcher", () => {
    expect(isValidScopeValue("ethereum-router")).toBe(true);
    expect(isValidScopeValue('a" or spec="ETH1')).toBe(false);
    expect(isValidScopeValue("a\\b")).toBe(false);
    expect(isValidScopeValue("a\nb")).toBe(false);
    expect(isValidScopeValue("a{b}")).toBe(false);
    expect(isValidScopeValue("")).toBe(false);
    expect(isValidScopeValue("x".repeat(254))).toBe(false);
  });

  it("isValidScope guards both halves", () => {
    expect(isValidScope({ label: "service", value: "eth-router" })).toBe(true);
    expect(isValidScope({ label: "service", value: '"' })).toBe(false);
    expect(isValidScope(null)).toBe(false);
  });
});
