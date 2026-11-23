"use client";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Raw HTML in an answer renders as the text it is: no rehype-raw, so no element,
// script or style from the model or the logs it read reaches the page. No link,
// image or media does either: a URL the model wrote could carry data out of it.
// Links read as their text, images as their description.
const components: Components = {
  a: ({ children }) => <span className="ask-md-link">{children}</span>,
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
  table: ({ children }) => (
    <div className="ask-md-table">
      <table>{children}</table>
    </div>
  ),
};

/**
 * Markdown still being written, made safe to render as it stands: a trailing
 * table row or table without its separator line yet is held back, and an open
 * `**` or code span is closed, so half-written syntax neither flickers as raw
 * characters nor swallows the text after it.
 */
export function settleMarkdown(text: string): string {
  const lines = text.split("\n");
  let tableStart = lines.length;
  while (tableStart > 0 && lines[tableStart - 1]!.trimStart().startsWith("|")) tableStart--;
  const table = lines.slice(tableStart);
  if (table.length) {
    const separated = table.some((line) => /^\s*\|?\s*:?-{3,}/.test(line));
    const last = table.at(-1)!.trimEnd();
    if (!separated || table.length < 3) lines.splice(tableStart);
    else if (!last.endsWith("|")) lines.pop();
  }
  let settled = lines.join("\n").replace(/(^|\n)\s*([-*+]|#{1,6}|\d+\.)\s*$/, "$1");
  if (((settled.match(/```/g) ?? []).length & 1) === 1) settled += "\n```";
  else {
    if (((settled.replace(/```[\s\S]*?```/g, "").match(/`/g) ?? []).length & 1) === 1)
      settled += "`";
    if (((settled.match(/\*\*/g) ?? []).length & 1) === 1) settled += "**";
  }
  return settled;
}

export function AskMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className={`ask-md${streaming ? " ask-md--streaming" : ""}`} dir="auto">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={() => ""}>
        {streaming ? settleMarkdown(text) : text}
      </ReactMarkdown>
    </div>
  );
}
