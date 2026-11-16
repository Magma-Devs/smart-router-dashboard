import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ErrorRequestsReport, RelayAttempt, UpstreamDetail, UpstreamMetrics } from "@sr/shared";
import { PMRoster } from "@/components/metrics/upstream/PMRoster";
import { UpstreamMetricsTab } from "@/components/metrics/upstream/UpstreamMetricsTab";
import { UpstreamHealthNotice } from "@/components/metrics/upstream/UpstreamHealthNotice";
import { DeploymentHealthBadge, openOnThisPage } from "@/components/gateway/DeploymentHealth";

const fixture = vi.hoisted(() => ({
  rows: [] as UpstreamMetrics[],
  detail: undefined as UpstreamDetail | undefined,
  errors: undefined as ErrorRequestsReport | undefined,
  read: [] as string[],
}));
vi.mock("@/hooks/use-api", () => ({
  useApi: (path: string | null) => {
    if (path) fixture.read.push(path);
    return {
      data: path?.includes("/upstream-detail?") ? fixture.detail
        : path?.includes("/api/error-requests?") ? fixture.errors
          : { upstreams: fixture.rows },
      isLoading: false,
      isValidating: false,
    };
  },
}));
vi.mock("@/components/gateway/FiltersProvider", () => ({
  useFilters: () => ({ scopeQ: "", routerId: null }),
}));
vi.mock("@/hooks/use-router-options", () => ({ useRouterFilter: () => ({ routerId: null }) }));
// Check when diagnostics remain accessible without coupling to chart geometry.
vi.mock("@/components/metrics/upstream/PMBody", () => ({
  PMBody: () => createElement("div", null, "Request diagnostics"),
}));

const upstream = (over: Partial<UpstreamMetrics> = {}): UpstreamMetrics => ({
  endpointId: "fixture-upstream",
  spec: "ETH1",
  requests: 100,
  uptime: 0.999999,
  p95Ms: 24,
  errorRate: 0,
  scores: { composite: 1 },
  scoreSource: "optimizer",
  polls: { ok: 0, failed: 10 },
  health: "unhealthy",
  latestBlock: 123456,
  blockLag: 0,
  behindSec: 0,
  stale: false,
  role: "primary",
  apiInterface: "jsonrpc",
  inFlight: 0,
  routerIds: ["ETH1"],
  ...over,
});

beforeEach(() => {
  fixture.rows = [upstream()];
  fixture.detail = undefined;
  fixture.errors = undefined;
  fixture.read = [];
});

describe("MAG-4226", () => {
  it("replaces uptime with a visible unhealthy status even with almost 100% success", () => {
    const html = renderToStaticMarkup(
      createElement(PMRoster, {
        rows: fixture.rows,
        activeKey: null,
        onSelect: () => {},
        timeWindow: "5m",
      }),
    );
    expect(html).toContain("Status");
    expect(html).toContain("Unhealthy");
    expect(html).not.toContain("Uptime");
    expect(html).not.toContain("100.00%");
    expect(html).toContain("Last reported block");
    expect(html).toContain("123,456");
  });

  it("keeps the historical percentage and error rate neutral while surfacing current failure", () => {
    const html = renderToStaticMarkup(
      createElement(UpstreamMetricsTab, { timeWindow: "5m", chainFilter: "ETH1" }),
    );
    expect(html).toContain("This provider is unhealthy");
    expect(html).toContain("Request success rate");
    expect(html).toContain("100.00%");
    expect(html).toContain("Historical · last");
    expect(html).toContain("0.00%");
    expect(html).not.toContain("var(--ok)");
    expect(html).toContain("Request diagnostics");
  });

  it("shows unknown health explicitly without claiming failure or inventing success", () => {
    fixture.rows = [
      upstream({
        health: "unknown",
        requests: 0,
        uptime: null,
        errorRate: null,
        scores: {},
        latestBlock: null,
        polls: null,
      }),
    ];
    const html = renderToStaticMarkup(
      createElement(UpstreamMetricsTab, { timeWindow: "5m", chainFilter: "ETH1" }),
    );
    expect(html).toContain("Unknown");
    expect(html).toContain("health is not known");
    expect(html).toContain("var(--warn)");
    expect(html).toContain("No data yet");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("100.00%");
    expect(html).not.toContain("Unhealthy");
    expect(html).not.toContain("Operational");
  });

  it("keeps a healthy idle backup operational, with no manufactured success percentage", () => {
    fixture.rows = [
      upstream({
        health: "operational",
        role: "backup",
        requests: 0,
        uptime: null,
        errorRate: null,
      }),
    ];
    const html = renderToStaticMarkup(
      createElement(UpstreamMetricsTab, { timeWindow: "5m", chainFilter: "ETH1" }),
    );
    expect(html).toContain("Operational");
    expect(html).not.toContain("This provider is unhealthy");
    expect(html).not.toContain("100.00%");
  });

  it("does not colour historical successful polls or QoS green on an unhealthy idle row", () => {
    fixture.rows = [
      upstream({ requests: 0, uptime: null, errorRate: null, polls: { ok: 10, failed: 0 } }),
    ];
    const html = renderToStaticMarkup(
      createElement(UpstreamMetricsTab, { timeWindow: "5m", chainFilter: "ETH1" }),
    );
    expect(html).toContain("10 answered");
    expect(html).toContain("Unhealthy");
    expect(html).not.toContain("var(--ok)");
  });

  it("keeps diagnostics accessible when every routed request failed", () => {
    fixture.rows = [upstream({ requests: 0, uptime: 0, errorRate: 1 })];
    const html = renderToStaticMarkup(
      createElement(UpstreamMetricsTab, { timeWindow: "5m", chainFilter: "ETH1" }),
    );
    expect(html).toContain("Request diagnostics");
    expect(html).toContain("0.00%");
    expect(html).toContain("100.00%");
    expect(html).not.toContain("var(--ok)");
  });

  it("does not show a previous upstream's percentage while another one loads", () => {
    fixture.detail = {
      endpointId: "other",
      spec: "ETH1",
      requests: 50,
      availabilityWindows: { last1h: 0.5, last24h: 0.5, last7d: 0.5 },
    } as UpstreamDetail;
    const html = renderToStaticMarkup(
      createElement(UpstreamMetricsTab, { timeWindow: "5m", chainFilter: "ETH1" }),
    );
    expect(html).not.toContain("50.00%");
  });
});

