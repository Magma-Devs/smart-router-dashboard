/**
 * The Status brief, and the control that makes it trustworthy.
 *
 * Most of these pin `dropUncited`. The page's contract is that every number
 * maps to a real metric and anything unmeasured says so; a model cannot be
 * trusted to keep that by being asked, so a theme that cites nothing in the
 * report is deleted before it renders. If that ever stops happening, a
 * confident invented provider reaches a customer, so it is pinned hard.
 */
import { describe, it, expect, vi } from "vitest";
import { StatusAiService, dropUncited, parseAnswer, type StatusTheme } from "../services/status-ai.js";
import type { BedrockService } from "../services/bedrock.js";
import type { Incident, StatusReport } from "@sr/shared";

const theme = (title: string, findingIds: string[]): StatusTheme => ({
  title,
  detail: "d",
  severity: "degraded",
  findingIds,
});

describe("dropUncited", () => {
  const valid = new Set(["f1", "f2", "incident:ETH1:1"]);

  it("keeps a theme that cites something real", () => {
    const { kept, dropped } = dropUncited([theme("real", ["f1"])], valid);
    expect(kept).toHaveLength(1);
    expect(dropped).toBe(0);
  });

  it("DELETES a theme that cites nothing in the report", () => {
    // The hallucination case: a provider the report never mentioned has no id
    // to cite, so the theme cannot survive.
    const { kept, dropped } = dropUncited([theme("invented", ["f99"])], valid);
    expect(kept).toEqual([]);
    expect(dropped).toBe(1);
  });

  it("deletes a theme with no citations at all", () => {
    expect(dropUncited([theme("bare", [])], valid).dropped).toBe(1);
    // Missing entirely, not just empty — models omit fields.
    const missing = [{ title: "t", detail: "d", severity: "advisory" } as StatusTheme];
    expect(dropUncited(missing, valid).dropped).toBe(1);
  });

  it("prunes invented ids but keeps a theme with at least one real one", () => {
    const { kept, dropped } = dropUncited([theme("half", ["f1", "made-up"])], valid);
    expect(dropped).toBe(0);
    expect(kept[0]!.findingIds).toEqual(["f1"]);
  });
});

describe("parseAnswer", () => {
  it("reads a bare object", () => {
    expect(parseAnswer('{"headline":"x"}')).toMatchObject({ headline: "x" });
  });

  it("survives a markdown fence the prompt asked it not to use", () => {
    expect(parseAnswer('```json\n{"headline":"x"}\n```')).toMatchObject({ headline: "x" });
  });

  it("returns null on truncated JSON rather than throwing", () => {
    // A cut-off answer is unparseable, which is why maxTokens is sized for the
    // worst case. The caller turns this into "we could not ask".
    expect(parseAnswer('{"headline":"x","themes":[{')).toBeNull();
    expect(parseAnswer("no json here")).toBeNull();
  });
});

describe("StatusAiService.analyse", () => {
  const report = {
    computedAtUnix: 1,
    findings: [
      { id: "f1", tier: "attention", kind: "errors", spec: "ETH1", chainName: "Ethereum", upstream: "tatum", role: null, headline: "h", metric: { value: "8%", label: "errors" }, codes: [], evidence: [], remedy: "", sinceSec: null, firstSeenUnix: null, lastSeenUnix: null, ongoing: true, decision: [] },
    ],
    insights: [],
    noFailover: [],
    chains: [],
    totals: { requestsServed: 0, attemptsPerRequest: null, upstreamFailureRate: null, chainsClear: 0, chainsTotal: 1, prior: { requestsServed: null, attemptsPerRequest: null, upstreamFailureRate: null } },
    lastCritical24h: null,
    worstMover: null,
    emitted: true,
  } as unknown as StatusReport;

  function fakeBedrock(text: string): BedrockService {
    return {
      complete: vi.fn(async () => ({ text, stopReason: "end_turn", inputTokens: 10, outputTokens: 20 })),
    } as unknown as BedrockService;
  }

  it("keeps a grounded theme and reports what it dropped", async () => {
    const bedrock = fakeBedrock(
      JSON.stringify({
        headline: "one chain affected",
        themes: [
          { title: "tatum", detail: "d", severity: "critical", findingIds: ["f1"] },
          { title: "ghost provider", detail: "d", severity: "critical", findingIds: ["nope"] },
        ],
        customerMessage: "msg",
      }),
    );

    const out = await new StatusAiService(bedrock).analyse(report, []);
    expect(out.themes.map((t) => t.title)).toEqual(["tatum"]);
    expect(out.droppedUncited).toBe(1);
    expect(out.customerMessage).toBe("msg");
  });

  it("sends findings but not the page's detail view", async () => {
    const bedrock = fakeBedrock('{"headline":"h","themes":[]}');
    await new StatusAiService(bedrock).analyse(report, []);

    const sent = (bedrock.complete as unknown as { mock: { calls: [{ messages: { content: string }[] }][] } })
      .mock.calls[0]![0];
    const body = sent.messages[0]!.content;
    expect(body).toContain('"id": "f1"');
    // `remedy` and `evidence` are the page's own detail; sending them invites
    // the model to restate rows instead of relating them.
    expect(body).not.toContain("remedy");
    expect(body).not.toContain("evidence");
  });

  it("throws rather than returning an empty brief when the model returns junk", async () => {
    // "we could not ask" and "there was nothing to say" are different facts.
    const bedrock = fakeBedrock("I'm afraid I can't do that");
    await expect(new StatusAiService(bedrock).analyse(report, [])).rejects.toThrow(/JSON/);
  });

  it("carries incident ids into the citable set", async () => {
    const incident = { id: "inc-1", spec: "ETH1", chainName: "Ethereum", ongoing: false, failures: 5, retriesRecovered: 1, blamed: [], failedMethods: [], capabilityGap: null, story: [] } as unknown as Incident;
    const bedrock = fakeBedrock(
      JSON.stringify({ headline: "h", themes: [{ title: "t", detail: "d", severity: "critical", findingIds: ["inc-1"] }] }),
    );

    const out = await new StatusAiService(bedrock).analyse(report, [incident]);
    expect(out.themes).toHaveLength(1);
    expect(out.droppedUncited).toBe(0);
  });
});
