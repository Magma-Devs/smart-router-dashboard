import { describe, expect, it } from "vitest";
import { answerSections, answerText, historyGroup, validChatId } from "../ask-display";
describe("chat display contracts", () => {
  it("shows and copies a simple answer once, retaining sections with additional facts", () => {
    const answer = {
      contractVersion: 1 as const,
      summary: "Today is November 18, 2026 (UTC).",
      sections: [{ title: "Server clock", body: "Today is November 18, 2026 (UTC)." }],
      answeredAt: "2026-11-18T14:12:00Z",
      evidence: [],
    };
    expect(answerSections(answer)).toEqual([]);
    expect(answerText(answer).match(/Today is/g)).toHaveLength(1);
    expect(
      answerSections({ ...answer, sections: [{ ...answer.sections[0]!, points: ["Detail"] }] }),
    ).toHaveLength(1);
    expect(
      answerSections({ ...answer, sections: [{ title: "Other", body: "Different fact" }] }),
    ).toHaveLength(1);
  });
  it("groups calendar days at the seven/thirty-day boundaries, including future clock skew", () => {
    const now = new Date(2026, 10, 16, 12);
    const at = (days: number) => new Date(2026, 10, 16 - days, 23, 59).toISOString();
    expect([0, 1, 2, 6, 7, 29, 30, 80, -1].map((days) => historyGroup(at(days), now))).toEqual([
      "Today",
      "Yesterday",
      "Last 7 days",
      "Last 7 days",
      "Last 30 days",
      "Last 30 days",
      "Older",
      "Older",
      "Today",
    ]);
  });
  it("copies readable numbered sections and real source/time/coverage without HTML rendering", () => {
    const text = answerText({
      contractVersion: 1,
      summary: "Fixture summary",
      sections: [
        {
          title: "Observed",
          body: "<script>untrusted text</script>",
          points: ["One point"],
          stat: { value: "0", label: "Fixture count", tone: "neutral" },
        },
      ],
      answeredAt: "2026-11-16T10:00:00Z",
      evidence: [
        {
          id: "fixture",
          sourceId: "own-source",
          operationId: "metrics.query",
          observedAt: "2026-11-16T10:00:00Z",
          coverage: "partial",
          truncated: true,
        },
      ],
    });
    expect(text).toContain("1. Observed\n0 — Fixture count");
    expect(text).toContain("<script>untrusted text</script>");
    expect(text).toContain(
      "Source: own-source • metrics.query • 2026-11-16T10:00:00Z • partial (truncated)",
    );
  });
  it("accepts only UUID chat links, never URLs or path fragments", () => {
    expect(validChatId("41d22646-030f-4f60-8b01-cb525280c197")).toBe(true);
    for (const value of [
      null,
      undefined,
      "../other",
      "https://example.test/chat",
      "41d22646-030f-4f60-8b01-cb525280c197?tenant=other",
    ])
      expect(validChatId(value)).toBe(false);
  });
});
