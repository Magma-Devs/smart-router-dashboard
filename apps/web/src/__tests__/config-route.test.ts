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
