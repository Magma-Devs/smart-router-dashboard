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
import { isRecordedMetric } from "./recorded.js";

/** A Prometheus label matcher every scoped selector in a query gains. */
export interface MetricScope {
  /** Label name — the router target label (`service` by default), or the
   *  deployment label (`zone`, say) from `METRICS_SCOPE_LABEL`. */
  label: string;
  /** That label's value — a Service name like `ethereum-router`, or the
   *  deployment's value of the label. */
  value: string;
}

/** Which metric families a scope reaches. */
export interface ScopeOptions {
  /**
   * Also scope the `cache_*` families. Off for the per-router scope (the cache
   * sidecar carries no router's label — see `SCOPED_METRIC_NAMES`); on for the
   * deployment scope, whose label the collector attaches to every target the
   * deployment owns, the cache included.
   */
  cache?: boolean;
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

function isScopedMetric(name: string, opts: ScopeOptions): boolean {
  if (opts.cache && name.startsWith("cache_")) return true;
  // The recorded series keep the router label the rules group by, so the
  // per-router scope reaches them the way it reaches the raw families.
  return SCOPED_METRIC_NAMES.has(name) || SCOPED_PREFIXES.some((p) => name.startsWith(p)) || isRecordedMetric(name);
}

/** Keywords followed by a parenthesised list of LABEL names - `sum by
 *  (cache_tier)`, `on (endpoint_id)`. A name in there is never a metric.
 *  PromQL keywords are case-insensitive, so names are matched lower-cased. */
const LABEL_LIST_KEYWORDS: ReadonlySet<string> = new Set(["by", "without", "on", "ignoring", "group_left", "group_right"]);

/** Keywords that sit between two operands - `a and {...}`, `a > bool {...}`,
 *  `a * on (x) group_left {...}`. A `{` after one opens the right operand's
 *  nameless selector, never a selector of the keyword's own. */
const OPERATOR_KEYWORDS: ReadonlySet<string> = new Set(["and", "or", "unless", "atan2", "bool", "group_left", "group_right"]);

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
 *
 * Applying a second scope to the output stacks the matchers: each selector
 * then carries both, which is how the per-request router scope rides on top
 * of a deployment scope.
 */
export function applyScope(expr: string, scope?: MetricScope | null, opts: ScopeOptions = {}): string {
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

    // A comment runs to the end of the line and is copied as written: a
    // quote or a brace in it opens nothing.
    if (ch === "#") {
      const end = lineEnd(expr, i);
      out += expr.slice(i, end);
      i = end;
      continue;
    }

    // Identifier: a metric name takes the scope, a function/keyword doesn't.
    if (IDENT_START.test(ch)) {
      let j = i;
      while (j < expr.length && IDENT_CHAR.test(expr[j]!)) j++;
      const name = expr.slice(i, j);
      out += name;
      i = j;

      // PromQL reads `metric\n{...}` and `metric # note\n{...}` as one
      // selector, so the look-ahead skips every blank and comment.
      const k = skipBlank(expr, i);
      const keyword = name.toLowerCase();

      if (LABEL_LIST_KEYWORDS.has(keyword) && expr[k] === "(") {
        // A list of label names, copied as written: `cache_tier` in
        // `sum by (cache_tier)` is a label, not a `cache_*` metric.
        const end = closingOf(expr, k, "(", ")");
        out += expr.slice(i, end);
        i = end;
        continue;
      }

      // `and {...}` - the brace branch below scopes that nameless selector.
      if (OPERATOR_KEYWORDS.has(keyword)) continue;

      const braced = expr[k] === "{";
      if (isScopedMetric(name, opts)) {
        if (braced) {
          // Merge into the selector the builder already emitted.
          out += expr.slice(i, k + 1) + matcher + (nextIsBraceClose(expr, k + 1) ? "" : ",");
          i = k + 1;
        } else {
          out += `{${matcher}}`;
          continue;
        }
      } else if (braced) {
        // An unscoped metric's own selector (`cache_total_hits{zone="a"}`
        // under a router scope, say) — consume the `{` so the bare-brace
        // branch below cannot mistake it for a nameless selector.
        out += expr.slice(i, k + 1);
        i = k + 1;
      } else {
        continue;
      }
      // The rest of the matcher list, copied as written: the names in it are
      // labels, so `cache_tier="primary"` stays a matcher under the
      // deployment scope rather than reading as a `cache_*` metric.
      const end = closingOf(expr, i - 1, "{", "}");
      out += expr.slice(i, end);
      i = end;
      continue;
    }

    // A selector with no metric name in front — `{__name__="…"}`. Every other
    // PromQL construct groups with parens, so any `{` reaching here starts one
    // (a metric's own `{` is consumed by the identifier branch above, scoped
    // or not; one after `and` / `bool` / `group_left` reaches here).
    if (ch === "{") {
      out += "{";
      i++;
      out += matcher + (nextIsBraceClose(expr, i) ? "" : ",");
      const end = closingOf(expr, i - 1, "{", "}");
      out += expr.slice(i, end);
      i = end;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * The index just past the bracket that closes the one at `open` (`{` or
 * `(`), skipping string literals and comments, so a `}` or `)` inside a
 * quoted value or a `#` note doesn't end the group. The end of the
 * expression when it never closes.
 */
function closingOf(expr: string, open: number, opener: string, closer: string): number {
  let depth = 0;
  let i = open;
  while (i < expr.length) {
    const c = expr[i]!;
    if (c === "#") {
      i = lineEnd(expr, i);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < expr.length && expr[i] !== c) {
        if (expr[i] === "\\" && c !== "`") i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === opener) depth++;
    else if (c === closer && --depth === 0) return i + 1;
    i++;
  }
  return expr.length;
}

/** Whether the next character past blanks and comments closes the brace group (`{}`). */
function nextIsBraceClose(expr: string, from: number): boolean {
  return expr[skipBlank(expr, from)] === "}";
}

/** The index of the line break that ends the comment at `from`, or the end of the expression. */
function lineEnd(expr: string, from: number): number {
  const nl = expr.indexOf("\n", from);
  return nl === -1 ? expr.length : nl;
}

/** The index of the next character that is not PromQL whitespace (space, tab, CR, LF) or in a `#` comment. */
function skipBlank(expr: string, from: number): number {
  let k = from;
  while (k < expr.length) {
    const c = expr[k]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") k++;
    else if (c === "#") k = lineEnd(expr, k);
    else break;
  }
  return k;
}
