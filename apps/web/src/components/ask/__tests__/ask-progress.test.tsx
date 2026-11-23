import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AskRun } from "@sr/shared";
import { finishedReads, processingText, runningDraft } from "../ask-display";
import { AskReads } from "../AskReads";
import { AskDraftView, revealStep } from "../AskDraft";
import { settleMarkdown } from "../AskMarkdown";
import { AskAnswer } from "../AskAnswer";

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

describe("the answer as it is written", () => {
  const view = (text: string) =>
    renderToStaticMarkup(createElement(AskDraftView, { text, animate: false }));

  it("renders the draft as Markdown, marked busy, with HTML shown as text", () => {
    const html = view("Two **chains** failed. <b>bold</b> <script>x()</script>");
    expect(html).toContain("<strong>chains</strong>");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("ask-md--streaming");
  });

  it("shows nothing without text, and reads the draft only of a running run", () => {
    expect(view("")).toBe("");
    expect(runningDraft(running({ step: "reviewing", reads: [], draft: "  " }))).toBeNull();
    expect(runningDraft({ status: "running" })).toBeNull();
    expect(runningDraft(null)).toBeNull();
    expect(
      runningDraft({
        status: "cancelling",
        progress: { step: "reviewing", reads: [], draft: "x y" },
      }),
    ).toBeNull();
    expect(runningDraft(running({ step: "reviewing", reads: [], draft: "Two chains" }))).toBe(
      "Two chains",
    );
  });

  it("closes half-written syntax and holds back an unfinished table", () => {
    expect(settleMarkdown("Two **chains")).toBe("Two **chains**");
    expect(settleMarkdown("Use `eth_call")).toBe("Use `eth_call`");
    expect(settleMarkdown("Rows:\n\n| chain | failures |")).toBe("Rows:\n");
    expect(settleMarkdown("| a | b |\n| --- | --- |\n| eth1 | 1")).toBe("| a | b |\n| --- | --- |");
    expect(settleMarkdown("| a | b |\n| --- | --- |\n| eth1 | 1 |\n| sol | 2")).toBe(
      "| a | b |\n| --- | --- |\n| eth1 | 1 |",
    );
    expect(settleMarkdown("Items:\n- ")).toBe("Items:\n");
    expect(settleMarkdown("Code:\n```\nx")).toBe("Code:\n```\nx\n```");
  });

  it("reveals text in steps that shrink as it catches up, and follows a rewrite", () => {
    const target = "x".repeat(180);
    const first = revealStep("", target);
    expect(first.length).toBe(10);
    let shown = first;
    let frames = 1;
    while (shown !== target) {
      shown = revealStep(shown, target);
      frames++;
    }
    expect(frames).toBeLessThan(60);
    expect(revealStep("See https://node/abc", "See https://node/[redacted] now")).toMatch(
      /^See https:\/\/node\//,
    );
    expect(revealStep("abc", "abc")).toBe("abc");
  });
});

describe("an answer", () => {
  const answer = {
    contractVersion: 1 as const,
    summary: "Two chains failed.",
    sections: [{ title: "Reply", body: "Two chains failed." }],
    answeredAt: "2026-11-23T10:00:00Z",
    evidence: [],
  };
  const render = (value: typeof answer & { markdown?: string }) =>
    renderToStaticMarkup(createElement(AskAnswer, { answer: value }));

  it("renders its Markdown: tables, lists and emphasis, with no link, image or HTML", () => {
    const html = render({
      ...answer,
      markdown: [
        "Two chains **failed** [here](https://evil.example/x) ![leak](https://evil.example/p.png)",
        "",
        "| chain | failures |",
        "| --- | --- |",
        "| eth1 | 14 |",
        "",
        "- one",
        "<img src=x onerror=alert(1)>",
      ].join("\n"),
    });
    expect(html).toContain("<strong>failed</strong>");
    expect(html).toContain('class="ask-md-table"');
    expect(html).toContain("<td>eth1</td>");
    expect(html).toContain("<li>one</li>");
    expect(html).not.toMatch(/<a\b|<img\b|href="|src="/);
    expect(html).toContain("&lt;img");
    expect(html).toContain("leak");
    expect(html).not.toContain("ask-summary");
  });

  it("renders an answer stored without Markdown as its summary and sections", () => {
    const html = render(answer);
    expect(html).toContain("ask-summary");
    expect(html).not.toContain("ask-md");
  });
});
