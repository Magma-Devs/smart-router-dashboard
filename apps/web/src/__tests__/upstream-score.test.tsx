import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { UpstreamDetail, UpstreamMetrics } from "@sr/shared";
import { PMBody } from "@/legacy/components/metrics/upstream/PMBody";

vi.mock("@/hooks/use-api", () => ({ useApi: () => ({ data: undefined, isLoading: false }) }));
vi.mock("@/components/gateway/FiltersProvider", () => ({ useFilters: () => ({ scopeQ: "" }) }));

it("MAG-4226: an availability score of 100 does not claim 100% uptime", () => {
  const pm = {
    endpointId: "down",
    spec: "ETH1",
    health: "unhealthy",
    p95Ms: 24,
  } as UpstreamMetrics;
  const detail = {
    spec: "ETH1",
    scores: { availability: 1, composite: 1 },
    scoreSeries: {},
    volume: { total: [], read: [], write: null, batch: null },
    latencySeries: { p50: [], p95: [], p99: [] },
    recentErrors: [],
    nodeErrorsByMethod: [],
    errorSplit: { node: 0, protocol: 0, transport: 0 },
    crossValidation: { agreements: 10, disagreements: 0, disagreementRate: 0 },
    emitted: { errorsByCode: false, recentErrors: false },
  } as unknown as UpstreamDetail;
  const html = renderToStaticMarkup(
    createElement(PMBody, { pm, detail, name: "down", timeWindow: "5m" }),
  );
  expect(html).toContain("Availability score");
  expect(html).toContain("optimizer score");
  expect(html).not.toContain("% up");
  expect(html).not.toContain("var(--ok)");
});
