import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AskAnswer as Answer } from "@sr/shared";
import { AskAnswer } from "../AskAnswer";

const evidence = (label?: string) => ({
  id: crypto.randomUUID(),
  sourceId: "acme-metrics",
  operationId: "metrics.query",
  observedAt: "2026-11-22T20:00:00Z",
  from: "2026-11-21T20:00:00Z",
  to: "2026-11-22T20:00:00Z",
  coverage: "complete" as const,
  truncated: false,
  ...(label ? { label } : {}),
});
const answer = (items: Answer["evidence"]): Answer => ({
  contractVersion: 1,
  summary: "No requests reached the routers in the last 24 hours, so nothing failed.",
  sections: [{ title: "Reply", body: "No requests reached the routers." }],
  answeredAt: "2026-11-22T20:00:05Z",
  evidence: items,
});
// Each source row's heading: its kind, and its label when it has one.
const rows = (html: string) =>
  [
    ...html.matchAll(
      /<li><div><span><strong>([^<]*)<\/strong>(?:<span class="ask-evidence-label"> ([^<]*)<\/span>)?<\/span>/g,
    ),
  ].map(([, source = "", label]) => (label ? `${source} · ${label}` : source));

describe("the sources under an answer", () => {
  it("say what each read was, so two reads of one source tell apart", () => {
    const html = renderToStaticMarkup(
      createElement(AskAnswer, {
        answer: answer([
          evidence("Recorded requests by chain"),
          evidence("Recorded failures by chain"),
        ]),
      }),
    );
    expect(rows(html)).toEqual([
      "Metrics · Recorded requests by chain",
      "Metrics · Recorded failures by chain",
    ]);
  });

  it("render an answer stored without labels as before", () => {
    const html = renderToStaticMarkup(
      createElement(AskAnswer, { answer: answer([evidence(), evidence()]) }),
    );
    expect(rows(html)).toEqual(["Metrics", "Metrics"]);
    expect(html).not.toContain("ask-evidence-label");
  });
});
