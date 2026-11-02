import { describe, expect, it } from "vitest";
import type { RelayAttempt } from "@sr/shared";
import { stepsOf } from "../request-breakdown";

const tri = (upstream: string, outcome: RelayAttempt["outcome"], batch: number, extra: Partial<RelayAttempt> = {}): RelayAttempt => ({
  upstream, outcome, batch, replied: false, code: null, retryable: null, message: null, note: null, atMs: 0, endMs: 10, ...extra,
});

describe("stepsOf · each send of a request, in the order the router made them", () => {
  it("a write sent to every provider at once is one step naming them all", () => {
    const a = tri("alchemy", "failed", 1, { code: "CHAIN_NONCE_TOO_LOW", replied: true });
    const b = tri("tatum", "failed", 1, { code: "CHAIN_NONCE_TOO_LOW" });
    expect(stepsOf([a, b])).toEqual([{ title: "Sent to alchemy and tatum at the same time", attempts: [a, b] }]);
  });

  it("a retry is a step of its own, after the first", () => {
    const a = tri("tatum", "failed", 1, { code: "NODE_SERVER_ERROR" });
    const b = tri("alchemy", "ok", 2, { replied: true });
    expect(stepsOf([a, b]).map((s) => s.title)).toEqual(["Sent to tatum", "Then sent to alchemy"]);
  });

  it("a provider passed over is listed, but not as sent to", () => {
    const a = tri("blast", "skipped", 1, { note: "12 blocks behind" });
    const b = tri("tatum", "ok", 1, { replied: true });
    expect(stepsOf([a, b]).map((s) => s.title)).toEqual(["Sent to tatum"]);
    expect(stepsOf([a]).map((s) => s.title)).toEqual(["Passed over blast"]);
  });

  it("no tries, no steps", () => {
    expect(stepsOf([])).toEqual([]);
  });
});
