import { z } from "zod";
import { RECORDED_OUTCOMES } from "../error-requests.js";
import { FAILED_PIPELINE, PARSED_PIPELINE, RELAY_END } from "../relay-end.js";
import { TX_EVENT_FILTER } from "../transactions.js";
import { LOG_PIPELINE, RECORDED_TX } from "../transactions-over-time.js";

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
    measure: z.enum(["requests", "transactions", "errors", "customers"]).optional(),
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
  })
  .strict()
  .refine(
    (input) => input.start === undefined || input.end === undefined || input.start < input.end,
  )
  .refine(
    (input) =>
      input.measure === "customers" ||
      (input.customer === undefined && input.methodPrefixes === undefined),
    { message: "customer and methodPrefixes narrow measure=customers only" },
  );

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
  const end = input.end ?? defaults.end;
  const start =
    input.start ??
    (input.end === undefined ? defaults.start : end - (defaults.end - defaults.start));
  const seconds = end - start;
  if (
    !Number.isInteger(seconds) ||
    seconds < 1 ||
    seconds > 86400 ||
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
  const raw = (query: (lines: string) => string) => (lines ? { raw: query(lines) } : {});
  const range = `[${seconds}s]`;
  if (input.measure === "customers") return { start, end, counts: customerCounts(input, range) };
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
