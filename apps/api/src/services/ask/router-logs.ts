import { z } from "zod";
import { RELAY_END } from "../relay-end.js";
import { MAX_RAW_SECONDS, requestSummaryInput, requestSummaryQueries } from "./request-summary.js";

export const routerLogsInput = z
  .object({
    sourceId: requestSummaryInput.shape.sourceId,
    chain: requestSummaryInput.shape.chain,
    start: requestSummaryInput.shape.start,
    end: requestSummaryInput.shape.end,
    from: requestSummaryInput.shape.from,
    to: requestSummaryInput.shape.to,
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

/** The managed fleet's own stream labels and request event, as the dashboard
 * reads them. Sample recent requests; never claim that a sample counts errors
 * or establishes the absence of errors across the whole window. */
export function routerLogQuery(
  customerId: string,
  input: z.infer<typeof routerLogsInput>,
  defaults: { start: number; end: number },
) {
  const window = requestSummaryQueries(input, defaults);
  // Raw lines are scanned, so a sample reads at most a day of them.
  if (
    !window ||
    window.end - window.start > MAX_RAW_SECONDS ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(customerId)
  )
    return null;
  const matchers = [`service_name=~${JSON.stringify(`${customerId}-.*`)}`];
  if (input.chain) matchers.push(`chain=${JSON.stringify(input.chain.toLowerCase())}`);
  return {
    query: `{${matchers.join(",")}} |= ${JSON.stringify(RELAY_END)}`,
    start: window.start,
    end: window.end,
    limit: input.limit ?? 20,
    direction: "backward" as const,
  };
}
