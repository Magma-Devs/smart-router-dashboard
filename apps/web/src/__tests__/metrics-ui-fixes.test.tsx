import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HeroSummary, RouterMetrics } from "@sr/shared";
import { RouterOverview } from "@/components/metrics/RouterOverview";
import { RouterOverview as LegacyRouterOverview } from "@/legacy/components/metrics/RouterOverview";
import { HeroPanel } from "@/components/metrics/HeroPanel";
import { HeroPanel as LegacyHeroPanel } from "@/legacy/components/metrics/HeroPanel";
import { CallFactsLine, chainsTitle, chainWords, CustomerCell, fmtWhen, RequestIdLine, TxHash } from "@/components/metrics/request-log";

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

describe.each([
  { name: "new UI", Table: RouterOverview, Hero: HeroPanel },
  { name: "default UI", Table: LegacyRouterOverview, Hero: LegacyHeroPanel },
])("window change on the Metrics page: $name", ({ Table, Hero }) => {
  const table = () => renderToStaticMarkup(createElement(Table, { onChainClick: () => {}, chainFilter: null, timeWindow: "21d" }));

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
    const html = renderToStaticMarkup(createElement(Hero, { tw: "21d" }));
    expect(html).toContain("99.99%");
    expect(skelCount(html)).toBe(0);
  });

  it("capitalises every KPI card's label", () => {
    fixture.answer = (p) => p.includes("dashboard-summary")
      ? { data: summary, isLoading: false, isValidating: false }
      : { data: { available: true, value: 3 }, isLoading: false, isValidating: false };
    const html = renderToStaticMarkup(createElement(Hero, { tw: "1h" }));
    expect(html).toContain("Successful retries");
    expect(html).toContain("Stale responses caught");
  });
});

describe("log rows", () => {
  it("dates every row, today's included", () => {
    const now = new Date();
    const month = now.toLocaleString("en-US", { month: "short" });
    expect(fmtWhen(now.getTime())).toContain(`${month} ${now.getDate()},`);
  });

  it("names a few candidate chains and counts many, listing them on hover", () => {
    expect(chainWords({ spec: null, specs: ["ETH1", "BASE"] })).toBe("Ethereum or Base");
    const many = { spec: null, specs: ["ETH1", "BASE", "ARBITRUM", "OPTM", "POLYGON"] };
    expect(chainWords(many)).toBe("One of 5 chains");
    expect(chainsTitle(many)).toContain("Ethereum, Base");
    expect(chainsTitle({ spec: "ETH1" })).toBeUndefined();
  });

  it("links a transaction's hash to the explorer unless every node refused it", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const linked = renderToStaticMarkup(createElement(TxHash, { hash, spec: "ETH1" }));
    const refused = renderToStaticMarkup(createElement(TxHash, { hash, spec: "ETH1", refused: true }));
    expect(linked).toContain("<a ");
    expect(refused).not.toContain("<a ");
    expect(refused).toContain("never saw it");
  });

  it("names the caller's ids by their header and the router's as Smart Router's", () => {
    const facts = renderToStaticMarkup(createElement(CallFactsLine, { row: { requestId: "e7f0", txId: "t-1" }, spec: null }));
    expect(facts).toContain("Caller&#x27;s X-Request-Id");
    expect(facts).toContain("Caller&#x27;s X-Tx-Id");
    const foot = renderToStaticMarkup(createElement(RequestIdLine, { id: "7699463364114495303", startMs: 0, tookMs: null }));
    expect(foot).toContain("Smart Router request ID");
  });

  it("links the router's latest block to a chain's explorer where one has a block page", () => {
    const html = renderToStaticMarkup(createElement(CallFactsLine, { row: { seenBlock: 5_329_484 }, spec: "XLMT" }));
    expect(html).toContain("stellar.expert/explorer/testnet");
  });

  it("says why a row has no customer", () => {
    expect(renderToStaticMarkup(createElement(CustomerCell, {}))).toContain("no project-id header");
  });
});
