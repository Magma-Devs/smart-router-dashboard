import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpstreamDetail, UpstreamMetrics } from "@sr/shared";
import { PMRoster } from "@/components/metrics/upstream/PMRoster";
import { PMRoster as LegacyRoster } from "@/legacy/components/metrics/upstream/PMRoster";
import { UpstreamMetricsTab } from "@/components/metrics/upstream/UpstreamMetricsTab";
import { UpstreamMetricsTab as LegacyTab } from "@/legacy/components/metrics/upstream/UpstreamMetricsTab";
import { DeploymentHealthBadge } from "@/components/gateway/DeploymentHealth";

const fixture = vi.hoisted(() => ({
  rows: [] as UpstreamMetrics[],
  detail: undefined as UpstreamDetail | undefined,
}));
vi.mock("@/hooks/use-api", () => ({
  useApi: (path: string | null) => ({
    data: path?.includes("/upstream-detail?") ? fixture.detail : { upstreams: fixture.rows },
    isLoading: false,
    isValidating: false,
  }),
}));
vi.mock("@/components/gateway/FiltersProvider", () => ({
  useFilters: () => ({ scopeQ: "", routerId: null }),
}));
vi.mock("@/hooks/use-router-options", () => ({ useRouterFilter: () => ({ routerId: null }) }));
vi.mock("@/legacy/hooks/use-router-options", () => ({
  useRouterFilter: () => ({ routerId: null }),
}));
// Check when diagnostics remain accessible without coupling to chart geometry.
vi.mock("@/components/metrics/upstream/PMBody", () => ({
  PMBody: () => createElement("div", null, "Request diagnostics"),
}));
vi.mock("@/legacy/components/metrics/upstream/PMBody", () => ({
  PMBody: () => createElement("div", null, "Request diagnostics"),
}));

const upstream = (over: Partial<UpstreamMetrics> = {}): UpstreamMetrics => ({
  endpointId: "bitvavo-test",
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
});

describe.each([
  { name: "new UI", Roster: PMRoster, Tab: UpstreamMetricsTab },
  { name: "default UI", Roster: LegacyRoster, Tab: LegacyTab },
])("MAG-4226: $name", ({ Roster, Tab }) => {
  it("replaces uptime with a visible unhealthy status even with almost 100% success", () => {
    const html = renderToStaticMarkup(
      createElement(Roster, {
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
      createElement(Tab, { timeWindow: "5m", chainFilter: "ETH1" }),
    );
    expect(html).toContain("This upstream is unhealthy");
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
      createElement(Tab, { timeWindow: "5m", chainFilter: "ETH1" }),
    );
    expect(html).toContain("Unknown");
    expect(html).toContain("health is unknown");
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
      createElement(Tab, { timeWindow: "5m", chainFilter: "ETH1" }),
    );
    expect(html).toContain("Operational");
    expect(html).not.toContain("This upstream is unhealthy");
    expect(html).not.toContain("100.00%");
  });

  it("does not colour historical successful polls or QoS green on an unhealthy idle row", () => {
    fixture.rows = [
      upstream({ requests: 0, uptime: null, errorRate: null, polls: { ok: 10, failed: 0 } }),
    ];
    const html = renderToStaticMarkup(
      createElement(Tab, { timeWindow: "5m", chainFilter: "ETH1" }),
    );
    expect(html).toContain("10 answered");
    expect(html).toContain("Unhealthy");
    expect(html).not.toContain("var(--ok)");
  });

  it("keeps diagnostics accessible when every routed request failed", () => {
    fixture.rows = [upstream({ requests: 0, uptime: 0, errorRate: 1 })];
    const html = renderToStaticMarkup(
      createElement(Tab, { timeWindow: "5m", chainFilter: "ETH1" }),
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
      createElement(Tab, { timeWindow: "5m", chainFilter: "ETH1" }),
    );
    expect(html).not.toContain("50.00%");
  });
});

it("does not claim all systems normal when an upstream is unhealthy", () => {
  const html = renderToStaticMarkup(
    createElement(DeploymentHealthBadge, { health: "operational", upstreams: fixture.rows }),
  );
  expect(html).toContain("Router operational · 1 upstream unhealthy");
  expect(html).not.toContain("All systems normal");
});
