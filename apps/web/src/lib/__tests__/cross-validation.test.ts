import { describe, expect, it } from "vitest";
import type { ErrorRequestRow } from "@sr/shared";
import { statusOf } from "@/components/metrics/ErrorRequests";
import { codeWords } from "@/components/metrics/request-log";
import { OUTVOTED_MEANS, blockOffHead, quorumChips } from "../cross-validation";
import { TT } from "../tooltips";

const q = (over: Partial<Parameters<typeof quorumChips>[0]> = {}) => ({ needed: 2, answered: 2, nodeErrors: 0, reason: "no-agreement", ...over });

describe("a failed cross-validation's rule, as chips", () => {
  it("says what the rule wanted, how many answered and how many agreed", () => {
    expect(quorumChips(q({ asked: 3, agreed: 1 }))).toEqual([
      { text: "2 of 3 must agree", tone: "plain" },
      { text: "2 answered", tone: "plain" },
      { text: "No two agreed", tone: "bad" },
    ]);
    expect(quorumChips(q({ needed: 3, answered: 4, asked: 5, agreed: 2 })).at(-1)).toEqual({ text: "Only 2 agreed", tone: "bad" });
  });

  it("leaves out what the router didn't say", () => {
    expect(quorumChips(q()).map((c) => c.text)).toEqual(["2 must agree", "2 answered"]);
    // A count of providers below the threshold is not a rule: the threshold alone is shown.
    expect(quorumChips(q({ asked: 1 }))[0]!.text).toBe("2 must agree");
  });

  it("marks too few answers, and the providers that returned an error", () => {
    expect(quorumChips(q({ answered: 1, nodeErrors: 1, asked: 3, agreed: 1 }))).toEqual([
      { text: "2 of 3 must agree", tone: "plain" },
      { text: "1 answered", tone: "warn" },
      { text: "1 provider returned an error", tone: "warn" },
    ]);
  });
});

describe("a requested block against the router's latest", () => {
  it("is orange behind it, red ahead of it, and plain on the same block", () => {
    expect(blockOffHead(100, 100)).toEqual({ text: "the same block", tone: "plain" });
    expect(blockOffHead(26_428_700, 26_428_741)).toEqual({ text: "41 blocks behind", tone: "warn" });
    expect(blockOffHead(99, 100).text).toBe("1 block behind");
    expect(blockOffHead(105, 100)).toEqual({ text: "5 blocks ahead", tone: "bad" });
    expect(blockOffHead(0, 12_000, (n) => n.toLocaleString("en-US")).text).toBe("12,000 blocks behind");
  });
});

describe("a failed cross-validation's name", () => {
  it("is what happened, in the timeline's words, not the router's code", () => {
    expect(codeWords("PROTOCOL_HASH_CONSENSUS_ERROR")).toBe("providers disagreed");
    expect(codeWords("NODE_RATE_LIMITED")).toBe("rate limited");
    const row = (over: Partial<ErrorRequestRow>) => ({ result: "failed", errorCode: null, ...over }) as ErrorRequestRow;
    expect(statusOf(row({ errorCode: "PROTOCOL_HASH_CONSENSUS_ERROR" })).label).toBe("Providers disagreed");
    expect(statusOf(row({ errorCode: "PROTOCOL_NO_PROVIDERS" })).label).toBe("Router error");
  });
});

describe("the Outvoted row's words", () => {
  // The router's per-provider disagreement counter takes in three cases and tells none apart.
  it("name every case the counter takes in, and none it cannot tell", () => {
    for (const words of [TT.outvoted!, OUTVOTED_MEANS]) {
      expect(words).toMatch(/not the one the router returned/);
      expect(words).toMatch(/differed/);
      expect(words).toMatch(/an error/);
      expect(words).toMatch(/no agreement|no answer was agreed/);
      expect(words).not.toMatch(/Nothing failed|went to the client|still answered/);
    }
  });
});
