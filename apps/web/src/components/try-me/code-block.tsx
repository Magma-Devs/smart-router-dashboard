"use client";

import { CopyButton } from "@/components/gateway/CopyButton";
import type { SnippetLanguage } from "./snippets";

interface CodeBlockProps {
  code: string;
  language?: SnippetLanguage;
}

/**
 * Code block with a copy affordance, in plain text: no highlighting
 * dependency. The wrapper geometry is fixed (padding, mono, 360px cap,
 * both-axis scroll, top-right copy). `language` is accepted and unused: no
 * syntax highlighter is bundled.
 *
 *  - `whiteSpace: pre` keeps long lines on one line — readers can scroll
 *    horizontally instead of wrapping (matches what an IDE/editor does).
 *  - `maxHeight: 360` caps the block; both axes scroll.
 */
export function CodeBlock({ code, language = "bash" }: CodeBlockProps) {
  void language; // reserved — no syntax highlighter is bundled self-hosted
  return (
    <div style={{ position: "relative" }}>
      <pre
        className="gw-mono"
        style={{
          margin: 0,
          padding: "12px 14px",
          paddingRight: 52,
          fontSize: 11,
          lineHeight: 1.7,
          background: "var(--bg-2)",
          borderRadius: 8,
          whiteSpace: "pre",
          overflowX: "auto",
          overflowY: "auto",
          maxHeight: 360,
          color: "var(--text-2)",
        }}
      >
        {code}
      </pre>
      <div style={{ position: "absolute", top: 8, right: 8 }}>
        <CopyButton text={code} />
      </div>
    </div>
  );
}
