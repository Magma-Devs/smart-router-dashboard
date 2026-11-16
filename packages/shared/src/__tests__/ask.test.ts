import { describe, expect, it } from "vitest";
import {
  ASK_CONTRACT_VERSION,
  ASK_LIMITS,
  askAnswerContentSchema,
  askAnswerSchema,
  askErrorCodeSchema,
  askEvidenceSchema,
  askHistoryQuerySchema,
  askPageContextSchema,
  askPreferencesSchema,
  askRunStatusSchema,
  askSubmitSchema,
} from "../ask.js";

const answer = {
  summary: "No requests were recorded in the queried window.",
  sections: [{ title: "Evidence", body: "The authorized metrics source returned no samples." }],
};
const id = "b4deca46-c815-4bc1-8075-10dc981ffbf1";
const from = "2026-11-16T09:00:00Z";
const to = "2026-11-16T10:00:00Z";

describe("Ask wire contract", () => {
  it("accepts bounded plain-text answer content and optional stats/points", () => {
    expect(askAnswerContentSchema.parse(answer)).toEqual(answer);
    expect(
      askAnswerContentSchema.parse({
        ...answer,
        sections: [
          {
            ...answer.sections[0],
            points: ["No samples"],
            stat: { value: "—", label: "unknown", tone: "warn" },
          },
        ],
      }).sections,
    ).toHaveLength(1);
  });

  it.each([
    { ...answer, summary: " " },
    { ...answer, sections: [] },
    { ...answer, summary: "x".repeat(ASK_LIMITS.summary + 1) },
    { ...answer, sourceId: "invented-by-model" },
    {
      ...answer,
      sections: [
        { title: "Title", body: "Body", stat: { value: "1", label: "x", tone: "success" } },
      ],
    },
    { ...answer, sections: [{ title: "Title", body: "Body", html: "<script/>" }] },
  ])("refuses invalid presentation content", (value) => {
    expect(askAnswerContentSchema.safeParse(value).success).toBe(false);
  });

  it("requires server evidence and completion time on persisted answers", () => {
    expect(askAnswerSchema.safeParse(answer).success).toBe(false);
    const evidence = {
      id,
      sourceId: "gk8-logs",
      operationId: "logs.query_range",
      observedAt: to,
      from,
      to,
      coverage: "partial",
      truncated: true,
    };
    expect(askEvidenceSchema.parse(evidence).coverage).toBe("partial");
    expect(
      askAnswerSchema.parse({
        ...answer,
        contractVersion: ASK_CONTRACT_VERSION,
        answeredAt: to,
        evidence: [evidence],
      }).evidence,
    ).toHaveLength(1);
    expect(askEvidenceSchema.safeParse({ ...evidence, credentials: "secret" }).success).toBe(false);
  });

  it("refuses caller-selected tenant, credentials, endpoint and invalid ranges", () => {
    const context = { page: "metrics", chain: "ETH1", from, to };
    expect(askPageContextSchema.parse(context).chain).toBe("ETH1");
    const request = { idempotencyKey: id, question: "What happened?", context };
    expect(askSubmitSchema.parse(request).question).toBe("What happened?");
    for (const extra of [
      { tenantId: "other" },
      { url: "https://other.test" },
      { headers: { authorization: "secret" } },
    ]) {
      expect(askSubmitSchema.safeParse({ ...request, ...extra }).success).toBe(false);
      expect(askPageContextSchema.safeParse({ ...context, ...extra }).success).toBe(false);
    }
    expect(askPageContextSchema.safeParse({ ...context, from: to, to: from }).success).toBe(false);
    expect(
      askSubmitSchema.safeParse({ ...request, question: " ", idempotencyKey: "not-an-id" }).success,
    ).toBe(false);
  });

  it("validates bounded pagination and local navigation preferences", () => {
    expect(askHistoryQuerySchema.parse({ limit: "20", query: " ethereum " })).toEqual({
      limit: 20,
      query: "ethereum",
    });
    expect(askHistoryQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(
      askPreferencesSchema.parse({ view: "panel", chatId: id, returnTo: "/metrics" }).chatId,
    ).toBe(id);
    expect(
      askPreferencesSchema.safeParse({
        view: "full",
        chatId: null,
        returnTo: "https://attacker.test",
      }).success,
    ).toBe(false);
    expect(askRunStatusSchema.parse("interrupted")).toBe("interrupted");
    expect(askRunStatusSchema.safeParse("done").success).toBe(false);
    expect(askErrorCodeSchema.parse("ASK_BUDGET_LIMIT")).toBe("ASK_BUDGET_LIMIT");
  });
});
