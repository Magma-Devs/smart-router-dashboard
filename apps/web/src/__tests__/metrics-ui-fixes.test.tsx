import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HeroSummary, RelayAttempt, RouterMetrics } from "@sr/shared";
import { RouterOverview } from "@/components/metrics/RouterOverview";
import { HeroPanel } from "@/components/metrics/HeroPanel";
import { chainsTitle, chainWords, everyNodeRefused, fmtWhen, openRowShown, TxHash, WhenCell } from "@/components/metrics/request-log";
import { RequestBreakdown, type BreakdownProps } from "@/components/metrics/request-breakdown";

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

/** An opened row's breakdown with the given facts: a read that succeeded, no tries logged. */
const breakdown = (facts: BreakdownProps["facts"], over: Partial<BreakdownProps> = {}): BreakdownProps => ({
  spec: null, chain: "Ethereum", method: "eth_call", time: 0, guid: "7699463364114495303", tookMs: 12,
  facts, attempts: [], final: null, status: { label: "Success", color: "var(--ok)" }, isWrite: false, ...over,
});

beforeEach(() => {
  fixture.answer = () => ({ data: undefined, isLoading: false, isValidating: false });
});

describe("window change on the Metrics page", () => {
  const table = () => renderToStaticMarkup(createElement(RouterOverview, { onChainClick: () => {}, chainFilter: null, timeWindow: "21d", drill: { row: null, tile: null }, linked: false, onDrill: () => {} }));

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

  it("capitalises every KPI card's label", () => {
    fixture.answer = (p) => p.includes("dashboard-summary")
      ? { data: summary, isLoading: false, isValidating: false }
      : { data: { available: true, value: 3 }, isLoading: false, isValidating: false };
    const html = renderToStaticMarkup(createElement(HeroPanel, { tw: "1h" }));
    expect(html).toContain("Successful retries");
    expect(html).toContain("Stale responses caught");
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

  it("calls a transaction refused only when every node it went to refused it, and none says it may be on chain", () => {
    const tried = (outcome: RelayAttempt["outcome"], code: string | null = null): RelayAttempt =>
      ({ upstream: `node-${outcome}`, batch: 0, atMs: 0, endMs: 5, outcome, replied: false, code } as RelayAttempt);
    const tx = (attempts: RelayAttempt[], code = "CHAIN_INSUFFICIENT_FUNDS") => ({ outcome: "rejected" as const, attempts, error: { code } });
    expect(everyNodeRefused(tx([tried("failed"), tried("failed"), tried("skipped")]))).toBe(true);
    // The answering node refused it, another took it: it may well be on chain.
    expect(everyNodeRefused(tx([tried("failed"), tried("ok")]))).toBe(false);
    expect(everyNodeRefused(tx([tried("failed"), tried("no-result")]))).toBe(false);
    // The refusal itself says the chain has it.
    expect(everyNodeRefused(tx([tried("failed")], "CHAIN_TX_ALREADY_KNOWN"))).toBe(false);
    expect(everyNodeRefused(tx([tried("failed", "CHAIN_NONCE_TOO_LOW"), tried("failed")]))).toBe(false);
    expect(everyNodeRefused({ ...tx([tried("failed")]), outcome: "accepted" })).toBe(false);
    expect(everyNodeRefused(tx([]))).toBe(false);
  });

  it("links a transaction's hash to the explorer unless every node refused it", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const linked = renderToStaticMarkup(createElement(TxHash, { hash, spec: "ETH1" }));
    const refused = renderToStaticMarkup(createElement(TxHash, { hash, spec: "ETH1", refused: true }));
    expect(linked).toContain("<a ");
    expect(refused).not.toContain("<a ");
    expect(refused).toContain("never saw it");
  });

  it("shows one request ID, Smart Router's, and none of the headers the router got", () => {
    const html = renderToStaticMarkup(createElement(RequestBreakdown, breakdown({ requestId: "req-e7f0", taskId: "task-k1", txId: "txid-t1", requestBytes: 10 })));
    expect(html).toContain("Smart Router request ID");
    expect(html).toContain("7699463364114495303");
    expect(html).not.toMatch(/X-Request-Id|Caller request ID|Task ID|Tx ID|req-e7f0|task-k1|txid-t1/);
    expect(html).toContain("10 B");
  });

  it("links an opened row's block numbers to a chain's explorer where one has a block page", () => {
    const linked = renderToStaticMarkup(createElement(RequestBreakdown, breakdown({ requestedBlock: 5_329_480, seenBlock: 5_329_484 }, { spec: "XLMT" })));
    expect(linked.match(/stellar\.expert\/explorer\/testnet/g)).toHaveLength(2);
    // The router's latest block shows beside the requested block it is compared with.
    const unnamed = renderToStaticMarkup(createElement(RequestBreakdown, breakdown({ requestedBlock: 5_329_480, seenBlock: 5_329_484 })));
    expect(unnamed).toContain("5,329,484");
    expect(unnamed).not.toContain("stellar.expert");
  });

  it("says why a row has no customer", () => {
    expect(renderToStaticMarkup(createElement(WhenCell, { time: 0 }))).toContain("no project-id header");
  });
});
