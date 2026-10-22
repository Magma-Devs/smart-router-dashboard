import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HeroSummary, RouterMetrics } from "@sr/shared";
import { RouterOverview } from "@/components/metrics/RouterOverview";
import { HeroPanel } from "@/components/metrics/HeroPanel";
import { openRowShown } from "@/components/metrics/request-log";

/** What `useApi` answers per path: SWR's fields as a window change leaves them. */
const fixture = vi.hoisted(() => ({
  answer: (_path: string): { data: unknown; isLoading: boolean; isValidating: boolean } => ({ data: undefined, isLoading: false, isValidating: false }),
}));
vi.mock("@/hooks/use-api", () => ({ useApi: (path: string | null) => fixture.answer(path ?? "") }));
vi.mock("@/components/gateway/FiltersProvider", () => ({
  useFilters: () => ({ scopeQ: "", withScope: (p: string) => p, routerId: null }),
}));
vi.mock("@/hooks/use-router-options", () => ({ useRouterFilter: () => ({ routerId: null, routerIdQ: "" }) }));
vi.mock("@/hooks/use-grafana-url", () => ({ useGrafanaUrl: () => null }));

const router = (over: Partial<RouterMetrics> = {}): RouterMetrics => ({
  routerId: "eth-prod",
  attribution: "own",
  sharedWith: [],
  spec: "ETH1",
  name: "Ethereum",
  color: "#627eea",
  requests: 1000,
  availability: 1,
  errorRate: 0,
  p95Ms: 52,
  qos: null,
  health: "operational",
  latestBlock: 123456,
  upstreamCount: 1,
  ...over,
});

const kpi = (value: number) => ({ value, prior: null });
const summary: HeroSummary = {
  requestsServed: kpi(51_380_000),
  successRate: kpi(0.9999),
  effectiveReadP95Ms: kpi(40),
  staleCaught: kpi(0),
  retriesRecovered: kpi(12),
  cacheOffloadPct: kpi(0.4),
  upstreamCount: 3,
  chainCount: 2,
  health: "operational",
  emitted: { retries: true, cache: true },
  lastUpdated: null,
};

const skelCount = (html: string) => (html.match(/gw-skel/g) ?? []).length;

beforeEach(() => {
  fixture.answer = () => ({ data: undefined, isLoading: false, isValidating: false });
});

describe("window change on the Metrics page", () => {
  const table = () => renderToStaticMarkup(createElement(RouterOverview, { onChainClick: () => {}, chainFilter: null, timeWindow: "21d" }));

  it("keeps the previous window's routers up, without skeleton rows beside them", () => {
    // SWR on a new key with `keepPreviousData`: loading, and the old rows still in `data`.
    fixture.answer = (p) => p.includes("routers-rollup")
      ? { data: { routers: [router()] }, isLoading: true, isValidating: true }
      : { data: undefined, isLoading: false, isValidating: false };
    const html = table();
    expect(html).toContain("eth-prod");
    expect(skelCount(html)).toBe(0);
    expect(html).toContain("Refreshing routers");
  });

  it("dims the rows on a window change, not on a poll of the same window", () => {
    const tbody = (html: string) => html.slice(html.indexOf("<tbody"), html.indexOf(">", html.indexOf("<tbody")));
    fixture.answer = (p) => p.includes("routers-rollup")
      ? { data: { routers: [router()] }, isLoading: false, isValidating: true }
      : { data: undefined, isLoading: false, isValidating: false };
    const polling = table();
    expect(polling).toContain("Refreshing routers");
    expect(tbody(polling)).toContain("opacity:1");
    fixture.answer = (p) => p.includes("routers-rollup")
      ? { data: { routers: [router()] }, isLoading: true, isValidating: true }
      : { data: undefined, isLoading: false, isValidating: false };
    expect(tbody(table())).toContain("opacity:0.55");
  });

  it("draws skeleton rows only with no rows to show, one cell per column", () => {
    fixture.answer = (p) => p.includes("routers-rollup")
      ? { data: undefined, isLoading: true, isValidating: true }
      : { data: undefined, isLoading: false, isValidating: false };
    const html = table();
    const columns = (html.match(/<th[ >]/g) ?? []).length;
    const body = html.slice(html.indexOf("<tbody"));
    const firstRow = body.slice(body.indexOf("<tr"), body.indexOf("</tr>"));
    expect(columns).toBe(8);
    expect((firstRow.match(/<td/g) ?? []).length).toBe(columns);
  });

  it("keeps the previous window's KPI values up while the next window loads", () => {
    fixture.answer = (p) => p.includes("dashboard-summary")
      ? { data: summary, isLoading: true, isValidating: true }
      : { data: { available: true, value: 3 }, isLoading: true, isValidating: true };
    const html = renderToStaticMarkup(createElement(HeroPanel, { tw: "21d" }));
    expect(html).toContain("99.99%");
    expect(skelCount(html)).toBe(0);
  });
});

describe("an open row holds a live list still", () => {
  const shown = [{ guid: "a" }, { guid: "b" }];
  it("while the open row is on screen", () => {
    expect(openRowShown("a", shown)).toBe(true);
  });
  it("not once a filter, a page or a window change has taken it out of view, nor with no row open", () => {
    expect(openRowShown("gone", shown)).toBe(false);
    expect(openRowShown("a", [])).toBe(false);
    expect(openRowShown(null, shown)).toBe(false);
  });
});
