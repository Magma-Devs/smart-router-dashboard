import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HeroSummary, RouterMetrics } from "@sr/shared";
import { RouterOverview } from "@/components/metrics/RouterOverview";
import { HeroPanel } from "@/components/metrics/HeroPanel";
import { chainsTitle, chainWords, TxHash, WhenCell } from "@/components/metrics/request-log";
import { fmtDateTime } from "@/lib/datetime";
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

describe("log rows", () => {
  it("dates every row, today's included", () => {
    const now = new Date();
    const month = now.toLocaleString("en-US", { month: "short" });
    expect(fmtDateTime(now.getTime())).toContain(`${month} ${now.getDate()},`);
  });

  it("names a few candidate chains and counts many, listing them on hover", () => {
    expect(chainWords({ spec: null, specs: ["ETH1", "BASE"] })).toBe("Ethereum or Base");
    const many = { spec: null, specs: ["ETH1", "BASE", "ARBITRUM", "OPTM", "POLYGON"] };
    expect(chainWords(many)).toBe("One of 5 chains");
    expect(chainsTitle(many)).toContain("Ethereum, Base");
    expect(chainsTitle({ spec: "ETH1" })).toBeUndefined();
  });

  it("links a transaction's hash to the chain's explorer, a rejected one's too", () => {
    const hash = `0x${"ab".repeat(32)}`;
    expect(renderToStaticMarkup(createElement(TxHash, { hash, spec: "ETH1" }))).toContain(`https://etherscan.io/tx/${hash}`);
  });

  it("shows one request ID, Smart Router's, and none of the headers the router got", () => {
    const html = renderToStaticMarkup(createElement(RequestBreakdown, breakdown({ requestId: "req-e7f0", taskId: "task-k1", txId: "txid-t1", requestBytes: 10 })));
    expect(html).toContain("Smart Router request ID");
    expect(html).toContain("7699463364114495303");
    expect(html).not.toMatch(/X-Request-Id|Caller request ID|Task ID|Tx ID|req-e7f0|task-k1|txid-t1/);
    // Sizes aren't shown: they answered no question a reader had.
    expect(html).not.toContain("10 B");
  });

  it("links an opened row's block numbers to a chain's explorer where one has a block page", () => {
    const linked = renderToStaticMarkup(createElement(RequestBreakdown, breakdown({ requestedBlock: 5_329_480, seenBlock: 5_329_484 }, { spec: "XLMT" })));
    expect(linked.match(/stellar\.expert\/explorer\/testnet/g)).toHaveLength(2);
    // The router's latest block shows on its own too, and without a chain it is plain text.
    const unnamed = renderToStaticMarkup(createElement(RequestBreakdown, breakdown({ seenBlock: 5_329_484 })));
    expect(unnamed).toContain("5,329,484");
    expect(unnamed).not.toContain("stellar.expert");
  });

  it("doesn't count the cache among a request's providers", () => {
    const tri = (upstream: string, outcome: "ok" | "failed", replied = false) =>
      ({ upstream, batch: 0, outcome, replied, code: null, retryable: null, message: null, note: null, atMs: 0, endMs: null });
    const html = (attempts: BreakdownProps["attempts"]) => renderToStaticMarkup(createElement(RequestBreakdown, breakdown({}, { attempts })));
    expect(html([tri("eth-tenderly", "failed"), tri("Cached", "ok", true)])).toContain("1 provider and the cache");
    expect(html([tri("Cached", "ok", true)])).toContain("the cache");
    expect(html([tri("eth-tenderly", "failed"), tri("eth-publicnode", "ok", true)])).toContain("2 providers");
  });

  describe("an opened row's wording", () => {
    const tri = (upstream: string, outcome: "ok" | "failed", over: Partial<BreakdownProps["attempts"][number]> = {}): BreakdownProps["attempts"][number] =>
      ({ upstream, batch: 0, outcome, replied: false, code: null, retryable: null, message: null, note: null, atMs: 0, endMs: 10, ...over });
    const html = (over: Partial<BreakdownProps>) => renderToStaticMarkup(createElement(RequestBreakdown, breakdown({}, over)));
    const count = (s: string, word: string) => s.split(word).length - 1;

    it("tags an answer from the cache beside the status and in the last step", () => {
      const hit = tri("Cached", "ok", { replied: true });
      expect(count(html({ attempts: [hit], final: { from: "provider", attempt: hit } }), "From cache")).toBe(2);
      // A cache that was looked in but didn't give the answer isn't tagged.
      const miss = tri("Cached", "failed");
      const sent = tri("eth-tenderly", "ok", { batch: 1, replied: true });
      expect(html({ attempts: [miss, sent], final: { from: "provider", attempt: sent } })).not.toContain("From cache");
    });

    it("names the router's own error in the last step, once where the status already says it", () => {
      const own = { from: "router" as const, code: "PROTOCOL_NO_PROVIDERS" };
      const error = { label: "Router error", color: "var(--err)" };
      expect(html({ final: own, status: error })).toMatch(/The router&#x27;s own error: <span[^>]*>No providers<\/span>/);
      const named = html({ final: own, status: { ...error, label: "No providers" } });
      expect(named).toContain("The router&#x27;s own error</span>");
    });

    it("doesn't mark the provider whose answer went back: the last step names it", () => {
      const sent = tri("eth-tenderly", "ok", { replied: true });
      const out = html({ attempts: [sent], final: { from: "provider", attempt: sent } });
      expect(out).not.toContain("→ client");
      expect(out).toMatch(/<span class="gw-mono">eth-tenderly<\/span>&#x27;s answer went back/);
    });

    it("draws an error's source only where its code determines one", () => {
      const failed = (code: string) => html({ attempts: [tri("eth-tenderly", "failed", { code })] });
      expect(failed("PROTOCOL_CONNECTION_REFUSED")).toMatch(/Source: <span[^>]*>Provider<\/span>/);
      const unclear = failed("NODE_SERVER_ERROR");
      expect(unclear).toContain("Server error");
      expect(unclear).not.toContain("Source: ");
      // The router's own error, beside the status.
      expect(html({ final: { from: "router", code: "PROTOCOL_NO_PROVIDERS" } })).toMatch(/Source: <span[^>]*>Router<\/span>/);
      expect(html({ final: { from: "router", code: "PROTOCOL_INSUFFICIENT_PROVIDERS" } })).not.toContain("Source: ");
    });
  });

  it("says why a row has no customer", () => {
    expect(renderToStaticMarkup(createElement(WhenCell, { time: 0 }))).toContain("no project-id header");
  });
});
