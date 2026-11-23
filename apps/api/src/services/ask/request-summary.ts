import { z } from "zod";
import { RECORDED_OUTCOMES } from "../error-requests.js";
import { FAILED_PIPELINE, PARSED_PIPELINE, RELAY_END } from "../relay-end.js";
import { TX_EVENT_FILTER } from "../transactions.js";
import { LOG_PIPELINE, RECORDED_TX } from "../transactions-over-time.js";
import { RECORDED, RECORDED_INTERVAL_SECONDS } from "@sr/shared";

/** The longest window a count from the recorded series or the provider counters may cover. */
export const MAX_COUNT_SECONDS = 30 * 86_400;
/** The longest window a raw read may cover: log lines, and the per-customer counters. */
export const MAX_RAW_SECONDS = 86_400;
/** What a refused window tells the model, which then reads again. */
export const WINDOW_REFUSED = `The window must be ordered, end at most 5 minutes from now and span at most ${MAX_COUNT_SECONDS / 86_400} days for counts, ${MAX_RAW_SECONDS / 3600} hours for per-customer counts and request samples. Read again with a shorter window, or several consecutive ones.`;
/** How far back the fleet's stores answer (devops-magmadevs: smart-router-fleet-loki
 * `retention_period`, smart-router-fleet-mimir's query contract). */
export const LOG_RETENTION_DAYS = 45;
export const METRICS_RETENTION_DAYS = 90;

/** The per-provider counter of node-error replies: an answered relay whose reply is an RPC error. */
export const PROVIDER_NODE_ERRORS = "smartrouter_node_errors_total";

/** An ISO 8601 time, which the server turns into Unix seconds; one without a zone is UTC. */
const isoTime = z.iso.datetime({ offset: true, local: true });

/** The router's log lines at warn or error, counted once a minute by the fleet's Loki ruler. */
export const RECORDED_WARN_ERROR = "smartrouter_warn_error_lines:count1m";

/** How many of the most frequent warn and error messages one summary returns. */
export const TOP_MESSAGES = 30;

/**
 * The router's per-customer counters: each client request once, with its final
 * outcome, under the caller's `customer-id` header (labels spec, apiInterface,
 * customer, method). Prometheus counters, so they have no log-line fallback.
 */
export const CUSTOMER_COUNTERS = {
  requests: "smartrouter_customer_requests_total",
  failures: "smartrouter_customer_requests_failed_total",
} as const;

/** The customer-id the hub's serving probes send: Magma's own traffic, never the reader's customer. */
export const SERVING_PROBE_CUSTOMER = "magma-serving-probe";

/** How many customers, and customer-method pairs, one customers summary returns. */
export const TOP_CUSTOMERS = 50;
export const TOP_CUSTOMER_METHODS = 30;

/** A customer-id value the summary may select by: plain id characters, the router's own 128-byte bound. */
const CUSTOMER_ID = /^[A-Za-z0-9._:@+=/-]{1,128}$/;
/** A method-name prefix: letters, digits, `_` and `/` only, so it is literal inside a regex matcher. */
const METHOD_PREFIX = /^[A-Za-z0-9_/]{1,64}$/;

export const requestSummaryInput = z
  .object({
    measure: z.enum(["requests", "transactions", "errors", "customers", "providers"]).optional(),
    sourceId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
      .optional(),
    chain: z
      .string()
      .regex(/^[A-Za-z0-9_-]{2,32}$/)
      .optional(),
    customer: z.string().regex(CUSTOMER_ID).optional(),
    methodPrefixes: z.array(z.string().regex(METHOD_PREFIX)).min(1).max(8).optional(),
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().nonnegative().optional(),
    from: isoTime.optional(),
    to: isoTime.optional(),
  })
  .strict()
  .refine((input) => !(input.start !== undefined && input.from !== undefined), {
    message: "give start or from, not both",
  })
  .refine((input) => !(input.end !== undefined && input.to !== undefined), {
    message: "give end or to, not both",
  })
  .refine((input) => {
    const { start, end } = windowInput(input);
    return start === undefined || end === undefined || start < end;
  })
  .refine(
    (input) =>
      input.measure === "customers" ||
      (input.customer === undefined && input.methodPrefixes === undefined),
    { message: "customer and methodPrefixes narrow measure=customers only" },
  );

