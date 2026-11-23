import { describe, expect, it } from "vitest";
import { summarizeChainEvents } from "../services/ask/status-summary.js";

/** A provider-status result the size of a 40-chain tenant's. */
function statusResult(chains = 40, events = 30) {
  return {
    tenantChains: chains,
    unmapped: ["XYZ"],
    truncated: false,
    chains: Array.from({ length: chains }, (_, i) => ({
      requested_as: `CHAIN${i}`,
      chain: `CHAIN${i}`,
      slug: `chain-${i}`,
      current: {
        measured: i === 3 ? "degraded" : "up",
        providers: Array.from({ length: 6 }, (_, p) => ({
          name: `provider-${p}`,
          status: i === 3 && p === 2 ? "major" : "operational",
          url: `https://status.provider-${p}.example/very/long/path/for/chain-${i}`,
        })),
      },
    })),
    events: Array.from({ length: events }, (_, e) => ({
      kind: "provider_status_change",
      slug: `chain-${e % chains}`,
      time: 1_795_400_000 + e * 60,
      title: "Degraded performance on the RPC endpoint ".repeat(20),
    })),
  };
}

describe("a provider-status read summarized for the model", () => {
  it("keeps every chain and every provider that is not operational, counting the rest", () => {
    const raw = statusResult();
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeGreaterThan(20_000);
    const { summary, omitted } = summarizeChainEvents(raw, 10_000)!;
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(10_000);
    expect(summary.chains).toEqual([
      expect.objectContaining({
        requested_as: "CHAIN3",
        current: expect.objectContaining({
          measured: "degraded",
          providers: [expect.objectContaining({ name: "provider-2", status: "major" })],
          operationalProviders: 5,
        }),
      }),
    ]);
    expect(summary.chainsAllOperational).toHaveLength(39);
    expect(summary.chainsAllOperational).not.toContain("CHAIN3");
    expect(summary).toMatchObject({ unmapped: ["XYZ"], eventCount: 30 });
    expect(omitted).toBe(0);
    const event = (summary.events as Array<{ title: string }>)[0]!;
    expect(event.title.length).toBeLessThanOrEqual(160);
  });

  it("drops the oldest events past the budget and counts them", () => {
    const { summary, omitted } = summarizeChainEvents(statusResult(40, 400), 10_000)!;
    expect(omitted).toBeGreaterThan(0);
    expect(summary.eventsOmitted).toBe(omitted);
    const kept = summary.events as Array<{ time: number }>;
    expect(kept.length + omitted).toBe(400);
    expect(kept[0]!.time).toBe(1_795_400_000 + 399 * 60);
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(10_000);
  });

  it("reads a result nested under data, and leaves any other shape alone", () => {
    expect(summarizeChainEvents({ data: statusResult(2, 1) }, 10_000)?.summary.eventCount).toBe(1);
    // A chain whose measured state is not clear stays in full, its providers all operational.
    const down = statusResult(1, 0);
    down.chains[0]!.current.measured = "down";
    expect(summarizeChainEvents(down, 10_000)?.summary.chains).toHaveLength(1);
    expect(summarizeChainEvents({ status: "success", data: { result: [] } }, 10_000)).toBeNull();
    expect(summarizeChainEvents(null, 10_000)).toBeNull();
  });
});
