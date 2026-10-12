import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/config/route";

async function grafanaUrl(): Promise<unknown> {
  const body = (await GET().json()) as { grafanaUrl: unknown };
  return body.grafanaUrl;
}

describe("GET /api/config grafanaUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is null when no Grafana is configured, so the logs button is hidden", async () => {
    vi.stubEnv("DASHBOARD_GRAFANA_URL", undefined);
    vi.stubEnv("NEXT_PUBLIC_GRAFANA_URL", undefined);
    expect(await grafanaUrl()).toBeNull();
  });

  it("treats an empty value as unset (compose passes `${DASHBOARD_GRAFANA_URL:-}`)", async () => {
    vi.stubEnv("DASHBOARD_GRAFANA_URL", "");
    vi.stubEnv("NEXT_PUBLIC_GRAFANA_URL", "");
    expect(await grafanaUrl()).toBeNull();
  });

  it("returns the runtime DASHBOARD_GRAFANA_URL over the build-time one", async () => {
    vi.stubEnv("DASHBOARD_GRAFANA_URL", "https://grafana.example.com");
    vi.stubEnv("NEXT_PUBLIC_GRAFANA_URL", "http://localhost:3001");
    expect(await grafanaUrl()).toBe("https://grafana.example.com");
  });

  it("falls back to NEXT_PUBLIC_GRAFANA_URL", async () => {
    vi.stubEnv("DASHBOARD_GRAFANA_URL", "");
    vi.stubEnv("NEXT_PUBLIC_GRAFANA_URL", "http://localhost:3001");
    expect(await grafanaUrl()).toBe("http://localhost:3001");
  });
});

describe("GET /api/config grafanaDashboardUrl", () => {
  const reportsUrl = "https://magmadevs.grafana.net/d/sr-gk8-interactive-war-room/gk8-e28094-customer-experience?from=now-5m&to=now&timezone=browser&var-chain=$__all&var-provider=$__all&refresh=5m";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([undefined, "", " \t\n "])("hides the link when configured as %j", async (value) => {
    vi.stubEnv("DASHBOARD_GRAFANA_DASHBOARD_URL", value);
    expect(await GET().json()).toHaveProperty("grafanaDashboardUrl", null);
  });

  it("keeps the exact reports URL, including Grafana variables and time parameters", async () => {
    vi.stubEnv("DASHBOARD_GRAFANA_DASHBOARD_URL", reportsUrl);
    expect(await GET().json()).toHaveProperty("grafanaDashboardUrl", reportsUrl);
  });

  it("trims surrounding whitespace", async () => {
    vi.stubEnv("DASHBOARD_GRAFANA_DASHBOARD_URL", `  ${reportsUrl}  `);
    expect(await GET().json()).toHaveProperty("grafanaDashboardUrl", reportsUrl);
  });

  it("keeps reports and logs independent, including when reports are unset", async () => {
    vi.stubEnv("DASHBOARD_GRAFANA_DASHBOARD_URL", reportsUrl);
    vi.stubEnv("DASHBOARD_GRAFANA_URL", "https://logs.example.com");
    expect(await GET().json()).toMatchObject({
      grafanaDashboardUrl: reportsUrl,
      grafanaUrl: "https://logs.example.com",
    });
    vi.stubEnv("DASHBOARD_GRAFANA_DASHBOARD_URL", "");
    expect(await GET().json()).toMatchObject({
      grafanaDashboardUrl: null,
      grafanaUrl: "https://logs.example.com",
    });
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<h1>Grafana</h1>",
    "/d/customer/reports",
    "https:grafana.example.com/d/reports",
    "https:/grafana.example.com/d/reports",
    "//grafana.example.com/d/reports",
    "https://",
    "https://user:password@grafana.example.com/d/reports",
  ])("hides an invalid external URL: %s", async (value) => {
    vi.stubEnv("DASHBOARD_GRAFANA_DASHBOARD_URL", value);
    expect(await GET().json()).toHaveProperty("grafanaDashboardUrl", null);
  });
});
