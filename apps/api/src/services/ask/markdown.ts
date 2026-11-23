import { ASK_LIMITS } from "@sr/shared";

/** Markdown read as plain text: emphasis, code marks and heading marks
 * dropped, list items as bullets, table rows as cells joined by " · ". */
export function plainText(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => !/^\s*(```|\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$)/.test(line))
    .map((line) => {
      const row = /^\s*\|(.*)\|\s*$/.exec(line);
      if (row)
        return row[1]!
          .split("|")
          .map((cell) => cell.trim())
          .filter(Boolean)
          .join(" · ");
      return line.replace(/^\s*#{1,6}\s+/, "").replace(/^(\s*)[-*+]\s+/, "$1• ");
    })
    .join("\n")
    .replace(/\*\*|__|`/g, "")
    .trim();
}

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const space = text.lastIndexOf(" ", max - 1);
  return `${text.slice(0, space > max / 2 ? space : max - 1).trimEnd()}…`;
}

/**
 * The summary and sections a web without Markdown rendering shows for an
 * answer, as plain text: the first paragraph as the summary and the whole
 * answer as the sections, so nothing is lost. An answer of one paragraph is
 * one "Reply" section, which such a web shows once.
 */
export function markdownFallback(markdown: string): {
  summary: string;
  sections: Array<{ title: string; body: string }>;
} {
  const plain = plainText(markdown) || markdown.trim();
  const paragraphs = plain
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  const summary = cut(paragraphs[0] ?? plain, ASK_LIMITS.summary);
  if (paragraphs.length <= 1 && summary === plain)
    return { summary, sections: [{ title: "Reply", body: summary }] };
  const sections: Array<{ title: string; body: string }> = [];
  let rest = plain;
  while (rest && sections.length < ASK_LIMITS.sections) {
    const last = sections.length === ASK_LIMITS.sections - 1;
    let body = rest.slice(0, ASK_LIMITS.sectionBody);
    if (rest.length > ASK_LIMITS.sectionBody && !last) {
      const split = body.lastIndexOf("\n\n");
      if (split > ASK_LIMITS.sectionBody / 2) body = body.slice(0, split);
    }
    if (last) body = cut(rest, ASK_LIMITS.sectionBody);
    sections.push({ title: sections.length ? "Answer (continued)" : "Answer", body: body.trim() });
    rest = rest.slice(body.length).trim();
    if (last) break;
  }
  return { summary, sections };
}
