import { describe, expect, it } from "vitest";
import type { RelayAttempt } from "@sr/shared";
import { storyOf } from "../request-breakdown";

const tri = (upstream: string, outcome: RelayAttempt["outcome"], batch: number, extra: Partial<RelayAttempt> = {}): RelayAttempt => ({
  upstream, outcome, batch, replied: false, code: null, retryable: null, message: null, note: null, atMs: 0, endMs: 10, ...extra,
});

describe("storyOf · what happened to a request, in one plain sentence", () => {
  it("a write sent to every provider at once, both refused, names the one whose answer went back", () => {
    const a = tri("alchemy", "failed", 1, { code: "CHAIN_NONCE_TOO_LOW", replied: true });
    const b = tri("tatum", "failed", 1, { code: "CHAIN_NONCE_TOO_LOW" });
    expect(storyOf([a, b], { from: "provider", attempt: a })).toBe(
      "Sent to all at the same time: alchemy and tatum both failed (Nonce too low). alchemy's answer went to the client.",
    );
  });

  it("a retry reads in the order the router tried", () => {
    const a = tri("tatum", "failed", 1, { code: "NODE_SERVER_ERROR" });
    const b = tri("alchemy", "ok", 2, { replied: true });
    expect(storyOf([a, b], { from: "provider", attempt: b })).toBe(
      "tatum failed (Server error), then alchemy answered. alchemy's answer went to the client.",
    );
  });

  it("one try says only what it did; a provider's name keeps its spelling", () => {
    const a = tri("hedera", "failed", 1, { code: "NODE_SERVER_ERROR", replied: true });
    expect(storyOf([a], { from: "provider", attempt: a })).toBe("hedera failed (Server error).");
  });

  it("the router's own answer says no provider gave a usable one", () => {
    const a = tri("tatum", "no-result", 1);
    expect(storyOf([a], { from: "router", code: "PROTOCOL_NO_PROVIDERS" })).toBe(
      "tatum didn't answer. No provider gave a usable answer, so the router answered the client itself.",
    );
  });
});
