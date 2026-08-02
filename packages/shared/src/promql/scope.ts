/**
 * Router scoping — restrict every query to ONE router deployment.
 *
 * The router labels its series with the CHAIN (`spec`), not with itself, so
 * two routers serving the same chain (a staging + production pair on one
 * `network`, say) sum into a single set of numbers. Prometheus can still tell
 * them apart: each router is its own scrape target, so the collector attaches
 * a per-target label (`service` / `job` under the Prometheus Operator, whose
 * value is the router's Service name). Selecting on that label is the only
 * way to split them.
 *
 * Rather than thread an extra argument through all ~40 query builders, the
 * scope is injected into the finished PromQL: every vector selector in the
 * expression gains the matcher. `applyScope` is a small PromQL-aware walker
 * (not a regex) because the naive version corrupts two real shapes — metric
 * names quoted inside `{__name__="…"}`, and selectors that already carry
 * labels.
 */

import {
  ENDPOINT_METRICS,
  OPTIMIZER_METRICS,
  OPTIONAL_METRICS,
  ROUTER_METRICS,
} from "../constants/metrics.js";

/** Which router a query is restricted to, as a Prometheus label matcher. */
export interface MetricScope {
  /** Target label carrying the router identity (`service` by default). */
  label: string;
  /** That label's value — a Service name like `ethereum-router`. */
  value: string;
}

/**
 * Metric names that carry the scope. Built from the catalog, plus a prefix
 * rule so a family added to `OPTIONAL_METRICS` later is covered without
 * touching this file.
 *
 * `cache_*` is deliberately NOT here: the relay cache is a separate sidecar
 * process with its own scrape target, shared by every router, so it carries
 * no router's label. Scoping it would report a zeroed cache rather than an
 * unattributable one — the cache panels stay cluster-wide under a scope.
 */
const SCOPED_METRIC_NAMES: ReadonlySet<string> = new Set(
  [
    ...Object.values(ROUTER_METRICS),
    ...Object.values(ENDPOINT_METRICS),
    ...Object.values(OPTIMIZER_METRICS),
    ...Object.values(OPTIONAL_METRICS),
  ].filter((name) => !name.startsWith("cache_")),
);

const SCOPED_PREFIXES = ["smartrouter_", "rpc_endpoint_", "rpc_optimizer_"] as const;

function isScopedMetric(name: string): boolean {
  return SCOPED_METRIC_NAMES.has(name) || SCOPED_PREFIXES.some((p) => name.startsWith(p));
}

const IDENT_START = /[a-zA-Z_:]/;
const IDENT_CHAR = /[a-zA-Z0-9_:]/;

/** A label name Prometheus accepts — guards the matcher we splice in. */
export function isValidScopeLabel(label: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(label);
}

/**
 * A scope value safe to embed in a quoted PromQL matcher. Rejecting quotes,
 * backslashes and newlines outright (rather than escaping them) keeps the
 * injected fragment unambiguous — real values are Kubernetes object names.
 */
export function isValidScopeValue(value: string): boolean {
  return value.length > 0 && value.length <= 253 && !/["'`\\\n\r{}]/.test(value);
}

/** A scope both fields of which are safe to splice into a query. */
export function isValidScope(scope: MetricScope | null | undefined): scope is MetricScope {
  return !!scope && isValidScopeLabel(scope.label) && isValidScopeValue(scope.value);
}

/**
 * Add `scope` to every scoped vector selector in `expr`.
 *
 * ```
 * sum(rate(smartrouter_requests_total{spec="ETH1"}[5m]))
 *   → sum(rate(smartrouter_requests_total{service="eth-router",spec="ETH1"}[5m]))
 * count({__name__="smartrouter_retries_total"})
 *   → count({service="eth-router",__name__="smartrouter_retries_total"})
 * ```
 *
 * Returns `expr` untouched when the scope is absent or malformed — a bad
 * scope must never silently become a different query.
 */
export function applyScope(expr: string, scope?: MetricScope | null): string {
  if (!isValidScope(scope)) return expr;
  const matcher = `${scope.label}="${scope.value}"`;

  let out = "";
  let i = 0;

  while (i < expr.length) {
    const ch = expr[i]!;

    // String literal — copied verbatim. Metric names live inside these in the
    // `{__name__="…"}` presence probes and must NOT be rewritten.
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i++;
      while (i < expr.length) {
        const c = expr[i]!;
        out += c;
        i++;
        if (c === "\\" && quote !== "`" && i < expr.length) {
          out += expr[i]!;
          i++;
          continue;
        }
        if (c === quote) break;
      }
      continue;
    }

    // Identifier: a metric name takes the scope, a function/keyword doesn't.
    if (IDENT_START.test(ch)) {
      let j = i;
      while (j < expr.length && IDENT_CHAR.test(expr[j]!)) j++;
      const name = expr.slice(i, j);
      out += name;
      i = j;

      if (isScopedMetric(name)) {
        let k = i;
        while (k < expr.length && expr[k] === " ") k++;
        if (expr[k] === "{") {
          // Merge into the selector the builder already emitted.
          out += expr.slice(i, k + 1) + matcher + (nextIsBraceClose(expr, k + 1) ? "" : ",");
          i = k + 1;
        } else {
          out += `{${matcher}}`;
        }
      }
      continue;
    }

    // A selector with no metric name in front — `{__name__="…"}`. Every other
    // PromQL construct groups with parens, so any `{` reaching here starts one
    // (a metric's own `{` is consumed by the identifier branch above).
    if (ch === "{") {
      out += "{";
      i++;
      out += matcher + (nextIsBraceClose(expr, i) ? "" : ",");
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/** Whether the next non-space character closes the brace group (`{}`). */
function nextIsBraceClose(expr: string, from: number): boolean {
  let k = from;
  while (k < expr.length && expr[k] === " ") k++;
  return expr[k] === "}";
}
