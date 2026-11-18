import { ASK_LIMITS } from "@sr/shared";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Lossless presentation only. Preserve every word; never repair malformed
 * structures, facts, numbers, references or tool inputs. The full answer schema
 * still validates the result before publication. */
export function formatAskPresentation(raw: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(raw.sections)) return raw;
  const sections = raw.sections.map((section: unknown) => {
    const value = record(section);
    return value && typeof value.title === "string" && !value.title.trim()
      ? { ...value, title: "Details" }
      : section;
  });
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : "";
  if (summary.length <= ASK_LIMITS.summary || sections.length >= ASK_LIMITS.sections)
    return { ...raw, sections };
  let split = 0;
  for (const part of new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(summary)) {
    const end = part.index + part.segment.length;
    if (end > ASK_LIMITS.summary) break;
    split = end;
  }
  if (!split) split = summary.lastIndexOf(" ", ASK_LIMITS.summary);
  if (split < 1 || summary.slice(split).trim().length > ASK_LIMITS.sectionBody)
    return { ...raw, sections };
  return {
    ...raw,
    summary: summary.slice(0, split).trim(),
    sections: [{ title: "Details", body: summary.slice(split).trim() }, ...sections],
  };
}