/** The window a tool input names, in Unix seconds: `start`/`end`, or `from`/`to` converted. */
export function windowInput(input: { start?: number; end?: number; from?: string; to?: string }): {
  start?: number;
  end?: number;
} {
  const seconds = (iso?: string) =>
    iso === undefined
      ? undefined
      : Math.floor(Date.parse(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`) / 1000);
  return { start: input.start ?? seconds(input.from), end: input.end ?? seconds(input.to) };
}

/** One recorded count, and the same count over the raw log lines for when the series has nothing. */
export interface SummaryCount {
  name: string;
  query: string;
  raw?: string;
}

/**
 * Same recorded families as the dashboard. One bounded window and the same
 * labels for every count; no guessed metric names or zero fallback. Where
 * `customerId` is known, each count also carries `raw`: the same count over
 * this customer's router lines in Loki, with the recorded rule's own filters,
 * for a window the series has nothing for.
 */
export function requestSummaryQueries(
  input: z.infer<typeof requestSummaryInput>,
  defaults: { start: number; end: number },
  customerId?: string,
) {
  const named = windowInput(input);
  const end = named.end ?? defaults.end;
  const start =
    named.start ??
    (named.end === undefined ? defaults.start : end - (defaults.end - defaults.start));
  const seconds = end - start;
  if (
    !Number.isInteger(seconds) ||
    seconds < 1 ||
    seconds > (input.measure === "customers" ? MAX_RAW_SECONDS : MAX_COUNT_SECONDS) ||
    end > Math.floor(Date.now() / 1000) + 300
  )
    return null;
  const chain = input.chain?.toLowerCase();
  const selector = chain ? `{chain=${JSON.stringify(chain)}}` : "";
  // The customer's router streams, as router_recent_requests selects them.
  const lines =
    customerId && /^[a-z0-9][a-z0-9-]{0,63}$/.test(customerId)
      ? `{${[
          `service_name=~${JSON.stringify(`${customerId}-.*`)}`,
          'component="router"',
          ...(chain ? [`chain=${JSON.stringify(chain)}`] : []),
        ].join(",")}}`
      : null;
  // A raw fallback scans log lines, so a window past a day offers none.
  const raw = (query: (lines: string) => string) =>
    lines && seconds <= MAX_RAW_SECONDS ? { raw: query(lines) } : {};
  const range = `[${seconds}s]`;
  if (input.measure === "customers") return { start, end, counts: customerCounts(input, range) };
  if (input.measure === "providers") return { start, end, counts: providerCounts(input, range) };
  const counts: SummaryCount[] =
    input.measure === "transactions"
      ? [
          {
            name: "transactions",
            query: `sum by (chain, outcome, tx_status, tx_refused, api_interface) (sum_over_time(${RECORDED_TX}${selector}${range}))`,
            ...raw(
              (s) =>
                `sum by (chain, outcome, tx_status, tx_refused, api_interface) (count_over_time(${s} ${TX_EVENT_FILTER} ${LOG_PIPELINE} ${range}))`,
            ),
          },
        ]
      : input.measure === "errors"
        ? [
            {
              name: "errors",
              query: `sum by (chain, level) (sum_over_time(${RECORDED_WARN_ERROR}${selector}${range}))`,
              ...raw(
                (s) =>
                  `sum by (chain, level) (count_over_time(${s} | level=~"warn|error" ${range}))`,
              ),
            },
            {
              name: "error_messages",
              query: `topk(${TOP_MESSAGES}, sum by (chain, level, message) (sum_over_time(${RECORDED_WARN_ERROR}${selector}${range})))`,
              ...raw(
                (s) =>
                  `topk(${TOP_MESSAGES}, sum by (chain, level, message) (count_over_time(${s} | level=~"warn|error" | json message="message" | __error__="" ${range})))`,
              ),
            },
          ]
        : [
            {
              name: "requests",
              query: `sum by (chain) (sum_over_time(${RECORDED_OUTCOMES.requests}${selector}${range}))`,
              ...raw(
                (s) =>
                  `sum by (chain) (count_over_time(${s} |= \`${RELAY_END}\` ${PARSED_PIPELINE} | selection!="subscription" ${range}))`,
              ),
            },
            {
              name: "failures",
              query: `sum by (chain) (sum_over_time(${RECORDED_OUTCOMES.failures}${selector}${range}))`,
              ...raw((s) => `sum by (chain) (count_over_time(${s} ${FAILED_PIPELINE} ${range}))`),
            },
          ];
  return { start, end, counts };
}

/**
 * Relays, successful relays and node-error replies per chain and provider. The
 * relay pair is the store's recorded series, one sample a minute (a window's
 * total is its sum times the interval), so a 30-day read stays small; the
 * node-error counter has no recorded series and is read raw. `Cached` is the
 * router's cache, not a provider.
 */
function providerCounts(input: z.infer<typeof requestSummaryInput>, range: string): SummaryCount[] {
  const matchers = [
    'provider_address!="Cached"',
    ...(input.chain ? [`spec=${JSON.stringify(input.chain.toUpperCase())}`] : []),
  ];
  const selector = `{${matchers.join(",")}}`;
  const recorded = (series: string) =>
    `round(sum by (spec, provider_address) (sum_over_time(${series}${selector}${range})) * ${RECORDED_INTERVAL_SECONDS})`;
  return [
    { name: "provider_relays", query: recorded(RECORDED.requestsByProvider) },
    { name: "provider_successes", query: recorded(RECORDED.successByProvider) },
    {
      name: "provider_node_errors",
      query: `round(sum by (spec, provider_address) (increase(${PROVIDER_NODE_ERRORS}${selector}${range})))`,
    },
  ];
}

/**
 * Requests and failures per customer, and requests per customer and method,
 * from the router's per-customer counters. The chain is the spec's id, which
 * these counters carry upper-cased where the recorded series carry it lower-cased.
 */
function customerCounts(input: z.infer<typeof requestSummaryInput>, range: string): SummaryCount[] {
  const matchers = [
    `customer!=${JSON.stringify(SERVING_PROBE_CUSTOMER)}`,
    ...(input.chain ? [`spec=${JSON.stringify(input.chain.toUpperCase())}`] : []),
    ...(input.customer ? [`customer=${JSON.stringify(input.customer)}`] : []),
    ...(input.methodPrefixes
      ? [`method=~${JSON.stringify(`(?:${input.methodPrefixes.join("|")}).*`)}`]
      : []),
  ];
  const selector = `{${matchers.join(",")}}`;
  const total = (counter: string, by: string, top: number) =>
    `topk(${top}, round(sum by (${by}) (increase(${counter}${selector}${range}))))`;
  return [
    {
      name: "customer_requests",
      query: total(CUSTOMER_COUNTERS.requests, "customer", TOP_CUSTOMERS),
    },
    {
      name: "customer_failures",
      query: total(CUSTOMER_COUNTERS.failures, "customer", TOP_CUSTOMERS),
    },
    {
      name: "customer_methods",
      query: total(CUSTOMER_COUNTERS.requests, "customer, method", TOP_CUSTOMER_METHODS),
    },
  ];
}
