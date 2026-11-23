import type { AskRunProgress, AskRunRead, AskRunStep } from "@sr/shared";

/** The fleet's recorded series, in the words a person reads them by. */
const RECORDED: Record<string, string> = {
  "smartrouter_final_requests:count1m": "request counts",
  "smartrouter_final_failures:count1m": "failure counts",
  "smartrouter_transactions:count1m": "transaction counts",
  "smartrouter_warn_error_lines:count1m": "warning and error counts",
  "smartrouter_log_lines:count1m": "log line counts",
  "smartrouter_log_bytes:sum1m": "log volume",
  "smartrouter_host_log_lines:count1m": "host log counts",
  "smartrouter_envoy_responses:count1m": "gateway response codes",
};

const METRIC = /[A-Za-z_:][A-Za-z0-9_:]*/g;
// Words PromQL spells like a metric name but which name none.
const PROMQL_WORDS = new Set([
  "sum",
  "avg",
  "min",
  "max",
  "count",
  "count_values",
  "stddev",
  "stdvar",
  "topk",
  "bottomk",
  "quantile",
  "group",
  "by",
  "without",
  "on",
  "ignoring",
  "group_left",
  "group_right",
  "bool",
  "and",
  "or",
  "unless",
  "offset",
  "rate",
  "irate",
  "increase",
  "delta",
  "idelta",
  "deriv",
  "histogram_quantile",
  "sum_over_time",
  "avg_over_time",
  "max_over_time",
  "min_over_time",
  "count_over_time",
  "last_over_time",
  "quantile_over_time",
  "absent",
  "absent_over_time",
  "label_replace",
  "label_join",
  "vector",
  "scalar",
  "time",
  "clamp_min",
  "clamp_max",
  "abs",
  "round",
  "ceil",
  "floor",
  "sort",
  "sort_desc",
  "changes",
  "resets",
  "inf",
  "nan",
  "le",
]);

/** The metric names a PromQL query selects, label matchers and strings aside. */
function metricNames(query: string): string[] {
  const outside = query
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, '""')
    .replace(/\{[^}]*\}/g, "{}")
    .replace(/\[[^\]]*\]/g, "[]")
    .replace(/\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/gi, "")
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|m|h|d|w|y)?\b/g, "0");
  const names: string[] = [];
  for (const match of outside.matchAll(METRIC)) {
    const name = match[0];
    const next = outside.slice((match.index ?? 0) + name.length).trimStart();
    if (PROMQL_WORDS.has(name.toLowerCase())) continue;
    // A function is followed by "("; a metric name never is.
    if (next.startsWith("(")) continue;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function metricLabel(query: unknown): string {
  if (typeof query !== "string") return "metrics";
  const names = metricNames(query);
  const recorded = names.map((name) => RECORDED[name]).filter((label) => label !== undefined);
  if (recorded.length) return [...new Set(recorded)].join(" and ");
  const name = names.find((candidate) => candidate.length <= 80);
  return name ? `metric ${name}` : "metrics";
}

function logLabel(query: unknown): string {
  if (typeof query !== "string") return "log lines";
  if (/relay_end\s*=\s*"1"/.test(query)) return "request log lines";
  if (/log_level\s*=~?\s*"/.test(query)) return "warning and error lines";
  if (/source\s*=\s*"(journal|auditd|kube-api-audit)"/.test(query) || /node\s*!?=/.test(query))
    return "host log lines";
  if (/component\s*=\s*"router"/.test(query)) return "router log lines";
  return "log lines";
}

/**
 * Names one recorded read for a person. Written here from the operation and
 * the identifiers the query selects; the query's other text, the model's words
 * and the data returned never reach the label.
 */
export function readLabel(operationId: string, parameters: Record<string, unknown>): string {
  switch (operationId) {
    case "metrics.query":
    case "metrics.query_range": {
      const label = metricLabel(parameters.query);
      return label.charAt(0).toUpperCase() + label.slice(1);
    }
    case "metrics.series":
    case "metrics.labels":
    case "metrics.label_values":
    case "metrics.metadata":
      return "Which metrics exist";
    case "logs.query":
    case "logs.query_range": {
      const label = logLabel(parameters.query);
      return label.charAt(0).toUpperCase() + label.slice(1);
    }
    case "logs.series":
    case "logs.labels":
    case "logs.label_values":
      return "Which logs exist";
    case "status.chain_events":
      return "Provider status";
    default:
      return "Data";
  }
}

export interface ProgressStep {
  state: "reserved" | "dispatched" | "uncertain" | "settled" | "released";
  createdAt: Date;
  completedAt: Date | null;
}
export interface ProgressRead {
  operationId: string;
  parameters: Record<string, unknown>;
  ok: "success" | "unavailable";
  createdAt: Date;
}

/** The step a running run is on, from its model turns and reads, oldest first,
 * and the answer's summary while the model writes the rest. */
export function runProgress(
  steps: ProgressStep[],
  reads: ProgressRead[],
  draft?: string | null,
): AskRunProgress {
  const wire: AskRunRead[] = reads.map((read) => ({
    label: readLabel(read.operationId, read.parameters),
    ok: read.ok === "success",
  }));
  const last = steps.at(-1);
  let step: AskRunStep;
  if (!last) step = "starting";
  else if (!["settled", "released"].includes(last.state))
    step = reads.length ? "reviewing" : "planning";
  else {
    const ended = last.completedAt ?? last.createdAt;
    step = reads.some((read) => read.createdAt >= ended) ? "reading" : "working";
  }
  return { step, reads: wire, ...(draft ? { draft } : {}) };
}
