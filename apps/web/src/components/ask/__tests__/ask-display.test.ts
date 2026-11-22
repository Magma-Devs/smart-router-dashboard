import { describe, expect, it } from "vitest";
import type { AskEvidence } from "@sr/shared";
import {
  answerHasGap,
  answerSections,
  answerText,
  evidenceBadges,
  evidenceSourceLabel,
  historyGroup,
  recentGap,
  validChatId,
  windowSpansDays,
} from "../ask-display";

const source = (overrides: Partial<AskEvidence>): AskEvidence => ({
  id: "fixture",
  sourceId: "own-source",
  operationId: "metrics.query",
  observedAt: "2026-11-16T10:00:00Z",
  coverage: "complete",
  truncated: false,
  ...overrides,
});
describe("chat display contracts", () => {
  it.each([
    ["metrics.query", "Metrics"],
    ["logs.query_range", "Logs"],
    ["status.chain_events", "Chain status"],
    ["grafana.dashboard", "Dashboard"],
    ["other", "Data"],
  ])("labels %s for the customer", (operation, expected) => {
    expect(evidenceSourceLabel(operation)).toBe(expected);
  });
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
    expect(text).toContain("Source: Metrics • 2026-11-16T10:00:00Z • Cut short");
  });
  /** A 24-hour window read `readAfter` seconds after it ends. */
  const windowRead = (readAfter: number, overrides: Partial<AskEvidence> = {}) =>
    source({
      from: "2026-11-15T10:00:00.000Z",
      to: "2026-11-16T10:00:00.000Z",
      observedAt: new Date(Date.parse("2026-11-16T10:00:00Z") + readAfter * 1000).toISOString(),
      ...overrides,
    });
  it.each([
    ["a metrics window read as it ends", windowRead(1), true],
    ["a metrics window read 119 s after it ends", windowRead(119), true],
    ["a metrics window read 121 s after it ends", windowRead(121), false],
    ["an instant read", windowRead(1, { from: "2026-11-16T10:00:00.000Z" }), false],
    ["a logs window read as it ends", windowRead(1, { operationId: "logs.query_range" }), false],
    ["a read with no window", source({}), false],
  ])("reads the recording lag off %s: %s", (_name, item, lagging) => {
    expect(recentGap(item)).toBe(lagging);
  });
  it("keeps the recording lag out of the missing-data banner and names it on the source", () => {
    const lag = windowRead(1);
    const noFailures = windowRead(1, { coverage: "empty" });
    expect(answerHasGap({ evidence: [lag, noFailures] })).toBe(false);
    expect(evidenceBadges(lag)).toEqual([
      expect.objectContaining({ label: "Last 2 min pending", tone: "muted" }),
    ]);
    expect(evidenceBadges(noFailures).map((badge) => badge.label)).toEqual([
      "No matches",
      "Last 2 min pending",
    ]);
    expect(evidenceBadges(windowRead(600))).toEqual([]);
  });
  it.each([
    [{ truncated: true }, "Cut short"],
    [{ coverage: "partial" }, "Partial"],
    [{ coverage: "unavailable" }, "Unavailable"],
  ] as const)("warns about a real gap (%o)", (overrides, label) => {
    const item = windowRead(1, overrides);
    expect(answerHasGap({ evidence: [windowRead(1), item] })).toBe(true);
    expect(evidenceBadges(item)[0]).toEqual({ label, tone: "warn" });
  });
  it("copies the recording lag with the source", () => {
    const text = answerText({
      contractVersion: 1,
      summary: "Fixture summary",
      sections: [],
      answeredAt: "2026-11-16T10:00:00Z",
      evidence: [windowRead(1)],
    });
    expect(text).toContain(
      "Source: Metrics • 2026-11-15T10:00:00.000Z to 2026-11-16T10:00:00.000Z • The newest ~2 minutes may not be recorded yet",
    );
  });
  it("shows the day on both ends of a window that crosses midnight", () => {
    const from = new Date(2026, 10, 21, 16, 0).toISOString();
    const sameDay = new Date(2026, 10, 21, 23, 0).toISOString();
    const nextDay = new Date(2026, 10, 22, 16, 0).toISOString();
    expect(windowSpansDays(from, nextDay)).toBe(true);
    expect(windowSpansDays(from, sameDay)).toBe(false);
    expect(windowSpansDays(from, undefined)).toBe(false);
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
