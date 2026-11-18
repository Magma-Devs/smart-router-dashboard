import { z } from "zod";
import { RECORDED_OUTCOMES } from "../error-requests.js";
import { RECORDED_TX } from "../transactions-over-time.js";

export const requestSummaryInput = z
  .object({
    measure: z.enum(["requests", "transactions"]).optional(),
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

/** Same recorded outcome families as the dashboard. One bounded window and
 * the same labels for both counts; no guessed metric names or zero fallback. */
export function requestSummaryQueries(
  input: z.infer<typeof requestSummaryInput>,
  defaults: { start: number; end: number },
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
  const selector = input.chain ? `{chain=${JSON.stringify(input.chain.toLowerCase())}}` : "";
  return {
    start,
    end,
    counts: [
      ...(input.measure === "transactions"
        ? [
            {
              name: "transactions",
              query: `sum by (chain, outcome, tx_status, tx_refused, api_interface) (sum_over_time(${RECORDED_TX}${selector}[${seconds}s]))`,
            },
          ]
        : [
            {
              name: "requests",
              query: `sum by (chain) (sum_over_time(${RECORDED_OUTCOMES.requests}${selector}[${seconds}s]))`,
            },
            {
              name: "failures",
              query: `sum by (chain) (sum_over_time(${RECORDED_OUTCOMES.failures}${selector}[${seconds}s]))`,
            },
          ]),
    ],
  };
}
