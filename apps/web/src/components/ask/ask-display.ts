import type { AskAnswer, AskChat } from "@sr/shared";

export const HISTORY_GROUPS = [
  "Today",
  "Yesterday",
  "Last 7 days",
  "Last 30 days",
  "Older",
] as const;
export function historyGroup(instant: string, now = new Date()): (typeof HISTORY_GROUPS)[number] {
  const day = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.max(0, Math.round((day(now) - day(new Date(instant))) / 86_400_000));
  return days === 0
    ? "Today"
    : days === 1
      ? "Yesterday"
      : days < 7
        ? "Last 7 days"
        : days < 30
          ? "Last 30 days"
          : "Older";
}
export function groupHistory(chats: AskChat[], now = new Date()) {
  return HISTORY_GROUPS.map((label) => ({
    label,
    chats: chats.filter((chat) => historyGroup(chat.updatedAt, now) === label),
  })).filter((group) => group.chats.length);
}
export function answerText(answer: AskAnswer): string {
  return [
    answer.summary,
    ...answer.sections.map((section, i) =>
      [
        `${i + 1}. ${section.title}`,
        section.stat ? `${section.stat.value} — ${section.stat.label}` : "",
        section.body,
        ...(section.points ?? []).map((point) => `• ${point}`),
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    `Answered ${answer.answeredAt}`,
    ...answer.evidence.map(
      (item) =>
        `Source: ${item.sourceId} • ${item.operationId} • ${item.from ?? item.observedAt}${item.to ? ` to ${item.to}` : ""} • ${item.coverage}${item.truncated ? " (truncated)" : ""}`,
    ),
  ].join("\n\n");
}
export function validChatId(id: string | null | undefined): id is string {
  return (
    typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
  );
}
