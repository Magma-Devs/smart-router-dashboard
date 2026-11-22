import { z } from "zod";
import { RECORDED_OUTCOMES } from "../error-requests.js";
import { FAILED_PIPELINE, PARSED_PIPELINE, RELAY_END } from "../relay-end.js";
import { TX_EVENT_FILTER } from "../transactions.js";
import { LOG_PIPELINE, RECORDED_TX } from "../transactions-over-time.js";

/** The router's log lines at warn or error, counted once a minute by the fleet's Loki ruler. */
export const RECORDED_WARN_ERROR = "smartrouter_warn_error_lines:count1m";

/** How many of the most frequent warn and error messages one summary returns. */
export const TOP_MESSAGES = 30;

export const requestSummaryInput = z
  .object({
    measure: z.enum(["requests", "transactions", "errors"]).optional(),
    sourceId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
      .optional(),
    chain: z
      .string()
      .regex(/^[A-Za-z0-9_-]{2,32}$/)
      .optional(),
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (input) => input.start === undefined || input.end === undefined || input.start < input.end,
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
              ...raw((s) => `sum by (chain, level) (count_over_time(${s} | level=~"warn|error" ${range}))`),
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
