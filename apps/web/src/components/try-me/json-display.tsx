"use client";

import type { CSSProperties } from "react";

const TOKEN_RE =
  /("(?:\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g;

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ESCAPES[c] ?? c);
}

/** Tokenise a pretty-printed JSON string and wrap each token in a <span> with
 *  an inline colour. Pure string-in-string-out — no DOM, safe to feed to
 *  `dangerouslySetInnerHTML`. */
export function highlightJson(input: string): string {
  return escapeHtml(input).replace(TOKEN_RE, (match) => {
    let color: string;
    if (/^"/.test(match)) {
      color = /:$/.test(match) ? "color:var(--text)" : "color:var(--ok)";
    } else if (/^(?:true|false)$/.test(match)) {
      color = "color:var(--warn)";
    } else if (match === "null") {
      color = "color:var(--err)";
    } else {
      color = "color:#f9a8d4";
    }
    return `<span style="${color}">${match}</span>`;
  });
}

const PRE_STYLE: CSSProperties = {
  margin: 0,
  padding: "12px 14px",
  fontSize: 11,
  lineHeight: 1.7,
  background: "var(--bg-2)",
  borderRadius: 8,
  overflowX: "auto",
  overflowY: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  color: "var(--text-2)",
};

export function JsonDisplay({
  data,
  maxHeight = 360,
}: {
  data: unknown;
  maxHeight?: number;
}) {
  const html = highlightJson(JSON.stringify(data, null, 2));
  return (
    <pre
      className="gw-mono"
      style={{ ...PRE_STYLE, maxHeight }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
