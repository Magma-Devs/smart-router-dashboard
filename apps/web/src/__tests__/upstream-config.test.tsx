import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouterConfiguration } from "@sr/shared";
import { UpstreamsView } from "@/components/upstreams/UpstreamsView";
import { UpstreamsView as LegacyUpstreamsView } from "@/legacy/components/upstreams/UpstreamsView";

const fixture = vi.hoisted(() => ({
  data: undefined as RouterConfiguration | undefined,
  error: undefined as Error | undefined,
}));
vi.mock("@/hooks/use-api", () => ({
  useApi: (path: string) =>
    path === "/api/config/routers" ? fixture : { data: { upstreams: [] } },
}));
vi.mock("@/components/gateway/FiltersProvider", () => ({
  useFilters: () => ({ timeWindow: "1d", scopeQ: "", setTimeWindow: () => {} }),
}));
vi.mock("@/hooks/use-chain-options", () => ({
  useChainFilter: () => ({ chain: null, select: () => {} }),
  useChainOptions: () => ({ chains: [] }),
  withMutedRows: () => [],
}));
vi.mock("@/hooks/use-router-options", () => ({ useRouterFilter: () => ({ routerId: null }) }));
vi.mock("@/legacy/hooks/use-router-options", () => ({
  useRouterFilter: () => ({ routerId: null }),
}));
vi.mock("@/components/gateway/RouterFilterSelect", () => ({ RouterFilterSelect: () => null }));
vi.mock("@/legacy/components/gateway/RouterFilterSelect", () => ({
  RouterFilterSelect: () => null,
}));

beforeEach(() => {
  fixture.data = undefined;
  fixture.error = undefined;
});

describe.each([
  { name: "new UI", View: UpstreamsView, emptyTitle: "No upstreams configured" },
  { name: "default UI", View: LegacyUpstreamsView, emptyTitle: "No routers configured" },
])("MAG-4227: $name", ({ View, emptyTitle }) => {
  const render = () => renderToStaticMarkup(createElement(View));

  it("shows loading instead of an empty page or a missing-config claim", () => {
    const html = render();
    expect(html).toContain("Loading upstream configuration");
    expect(html).not.toContain("No upstreams yet");
    expect(html).not.toContain("configuration is not connected");
  });

  it("explains missing configuration without claiming Kubernetes is required", () => {
    fixture.data = { routers: [], configuration: { status: "missing" } };
    const html = render();
    expect(html).toContain("Router configuration is not connected");
    expect(html).toContain("Docker Compose is supported; Kubernetes is not required");
    expect(html).toContain("View configuration setup");
    expect(html).not.toContain("Add your first upstream");
  });

  it.each([
    ["unreadable", "Router configuration cannot be read"],
    ["invalid", "Router configuration is invalid"],
    ["unsupported", "Router configuration format is not supported"],
  ] as const)("explains %s configuration separately", (status, heading) => {
    fixture.data = { routers: [], configuration: { status } };
    expect(render()).toContain(heading);
  });

  it("distinguishes API failures from an empty configuration without exposing error details", () => {
    fixture.error = new Error("https://api.example.com/private-key");
    const html = render();
    expect(html).toContain("Unable to load upstream configuration");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("private-key");
    expect(html).not.toContain("No upstreams configured");
  });

  it("does not call a valid empty file a missing mount", () => {
    fixture.data = { routers: [], configuration: { status: "loaded", format: "sr-config" } };
    const html = render();
    expect(html).toContain(emptyTitle);
    expect(html).toContain("loaded successfully");
    expect(html).not.toContain("configuration is not connected");
  });

  it("can explain an empty response from an older API without load diagnostics", () => {
    fixture.data = { routers: [] } as unknown as RouterConfiguration;
    expect(render()).toContain("No upstream configuration available");
  });
});
