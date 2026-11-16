import { describe, expect, it } from "vitest";
import { readAskSettings } from "../config.js";
import {
  assertCurrentPricing,
  maximumStepCost,
  observedStepCost,
  readAskBillingSettings,
} from "../services/ask/pricing.js";

const pricing = {
  version: "synthetic-v1",
  model: "global.anthropic.fixture",
  region: "us-east-1",
  validFrom: "2026-01-01T00:00:00Z",
  validUntil: "2027-01-01T00:00:00Z",
  source: "https://aws.amazon.com/bedrock/pricing/",
  input: "3000000",
  output: "15000000",
  cacheRead: "300000",
  cacheWrite5m: "3750000",
  cacheWrite1h: "6000000",
};
const settings = readAskSettings({ ASK_DATA_BEDROCK_MODEL: pricing.model });
const env = {
  ASK_DATA_PRICING_JSON: JSON.stringify(pricing),
  ASK_DATA_TOKEN_COUNTER: "mantle",
  ASK_DATA_TOKEN_COUNTER_MODEL: "anthropic.fixture",
};
describe("dated, exact-integer pricing", () => {
  it("requires an explicit matching model/region/counter and defaults to the shared $10 cap", () => {
    expect(readAskBillingSettings(settings, env)).toMatchObject({
      monthlyLimitMicroUsd: 10_000_000n,
      counter: { mode: "mantle", model: "anthropic.fixture" },
    });
    expect(readAskBillingSettings(settings, {})).toBeNull();
    expect(
      readAskBillingSettings(settings, { ...env, ASK_DATA_TOKEN_COUNTER_MODEL: "anthropic.other" }),
    ).toBeNull();
    expect(
      readAskBillingSettings(settings, {
        ...env,
        ASK_DATA_PRICING_JSON: JSON.stringify({ ...pricing, region: "eu-west-1" }),
      }),
    ).toBeNull();
    expect(
      readAskBillingSettings(settings, { ...env, ASK_DATA_MONTHLY_LIMIT_MICRO_USD: "10.5" }),
    ).toBeNull();
  });
  it("rejects malformed, guessed, mismatched and secret-bearing price sources", () => {
    for (const patch of [
      { input: "3.5" },
      { output: "-1" },
      { source: "https://aws.amazon.com/bedrock/pricing/?key=secret" },
      { source: "https://example.com/prices" },
      { validUntil: pricing.validFrom },
    ])
      expect(
        readAskBillingSettings(settings, {
          ...env,
          ASK_DATA_PRICING_JSON: JSON.stringify({ ...pricing, ...patch }),
        }),
      ).toBeNull();
    expect(() => assertCurrentPricing(pricing, new Date("2027-01-01"))).toThrow();
    expect(() => assertCurrentPricing(pricing, new Date("2025-12-31"))).toThrow();
  });
  it("reserves the largest input/cache rate and maximum output, rounding upward only once", () => {
    expect(maximumStepCost(pricing, 100, 10)).toBe(750n);
    expect(
      observedStepCost(pricing, {
        inputTokens: 1,
        outputTokens: 0,
        totalTokens: 1,
        cacheReadInputTokens: 1,
      }),
    ).toBe(4n);
    expect(() => maximumStepCost(pricing, Number.NaN, 10)).toThrow();
    expect(() => maximumStepCost(pricing, 1, 0)).toThrow();
  });
  it("keeps incomplete cache usage unresolved and accepts verified zero usage", () => {
    expect(observedStepCost(pricing, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })).toBe(0n);
    expect(
      observedStepCost(pricing, {
        inputTokens: 10,
        outputTokens: 1,
        totalTokens: 11,
        cacheWriteInputTokens: 5,
      }),
    ).toBeNull();
    expect(
      observedStepCost(pricing, {
        inputTokens: 10,
        outputTokens: 1,
        totalTokens: 11,
        cacheWriteInputTokens: 5,
        cacheDetails: [{ ttl: "1h", inputTokens: 4 }],
      }),
    ).toBeNull();
  });
});
