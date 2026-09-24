import { describe, expect, it } from "vitest";
import { composeStory, detectEpisodes } from "../services/incidents.js";

const NOW = 1_787_990_000;
const row = (spec: string, values: [number, string][]) => ({ metric: { spec }, values });

describe("detectEpisodes — bursts of final failures", () => {
  it("merges contiguous over-floor buckets into one episode and drops quiet ones", () => {
    const eps = detectEpisodes(
      [row("SOLANAT", [
        [NOW - 3600, "2"],          // under the floor — noise
        [NOW - 3000, "40"],
        [NOW - 2700, "60"],         // contiguous → same episode
        [NOW - 300, "10"],          // 40 min later → its own episode
      ])],
      NOW,
    );
    expect(eps).toHaveLength(2);
    expect(eps[0]).toMatchObject({ spec: "SOLANAT", failures: 100, startUnix: NOW - 3300, endUnix: NOW - 2700 });
    expect(eps[1]).toMatchObject({ failures: 10 });
  });

  it("keeps the biggest episodes when a day has many", () => {
    const values: [number, string][] = [...Array(10)].map((_, i) => [NOW - i * 7200, String(5 + i)]);
    const eps = detectEpisodes([row("ETH1", values)], NOW);
    expect(eps.length).toBeLessThanOrEqual(6);
    expect(eps[0]!.failures).toBeGreaterThanOrEqual(eps[eps.length - 1]!.failures);
  });
});

describe("composeStory — the customer-ready bullets", () => {
  const base = {
    spec: "BASET", startUnix: NOW - 360, endUnix: NOW, ongoing: false,
    failures: 63, retriesRecovered: 114,
    blamed: [{ upstream: "chainstack", role: "primary" as const, failRate: 0.98, failed: 170 }],
    failedMethods: [{ method: "debug_traceBlockByNumber", count: 63, errorName: "NODE_METHOD_NOT_FOUND", example: "x" }],
    capabilityGap: "On this chain only chainstack serves DEBUG calls — tatum rejects them as an unsupported method, so debug_* traffic has no fallback.",
  };
  it("tells the incident story: who failed, what was saved, what still failed and why", () => {
    const story = composeStory(base, "Base Sepolia");
    expect(story[0]).toBe("chainstack, the primary provider on Base Sepolia, was failing for ~6 minutes (98% of its relays).");
    expect(story[1]).toBe("The router retried and recovered 114 requests automatically.");
    expect(story[2]).toBe("63 requests still failed — mostly debug_traceBlockByNumber.");
    // The cause line: dominant error code + its plain meaning, from shared.
    expect(story[3]).toBe(
      "Cause: 100% of the logged errors were NODE_METHOD_NOT_FOUND — the provider does not serve the method that was called.",
    );
    expect(story[4]).toContain("no fallback");
  });

  it("stands without config, logs, or retries — smaller, never invented", () => {
    const story = composeStory(
      { ...base, blamed: [], retriesRecovered: null, failedMethods: [], capabilityGap: null },
      "Base Sepolia",
    );
    expect(story).toEqual([
      "Base Sepolia had a burst of failures for ~6 minutes.",
      "63 requests still failed.",
    ]);
  });
});
