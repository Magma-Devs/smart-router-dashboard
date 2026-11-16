import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ErrorIncidentLine, ErrorIncidentsReport, SteadyError } from "@sr/shared";
import { ErrorIncidents } from "@/components/metrics/ErrorIncidents";
import { Seg } from "@/components/metrics/ErrorRequests";

/** What `useApi` answers for the timeline's read. */
const fixture = vi.hoisted(() => ({
  answer: (_path: string): { data: unknown; isLoading: boolean; error?: unknown } => ({ data: undefined, isLoading: false }),
}));
vi.mock("@/hooks/use-api", () => ({ useApi: (path: string | null) => fixture.answer(path ?? "") }));
vi.mock("@/components/gateway/FiltersProvider", () => ({
  useFilters: () => ({ scopeQ: "", withScope: (p: string) => p, routerId: null }),
}));
vi.mock("@/hooks/use-router-options", () => ({ useRouterFilter: () => ({ routerId: null, routerIdQ: "" }) }));

const line = (over: Partial<ErrorIncidentLine> = {}): ErrorIncidentLine => ({
  key: "failed|ETH1|alpha|1000",
  kind: "failed",
  shape: "incident",
  providers: ["alpha"],
  chains: [{ spec: "ETH1", count: 40 }],
  start: 1000,
  end: 1600,
  count: 40,
  peak: 12,
  waves: [{ start: 1000, end: 1600, count: 40 }],
  ongoing: false,
  ...over,
});

const steadyRow: SteadyError = { kind: "reply", spec: "ETH1", provider: "alpha", perMinute: 4, presence: 0.9 };

const report = (over: Partial<ErrorIncidentsReport> = {}): ErrorIncidentsReport => ({
  from: 0, to: 86400, stepSec: 300, lines: [], steady: [], outvoted: [], available: true, failed: [], ...over,
});

const timeline = (data: ErrorIncidentsReport) => {
  fixture.answer = () => ({ data, isLoading: false });
  return renderToStaticMarkup(createElement(ErrorIncidents, { chainFilter: null, win: "1d", openKey: null, onOpen: () => {} }));
};

beforeEach(() => {
  fixture.answer = () => ({ data: undefined, isLoading: false });
});

describe("the Errors timeline", () => {
  it("says once that a window has no bursts, with no filter and the always-present line under it", () => {
    const html = timeline(report({ steady: [steadyRow] }));
    expect(html).toContain("No bursts in the last 1 day");
    expect(html).not.toContain("gw-segctl");
    expect(html).toContain("Always present");
    expect(html).not.toContain("No bursts of");
  });

  it("draws nothing under the header for a window with no bursts and no always-present errors", () => {
    const html = timeline(report());
    expect(html).toContain("No bursts in the last 1 day");
    expect(html).not.toContain("Always present");
    expect(html).not.toContain("gw-segctl");
  });

  it("counts the bursts in its header and draws the filter over them", () => {
    const html = timeline(report({ lines: [line(), line({ key: "reply|ETH1|beta|2000", kind: "reply", providers: ["beta"] })], steady: [steadyRow] }));
    expect(html).toContain("2 bursts in the last 1 day");
    expect(html).toContain("gw-segctl");
    expect(html).toContain("Always present");
    expect(timeline(report({ lines: [line()] }))).toContain("1 burst in the last 1 day");
  });

  it("claims no count when the read failed and no burst is drawn: the warning speaks", () => {
    const html = timeline(report({ available: false, failed: ["failed", "reply"] }));
    expect(html).toContain("Prometheus didn&#x27;t answer for failed attempts and error replies");
    expect(html).not.toContain("No bursts");
    expect(html).not.toContain("in the last 1 day");
  });

  it("counts the bursts it has when only one of the reads failed", () => {
    const html = timeline(report({ available: false, failed: ["reply"], lines: [line()] }));
    expect(html).toContain("1 burst in the last 1 day");
    expect(html).toContain("Prometheus didn&#x27;t answer for error replies");
  });
});

describe("the request list's filter counts", () => {
  const PARTIAL = "In the requests loaded so far";
  const seg = (atLeast: boolean) => renderToStaticMarkup(createElement(Seg<string>, {
    value: "all", onChange: () => {}, atLeast,
    options: [{ key: "all", label: "All", count: 300 }, { key: "router", label: "Router error", count: 0 }],
  }));
  /** The count pill inside the button labelled `label`. */
  const pill = (html: string, label: string) => {
    const from = html.indexOf(`${label}<span`);
    return html.slice(from, html.indexOf("</button>", from));
  };

  it("read as totals when every request is loaded", () => {
    const html = seg(false);
    expect(pill(html, "All")).toContain(">300</span>");
    expect(pill(html, "Router error")).toContain(">0</span>");
    expect(html).not.toContain(PARTIAL);
  });

  it("read \"300+\" while older requests are not loaded", () => {
    const all = pill(seg(true), "All");
    expect(all).toContain(">300+</span>");
    expect(all).toContain(PARTIAL);
  });

  it("explain a zero as partial too, its text a bare 0", () => {
    const zero = pill(seg(true), "Router error");
    expect(zero).toContain(">0</span>");
    expect(zero).toContain(PARTIAL);
  });
});