it("does not claim all systems normal when an upstream is unhealthy", () => {
  const html = renderToStaticMarkup(
    createElement(DeploymentHealthBadge, {
      health: "operational",
      counts: { unhealthy: 1, unknown: 0 },
    }),
  );
  expect(html).toContain("1 provider unhealthy");
  expect(html).not.toContain("operational");
});

it("shows loading separately from measured unknown health", () => {
  const html = renderToStaticMarkup(
    createElement(DeploymentHealthBadge, { health: undefined, counts: undefined, loading: true }),
  );
  // Nothing until the first answer: no "checking", and no health claimed.
  expect(html).toBe("");
});

it("shows failed refreshes as a problem instead of stale green health", () => {
  const html = renderToStaticMarkup(
    createElement(DeploymentHealthBadge, {
      health: "operational",
      counts: { unhealthy: 0, unknown: 0 },
      error: true,
    }),
  );
  expect(html).toContain("Health data unavailable");
  expect(html).toContain("var(--warn)");
  expect(html).not.toContain("Router operational");
});

/** Unix seconds, 2 h 10 min before now. */
const twoHoursTen = () => Math.floor(Date.now() / 1000) - 130 * 60 - 5;

describe("the unhealthy notice", () => {
  const REASON = "Every block check failed in the last 5 minutes.";
  const notice = (props: Parameters<typeof UpstreamHealthNotice>[0]) => renderToStaticMarkup(createElement(UpstreamHealthNotice, props));
  const attempt = (over: Partial<RelayAttempt> = {}): RelayAttempt => ({
    upstream: "node-a", batch: 0, outcome: "failed", replied: false, code: "PROTOCOL_BAD_GATEWAY", retryable: true,
    message: null, note: null, atMs: 0, endMs: 5, ...over,
  });
  const report = (attempts: RelayAttempt[][], over: Partial<ErrorRequestsReport> = {}): ErrorRequestsReport => ({
    available: true, more: false, nextBefore: null,
    rows: attempts.map((list, i) => ({ guid: String(i), time: 0, spec: "ETH1", method: "eth_call", attempts: list, result: "failed", resolvedBy: null, retried: false }) as ErrorRequestsReport["rows"][number]),
    ...over,
  });

  it("leads with since when, then the reason", () => {
    const html = notice({ health: "unhealthy", reason: REASON, since: twoHoursTen(), sinceOrEarlier: false });
    expect(html).toMatch(/<span[^>]*>Unhealthy since [^<(]+ \(2 h 10 min\)\.<\/span> Every block check failed in the last 5 minutes\./);
    expect(html).not.toContain("This provider is unhealthy");
  });

  it("a start at the edge of the day read is a lower bound", () => {
    const html = notice({ health: "unhealthy", reason: REASON, since: Math.floor(Date.now() / 1000) - 86_400 - 30, sinceOrEarlier: true });
    expect(html).toContain("Unhealthy for over 24 h.</span> Every block check failed");
  });

  it("without a time the status sentence stands alone, and an unknown provider gets no since", () => {
    expect(notice({ health: "unhealthy", reason: REASON, since: null })).toContain("This provider is unhealthy");
    const unknown = notice({ health: "unknown", reason: "No data yet: the router reports nothing about it.", since: twoHoursTen() });
    expect(unknown).not.toContain("since");
    expect(notice({ health: "operational", since: twoHoursTen() })).toBe("");
  });

  it("names the error most failed attempts at this provider had, of how many", () => {
    fixture.errors = report([
      [attempt(), attempt({ upstream: "Node-A" }), attempt({ outcome: "ok" })],
      [attempt(), attempt({ code: "NODE_RATE_LIMITED" }), attempt({ upstream: "other", code: "NODE_RATE_LIMITED" })],
      [attempt({ outcome: "ok", code: "NODE_RATE_LIMITED" }), attempt({ outcome: "cancelled", code: "NODE_RATE_LIMITED" })],
    ]);
    const html = notice({ health: "unhealthy", reason: REASON, since: twoHoursTen(), spec: "ETH1", name: "node-a", onOpenErrors: () => {} });
    expect(html).toContain("Bad gateway</strong> on 3 of 4 failed attempts in the last hour");
    expect(html).toContain("See the requests");
    expect(fixture.read.filter((path) => path.includes("/api/error-requests?"))).toEqual([
      expect.stringMatching(/^\/api\/error-requests\?from=\d+&to=\d+&spec=ETH1&upstream=node-a$/),
    ]);
  });

  it("marks the count as a floor when the logs hold older requests, and offers no link it can't open", () => {
    fixture.errors = report([[attempt(), attempt()]], { more: true });
    const html = notice({ health: "unhealthy", reason: REASON, spec: "ETH1", name: "node-a" });
    expect(html).toContain("Bad gateway</strong> on 2 of 2+ failed attempts in the last hour");
    expect(html).not.toContain("See the requests");
  });

  it("says nothing of errors when the logs can't be read, hold none, or the provider isn't unhealthy", () => {
    const props = { reason: REASON, spec: "ETH1", name: "node-a" } as const;
    fixture.errors = report([[attempt()]], { available: false });
    expect(notice({ health: "unhealthy", ...props })).not.toContain("failed attempts");
    fixture.errors = report([[attempt({ outcome: "ok" })], [attempt({ upstream: "other" })]]);
    expect(notice({ health: "unhealthy", ...props })).not.toContain("failed attempts");
    fixture.errors = undefined;
    expect(notice({ health: "unhealthy", ...props })).not.toContain("failed attempts");
    fixture.errors = report([[attempt()]]);
    expect(notice({ health: "unknown", ...props })).not.toContain("failed attempts");
  });
});

describe("the roster's status lines and Chain column", () => {
  const roster = (rows: UpstreamMetrics[], showChain?: boolean) =>
    renderToStaticMarkup(createElement(PMRoster, { rows, activeKey: null, onSelect: () => {}, timeWindow: "5m", ...(showChain === undefined ? {} : { showChain }) }));

  it("an unhealthy row says why and since when under the status word", () => {
    const html = roster([upstream({ healthCause: "blocked", healthReason: "The router stopped sending it requests: none of its URLs is answering.", healthSince: twoHoursTen(), healthSinceOrEarlier: false })]);
    expect(html).toMatch(/<div>router stopped sending<\/div><div>since [^<(]+ \(2 h 10 min\)<\/div>/);
  });

  it("a row with no data says which kind, and no since", () => {
    const html = roster([upstream({ health: "unknown", healthCause: "no-data", healthSince: twoHoursTen() })]);
    expect(html).toContain("<div>no data yet</div>");
    expect(html).not.toContain("2 h 10 min");
  });

  it("draws no Chain column on a page narrowed to one chain", () => {
    const cells = (html: string) => (html.match(/<td/g) ?? []).length;
    const withChain = roster([upstream()]);
    const without = roster([upstream()], false);
    expect(withChain).toContain(">Chain<");
    expect(without).not.toContain(">Chain<");
    expect(cells(withChain) - cells(without)).toBe(1);
  });
});

describe("a provider's link in the top bar's list", () => {
  const HREF = "/metrics?chain=SOLANA&tab=upstreams&upstream=node-a";
  const click = (over: Partial<Record<"button", number> & Record<"metaKey" | "ctrlKey" | "shiftKey" | "altKey", boolean>> = {}) => {
    const did: string[] = [];
    const e = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over, preventDefault: () => { did.push("preventDefault"); } };
    const win = {
      history: { pushState: (_data: unknown, _unused: string, url?: string | URL | null) => { did.push(`push ${String(url)}`); } },
      dispatchEvent: (event: Event) => { did.push(event.type); return true; },
    };
    return { e, win, did };
  };

  it("on the Metrics page: pushes the URL and tells the page to read it, in that order", () => {
    const { e, win, did } = click();
    expect(openOnThisPage(e, HREF, "/metrics", win)).toBe(true);
    expect(did).toEqual(["preventDefault", `push ${HREF}`, "popstate"]);
  });

  it("from another page the link is followed", () => {
    const { e, win, did } = click();
    expect(openOnThisPage(e, HREF, "/config", win)).toBe(false);
    expect(openOnThisPage(e, HREF, null, win)).toBe(false);
    expect(did).toEqual([]);
  });

  it.each([{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])("a click for a new tab or window follows the link (%o)", (over) => {
    const { e, win, did } = click(over);
    expect(openOnThisPage(e, HREF, "/metrics", win)).toBe(false);
    expect(did).toEqual([]);
  });
});
