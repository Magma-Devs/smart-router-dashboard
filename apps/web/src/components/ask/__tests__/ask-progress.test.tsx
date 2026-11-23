import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AskRun } from "@sr/shared";
import { finishedReads, processingText } from "../ask-display";
import { AskReads } from "../AskReads";
import { AskDraft } from "../AskDraft";

type Run = Pick<AskRun, "status" | "progress">;
const running = (progress: AskRun["progress"]): Run => ({ status: "running", progress });

describe("a pending answer's status line", () => {
  it.each([
    ["starting", "Starting…"],
    ["planning", "Choosing what to read…"],
    ["reading", "Reading data…"],
    ["reviewing", "Reviewing what it read…"],
    ["working", "Working…"],
  ] as const)("says %s as %s", (step, text) => {
    expect(processingText(running({ step, reads: [] }))).toBe(text);
  });

  it("reads as before for an API that reports no progress", () => {
    expect(processingText({ status: "running" })).toBe("Processing…");
    expect(processingText({ status: "running", progress: null })).toBe("Processing…");
    expect(processingText({ status: "queued" })).toBe("Processing…");
    expect(processingText(null)).toBe("Processing…");
    expect(renderToStaticMarkup(createElement(AskReads, { run: { status: "running" } }))).toBe("");
  });

  it("says stopping while a run is cancelled, whatever its progress", () => {
    expect(processingText({ status: "cancelling", progress: { step: "reading", reads: [] } })).toBe(
      "Stopping…",
    );
  });
});

describe("the reads under it", () => {
  const reads = Array.from({ length: 7 }, (_, i) => ({ label: `Read ${i + 1}`, ok: i !== 6 }));

  it("lists the newest five and counts the rest", () => {
    const { shown, hidden } = finishedReads(running({ step: "reading", reads }));
    expect(shown.map((read) => read.label)).toEqual([
      "Read 3",
      "Read 4",
      "Read 5",
      "Read 6",
      "Read 7",
    ]);
    expect(hidden).toBe(2);
    const html = renderToStaticMarkup(
      createElement(AskReads, { run: running({ step: "reading", reads }) }),
    );
    expect(html).toContain("2 earlier");
    expect(html).toContain("✓</span> Read 6");
    expect(html).toContain('class="ask-reads-failed"');
    expect(html).toContain("(unavailable)");
  });

  it("shows nothing once the run is no longer running", () => {
    expect(
      finishedReads({ status: "succeeded", progress: { step: "reading", reads } }).shown,
    ).toEqual([]);
  });
});

describe("the draft under it", () => {
  const draft = (run: Run | null) => renderToStaticMarkup(createElement(AskDraft, { run }));

  it("shows the summary as plain text, marked as a draft", () => {
    const html = draft(running({ step: "reviewing", reads: [], draft: "Two <b>chains</b> failed." }));
    expect(html).toContain("Two &lt;b&gt;chains&lt;/b&gt; failed.");
    expect(html).toContain("Draft.");
    expect(html).toContain('aria-busy="true"');
  });

  it("shows nothing without a draft, or once the run is not running", () => {
    expect(draft(running({ step: "reviewing", reads: [] }))).toBe("");
    expect(draft(running({ step: "reviewing", reads: [], draft: "  " }))).toBe("");
    expect(draft({ status: "running" })).toBe("");
    expect(draft(null)).toBe("");
    expect(
      draft({ status: "cancelling", progress: { step: "reviewing", reads: [], draft: "x y" } }),
    ).toBe("");
  });
});
