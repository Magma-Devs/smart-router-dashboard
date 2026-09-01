/**
 * Parsing the model's answer.
 *
 * This is the seam where a model that drifts from the requested format would
 * break the page, so it is pinned separately from the route. The rule
 * throughout: shape the answer defensively, but never invent a field the model
 * did not send — an empty `notDetermined` renders as "nothing was unclear",
 * which is a claim we should only make if it was actually made.
 */

import { describe, expect, it } from "vitest";
import { parseExplanation, TraceExplainError } from "../services/trace-explain.js";

const full = JSON.stringify({
  summary: "eth_blockNumber on ETH1, served in 42ms.",
  timeline: [{ at: "+0.000s", what: "Request received" }],
  findings: [{ severity: "warning", title: "Provider blocked", detail: "too-many-dead-sessions" }],
  notDetermined: ["which upstream served the relay (not logged at info level)"],
});

describe("parseExplanation", () => {
  it("reads the documented shape", () => {
    const e = parseExplanation(full);
    expect(e.summary).toContain("eth_blockNumber");
    expect(e.timeline).toEqual([{ at: "+0.000s", what: "Request received" }]);
    expect(e.findings[0]?.severity).toBe("warning");
    expect(e.notDetermined).toHaveLength(1);
  });

  it("tolerates a markdown fence around the json", () => {
    // Asked for bare JSON, but this is the single most likely drift.
    expect(parseExplanation("```json\n" + full + "\n```").summary).toContain("eth_blockNumber");
    expect(parseExplanation("```\n" + full + "\n```").summary).toContain("eth_blockNumber");
  });

  it("drops malformed timeline steps and findings instead of rendering blanks", () => {
    const e = parseExplanation(
      JSON.stringify({
        summary: "ok",
        timeline: [{ at: "+0s", what: "kept" }, { at: "+1s" }, null, "nope"],
        findings: [{ title: "kept", severity: "info" }, { detail: "no title" }],
      }),
    );
    expect(e.timeline).toEqual([{ at: "+0s", what: "kept" }]);
    expect(e.findings).toHaveLength(1);
  });

  it("defaults an unknown severity to info rather than guessing upward", () => {
    const e = parseExplanation(
      JSON.stringify({ summary: "ok", findings: [{ title: "t", severity: "catastrophic" }] }),
    );
    expect(e.findings[0]?.severity).toBe("info");
  });

  it("keeps notDetermined empty when the model sent none", () => {
    // Never synthesise a gap list: the page renders it as a factual claim
    // about what the logs did and did not say.
    expect(parseExplanation(JSON.stringify({ summary: "ok" })).notDetermined).toEqual([]);
  });

  it("refuses an answer with no summary", () => {
    // The summary is the whole headline; a trace page with an empty one is
    // worse than one that says the explanation failed.
    expect(() => parseExplanation(JSON.stringify({ timeline: [] }))).toThrow(TraceExplainError);
    expect(() => parseExplanation(JSON.stringify({ summary: "" }))).toThrow(/no summary/);
  });

  it("refuses non-JSON and non-objects", () => {
    expect(() => parseExplanation("I'd be happy to help!")).toThrow(/not valid JSON/);
    expect(() => parseExplanation('"a string"')).toThrow(/not a JSON object/);
    expect(() => parseExplanation("[1,2,3]")).toThrow(/no summary/);
  });
});
