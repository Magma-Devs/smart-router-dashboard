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

  it("reaches the cache families only when asked — the deployment scope's case", () => {
    // A deployment label (`zone`) is on every target the deployment owns,
    // the cache sidecar included; a router label is not.
    const ZONE: MetricScope = { label: "zone", value: "eu-west" };
    expect(applyScope("increase(cache_total_hits[300s])", ZONE, { cache: true })).toBe(
      'increase(cache_total_hits{zone="eu-west"}[300s])',
    );
    expect(applyScope("increase(cache_total_hits[300s])", ZONE, { cache: false })).toBe(
      "increase(cache_total_hits[300s])",
    );
  });

  it("never reads a label name as a metric - the cache_tier matcher under the deployment scope", () => {
    // `cache_tier` starts like a cache metric. Read as one, it became
    // `cache_tier{zone="eu-west"}="primary"`, which the store refuses, so the
    // cache offload card read empty on every scoped deployment.
    const ZONE: MetricScope = { label: "zone", value: "eu-west" };
    const q = 'sum(increase(smartrouter_cache_success_total[300s])) / sum(increase(smartrouter_cache_requests_total{cache_tier="primary"}[300s]))';
    const scoped = 'sum(increase(smartrouter_cache_success_total{zone="eu-west"}[300s])) / sum(increase(smartrouter_cache_requests_total{zone="eu-west",cache_tier="primary"}[300s]))';
    expect(applyScope(q, ZONE, { cache: true })).toBe(scoped);
    // The router scope stacked on top: both matchers, the label still a label.
    expect(applyScope(scoped, SCOPE)).toBe(
      `sum(increase(smartrouter_cache_success_total{${M},zone="eu-west"}[300s])) / sum(increase(smartrouter_cache_requests_total{${M},zone="eu-west",cache_tier="primary"}[300s]))`,
    );
    // The same label in a nameless selector and in an unscoped metric's.
    expect(applyScope('count({__name__="smartrouter_cache_requests_total",cache_tier="secondary"})', ZONE, { cache: true })).toBe(
      'count({zone="eu-west",__name__="smartrouter_cache_requests_total",cache_tier="secondary"})',
    );
    expect(applyScope('up{cache_tier="primary"}', ZONE, { cache: true })).toBe('up{cache_tier="primary"}');
  });

  it("never reads a name in a by / without / on / ignoring / group_left list as a metric", () => {
    const ZONE: MetricScope = { label: "zone", value: "eu-west" };
    expect(applyScope("sum by (cache_tier, spec) (rate(cache_total_hits[5m]))", ZONE, { cache: true })).toBe(
      'sum by (cache_tier, spec) (rate(cache_total_hits{zone="eu-west"}[5m]))',
    );
    expect(applyScope("sum without (cache_tier) (smartrouter_cache_requests_total)", ZONE, { cache: true })).toBe(
      'sum without (cache_tier) (smartrouter_cache_requests_total{zone="eu-west"})',
    );
    expect(applyScope("a_metric * on (cache_tier) group_left (cache_tier) cache_total_hits", ZONE, { cache: true })).toBe(
      'a_metric * on (cache_tier) group_left (cache_tier) cache_total_hits{zone="eu-west"}',
    );
    expect(applyScope("rpc_endpoint_x / ignoring (rpc_endpoint_label) rpc_endpoint_y", SCOPE)).toBe(
      `rpc_endpoint_x{${M}} / ignoring (rpc_endpoint_label) rpc_endpoint_y{${M}}`,
    );
  });

  it("a brace or quote inside a matcher's value doesn't end the matcher list", () => {
    const ZONE: MetricScope = { label: "zone", value: "eu-west" };
    expect(applyScope('cache_total_hits{method=~"a}|cache_x"} + cache_total_hits', ZONE, { cache: true })).toBe(
      'cache_total_hits{zone="eu-west",method=~"a}|cache_x"} + cache_total_hits{zone="eu-west"}',
    );
    expect(applyScope('smartrouter_x{m="say \\"hi\\" }"} or smartrouter_y', SCOPE)).toBe(
      `smartrouter_x{${M},m="say \\"hi\\" }"} or smartrouter_y{${M}}`,
    );
  });

  it("reads blanks and keyword case the way PromQL does", () => {
    // Tabs, line breaks and comments separate tokens like spaces do, and
    // keywords are case-insensitive. Read any other way, `by\n(cache_tier)`
    // is no label list and `cache_tier` takes the scope as a cache metric.
    const ZONE: MetricScope = { label: "zone", value: "eu-west" };
    const Z = 'zone="eu-west"';
    const zoned = (q: string) => applyScope(q, ZONE, { cache: true });
    expect(zoned("sum by\n(cache_tier) (cache_total_hits)")).toBe(`sum by\n(cache_tier) (cache_total_hits{${Z}})`);
    expect(zoned("sum(cache_total_hits) without\t(cache_tier)")).toBe(`sum(cache_total_hits{${Z}}) without\t(cache_tier)`);
    expect(zoned("sum by # tiers\n(cache_tier) (cache_total_hits)")).toBe(`sum by # tiers\n(cache_tier) (cache_total_hits{${Z}})`);
    expect(zoned("sum BY (cache_tier) (cache_total_hits) / On (cache_tier) Group_Right (spec) cache_total_hits")).toBe(
      `sum BY (cache_tier) (cache_total_hits{${Z}}) / On (cache_tier) Group_Right (spec) cache_total_hits{${Z}}`,
    );
    // A metric and its selector across a line break or a comment are one selector.
    expect(zoned('cache_total_hits\r\n{cache_tier="primary"}')).toBe(`cache_total_hits\r\n{${Z},cache_tier="primary"}`);
    expect(applyScope('smartrouter_x # per tier\n{cache_tier="primary"}', SCOPE)).toBe(
      `smartrouter_x # per tier\n{${M},cache_tier="primary"}`,
    );
    expect(applyScope("smartrouter_x{\t}", SCOPE)).toBe(`smartrouter_x{${M}\t}`);
  });

  it("copies a comment as written - a quote or a brace in it opens nothing", () => {
    expect(applyScope("vector(0) # it's\n+ count(smartrouter_overall_health)", SCOPE)).toBe(
      `vector(0) # it's\n+ count(smartrouter_overall_health{${M}})`,
    );
    expect(applyScope("vector(0) # x{\n+ count(smartrouter_overall_health) # }", SCOPE)).toBe(
      `vector(0) # x{\n+ count(smartrouter_overall_health{${M}}) # }`,
    );
    // Nor does a `}` or `)` in a comment inside a matcher list or a label list end it.
    const ZONE: MetricScope = { label: "zone", value: "eu-west" };
    expect(applyScope('smartrouter_x{spec="a" # }\n, cache_tier="p"} + smartrouter_y', ZONE, { cache: true })).toBe(
      'smartrouter_x{zone="eu-west",spec="a" # }\n, cache_tier="p"} + smartrouter_y{zone="eu-west"}',
    );
    expect(applyScope("sum by (spec # )\n, cache_tier) (cache_total_hits)", ZONE, { cache: true })).toBe(
      'sum by (spec # )\n, cache_tier) (cache_total_hits{zone="eu-west"})',
    );
  });

  it("scopes the nameless selector after and / or / unless / atan2 / bool / group_left / group_right", () => {
    // The `{` there opens the right operand, not a selector of the keyword's own.
    for (const op of ["and", "or", "unless", "atan2", "> bool", "* on (spec) group_left", "* ignoring (spec) group_right", "AND"]) {
      expect(applyScope(`up ${op} {__name__="smartrouter_x"}`, SCOPE)).toBe(`up ${op} {${M},__name__="smartrouter_x"}`);
    }
  });

  it("leaves an unscoped metric's own selector alone", () => {
    // The `{` after a metric the scope skips is that metric's selector, not
    // a nameless `{__name__=…}` one — the trap a stacked scope walks into.
    expect(applyScope('increase(cache_total_hits{zone="a"}[300s])', SCOPE)).toBe(
      'increase(cache_total_hits{zone="a"}[300s])',
    );
    expect(applyScope('up{job="x"}', SCOPE)).toBe('up{job="x"}');
  });

  it("stacks: a second scope over the first's output puts both on every selector", () => {
    const ZONE: MetricScope = { label: "zone", value: "eu-west" };
    const once = applyScope('sum(smartrouter_requests_total{spec="ETH1"}) - sum(smartrouter_requests_success_total)', ZONE, {
      cache: true,
    });
    expect(applyScope(once, SCOPE)).toBe(
      `sum(smartrouter_requests_total{${M},zone="eu-west",spec="ETH1"}) - sum(smartrouter_requests_success_total{${M},zone="eu-west"})`,
    );
    expect(applyScope(applyScope('count({__name__="smartrouter_retries_total"})', ZONE), SCOPE)).toBe(
      `count({${M},zone="eu-west",__name__="smartrouter_retries_total"})`,
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
      qPerUpstreamRpsExpr("60s", "ETH1", "1d"),
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
