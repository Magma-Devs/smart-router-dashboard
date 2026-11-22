import type { AskAnswer, AskChat, AskRun, AskRunStep } from "@sr/shared";

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
    ...answerSections(answer).map((section, i) =>
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
        `Source: ${evidenceSourceLabel(item.operationId)} • ${item.from ?? item.observedAt}${item.to ? ` to ${item.to}` : ""}${item.truncated ? " • Cut short" : item.coverage === "partial" ? " • Partial data" : item.coverage === "unavailable" ? " • Unavailable" : ""}${recentGap(item) ? ` • ${RECENT_GAP_NOTE}` : ""}`,
    ),
  ].join("\n\n");
}

export const RECENT_GAP_LABEL = "Last 2 min pending";
export const RECENT_GAP_NOTE = "The newest ~2 minutes may not be recorded yet";
const RECORDING_LAG_MS = 120_000;

/** A metrics window that ends within the recording lag of its read: the store
 * may not hold its newest ~2 minutes yet. Read off the stored instants only, so
 * an answer reads the same however old it is. */
export function recentGap(item: AskAnswer["evidence"][number]): boolean {
  if (!item.operationId.startsWith("metrics.") || !item.from || !item.to) return false;
  const from = Date.parse(item.from);
  const to = Date.parse(item.to);
  return from < to && to > Date.parse(item.observedAt) - RECORDING_LAG_MS;
}

/** A source that came back cut short, partial or unavailable. The recording
 * lag alone is not a gap: its badge on the source says so. */
export function answerHasGap(answer: Pick<AskAnswer, "evidence">): boolean {
  return answer.evidence.some(
    (item) => item.truncated || ["partial", "unavailable"].includes(item.coverage),
  );
}

/** The badges of one source: what the read returned, then the recording lag. */
export function evidenceBadges(
  item: AskAnswer["evidence"][number],
): { label: string; tone: "warn" | "muted"; title?: string }[] {
  const badges: { label: string; tone: "warn" | "muted"; title?: string }[] = [];
  if (item.truncated) badges.push({ label: "Cut short", tone: "warn" });
  else if (item.coverage === "partial") badges.push({ label: "Partial", tone: "warn" });
  else if (item.coverage === "unavailable") badges.push({ label: "Unavailable", tone: "warn" });
  else if (item.coverage === "empty") badges.push({ label: "No matches", tone: "muted" });
  else if (item.coverage === "unknown") badges.push({ label: "Limited coverage", tone: "muted" });
  if (recentGap(item))
    badges.push({ label: RECENT_GAP_LABEL, tone: "muted", title: RECENT_GAP_NOTE });
  return badges;
}

/** A window whose ends fall on different local days shows the day on both. */
export function windowSpansDays(from: string, to: string | undefined): boolean {
  return to !== undefined && new Date(from).toDateString() !== new Date(to).toDateString();
}

export function evidenceSourceLabel(operationId: string): string {
  if (operationId.startsWith("logs.")) return "Logs";
  if (operationId.startsWith("metrics.")) return "Metrics";
  if (operationId.startsWith("status.")) return "Chain status";
  if (operationId.startsWith("grafana.")) return "Dashboard";
  return "Data";
}
/** The summary already says this. Keep sections that add any detail. */
export function answerSections(answer: AskAnswer): AskAnswer["sections"] {
  return answer.sections.filter(
    (section) =>
      section.body.trim() !== answer.summary.trim() || section.points?.length || section.stat,
  );
}
export function validChatId(id: string | null | undefined): id is string {
  return (
    typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
  );
}

const STEP_TEXT: Record<AskRunStep, string> = {
  starting: "Starting",
  planning: "Choosing what to read",
  reading: "Reading data",
  reviewing: "Reviewing what it read",
  working: "Working",
};

/** What a pending answer's status line says. A run an API reports without
 * progress (an older API, or one not yet started) reads as before. */
export function processingText(run: Pick<AskRun, "status" | "progress"> | null): string {
  if (run?.status === "cancelling") return "Stopping…";
  if (run?.status === "running" && run.progress) return `${STEP_TEXT[run.progress.step]}…`;
  return "Processing…";
}

/** The reads a running answer has finished, newest last, at most `limit`. */
export function finishedReads(run: Pick<AskRun, "status" | "progress"> | null, limit = 5) {
  if (run?.status !== "running" || !run.progress) return { shown: [], hidden: 0 };
  const reads = run.progress.reads;
  return { shown: reads.slice(-limit), hidden: Math.max(0, reads.length - limit) };
}
