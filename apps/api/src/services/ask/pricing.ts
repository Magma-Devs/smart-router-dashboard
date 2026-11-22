import { z } from "zod";
import type { AskSettings } from "../../config.js";
import type { BedrockUsage } from "./bedrock.js";
import { AskFailure } from "./errors.js";

const rate = z.string().regex(/^[0-9]{1,12}$/);
export const askPricingSchema = z
  .object({
    version: z.string().min(1).max(100),
    model: z.string().min(1).max(256),
    region: z.string().regex(/^[a-z]{2}-[a-z]+-\d$/),
    validFrom: z.iso.datetime(),
    validUntil: z.iso.datetime(),
    source: z.url().refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname === "aws.amazon.com" &&
        url.pathname.startsWith("/bedrock/pricing") &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }),
    // Integer micro-USD per million tokens; never floating-point currency.
    input: rate,
    output: rate,
    cacheRead: rate,
    cacheWrite5m: rate,
    cacheWrite1h: rate,
  })
  .strict()
  .refine((p) => Date.parse(p.validUntil) > Date.parse(p.validFrom))
  .refine((p) => BigInt(p.output) > 0n && BigInt(p.input) > 0n);
export type AskPricing = z.infer<typeof askPricingSchema>;
export interface AskBillingSettings {
  pricing: AskPricing;
  monthlyLimitMicroUsd: bigint;
  counter: { mode: "runtime" | "mantle"; model: string };
}

/** No guessed defaults for a changing model price or token-counter mapping.
 * The runtime stays unavailable until an operator supplies a dated rate card. */
export function readAskBillingSettings(
  settings: AskSettings,
  env: NodeJS.ProcessEnv = process.env,
): AskBillingSettings | null {
  try {
    const pricing = askPricingSchema.parse(JSON.parse(env.ASK_DATA_PRICING_JSON ?? ""));
    if (pricing.model !== settings.bedrockModel || pricing.region !== settings.bedrockRegion)
      return null;
    const mode = z.enum(["runtime", "mantle"]).parse(env.ASK_DATA_TOKEN_COUNTER);
    const model = env.ASK_DATA_TOKEN_COUNTER_MODEL?.trim() ?? settings.bedrockModel;
    const base = (id: string) => id.replace(/^(global|us|eu|apac)\./, "");
    if (
      !/^anthropic\.[A-Za-z0-9.:-]{1,200}$/.test(base(model)) ||
      base(model) !== base(settings.bedrockModel)
    )
      return null;
    if (mode === "mantle" && model !== base(model)) return null;
    const limit = env.ASK_DATA_MONTHLY_LIMIT_MICRO_USD ?? "10000000";
    if (!/^[0-9]{1,10}$/.test(limit)) return null;
    return { pricing, counter: { mode, model }, monthlyLimitMicroUsd: BigInt(limit) };
  } catch {
    return null;
  }
}
export function assertCurrentPricing(pricing: AskPricing, now = new Date()): void {
  if (
    now.getTime() < Date.parse(pricing.validFrom) ||
    now.getTime() >= Date.parse(pricing.validUntil)
  )
    throw new AskFailure("ASK_UNAVAILABLE");
}
/** Input tokens Bedrock adds beyond the request's own text: Anthropic's tool-use
 * system prompt and the role and block framing of each message. */
export const ASK_INPUT_TOKEN_OVERHEAD = 2048;

/** A token covers at least one byte of the text it encodes, so the UTF-8 length
 * of the serialized request bounds its own tokens; JSON quoting only adds bytes. */
export function inputTokenBound(input: unknown): number {
  return Buffer.byteLength(JSON.stringify(input)) + ASK_INPUT_TOKEN_OVERHEAD;
}

const ceilMillion = (n: bigint) => (n + 999_999n) / 1_000_000n;
export function maximumStepCost(pricing: AskPricing, input: number, output: number): bigint {
  if (
    !Number.isSafeInteger(input) ||
    input < 0 ||
    input > 2_000_000 ||
    !Number.isSafeInteger(output) ||
    output < 1 ||
    output > 100_000
  )
    throw new AskFailure("ASK_LIMIT_REACHED", 422);
  const inputRate = [pricing.input, pricing.cacheRead, pricing.cacheWrite5m, pricing.cacheWrite1h]
    .map(BigInt)
    .reduce((a, b) => (a > b ? a : b));
  return ceilMillion(BigInt(input) * inputRate + BigInt(output) * BigInt(pricing.output));
}

/** AWS reports non-cached input separately from cache reads and writes. Cache
 * writes with no verifiable TTL breakdown remain uncertain, never zero-cost. */
export function observedStepCost(pricing: AskPricing, usage: BedrockUsage): bigint | null {
  const counts = [
    usage.inputTokens,
    usage.outputTokens,
    usage.totalTokens,
    usage.cacheReadInputTokens ?? 0,
    usage.cacheWriteInputTokens ?? 0,
  ];
  if (counts.some((n) => !Number.isSafeInteger(n) || n < 0)) return null;
  const writes = usage.cacheWriteInputTokens ?? 0;
  let cacheCost = 0n;
  if (writes > 0) {
    if (
      !usage.cacheDetails?.length ||
      usage.cacheDetails.reduce((n, d) => n + d.inputTokens, 0) !== writes
    )
      return null;
    for (const entry of usage.cacheDetails)
      cacheCost +=
        BigInt(entry.inputTokens) *
        BigInt(entry.ttl === "1h" ? pricing.cacheWrite1h : pricing.cacheWrite5m);
  }
  return ceilMillion(
    BigInt(usage.inputTokens) * BigInt(pricing.input) +
      BigInt(usage.outputTokens) * BigInt(pricing.output) +
      BigInt(usage.cacheReadInputTokens ?? 0) * BigInt(pricing.cacheRead) +
      cacheCost,
  );
}
