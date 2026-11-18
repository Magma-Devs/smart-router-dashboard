import { describe, expect, it } from "vitest";
import { assertAskRead } from "../services/ask/mcp.js";

describe("locally audited metric identifiers", () => {
  it.each([
    "up",
    "smartrouter_requests_total",
    "smartrouter_transactions:count1m",
    "smartrouter_final_failures:count1m",
  ])("admits real metric metadata name %s", (metric) => {
    expect(() => assertAskRead("metrics.metadata", { metric })).not.toThrow();
  });
  it.each(["https://other.test", 'up{tenant="other"}', "x y", "__name__|delete", "x".repeat(201)])(
    "rejects non-metric metadata name %s",
    (metric) => {
      expect(() => assertAskRead("metrics.metadata", { metric })).toThrow();
    },
  );
  it("does not broaden label names to include metric-family separators", () => {
    expect(() =>
      assertAskRead("metrics.label_values", { label: "chain:other", start: 1, end: 2 }),
    ).toThrow();
  });
});
