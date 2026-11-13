import { describe, expect, it } from "vitest";
import type { DeploymentPulse } from "@sr/shared";
import {
  deploymentHealthSummary,
  topbarFigures,
  upstreamHealthNotice,
  upstreamMetricColor,
} from "../upstream-presentation";

describe("MAG-4226: current health takes precedence over historical metrics", () => {
  it.each(["unhealthy", "unknown"] as const)(
    "does not paint past successes green when health is %s",
    (health) => {
      expect(upstreamMetricColor(health, "var(--ok)")).toBe("var(--text-3)");
      expect(upstreamHealthNotice(health)).toContain("selected time window");
    },
  );

  it("keeps historical statistics meaningful for an operational upstream", () => {
    expect(upstreamMetricColor("operational", "var(--warn)")).toBe("var(--warn)");
    expect(upstreamHealthNotice("operational")).toBeNull();
  });

  it("does not call missing health down or disabled", () => {
    expect(upstreamHealthNotice("unknown")).toContain("health is unknown");
    expect(upstreamHealthNotice("unknown")).not.toMatch(/disabled|down|unhealthy/i);
  });

  it("reports partial upstream failure even while the router serves traffic", () => {
    expect(deploymentHealthSummary("operational", { unhealthy: 1, unknown: 0 })).toEqual({
      label: "Router operational · 1 provider unhealthy",
      color: "var(--warn)",
    });
  });

  it("reports missing upstream health and a missing router measurement explicitly", () => {
    expect(deploymentHealthSummary(undefined, undefined)).toEqual({
      label: "Router health unknown",
      color: "var(--warn)",
    });
    expect(deploymentHealthSummary("operational", { unhealthy: 0, unknown: 1 })).toEqual({
      label: "Router operational · 1 provider with no health data",
      color: "var(--warn)",
    });
  });

  it("does not claim that all systems are normal from router health alone", () => {
    expect(deploymentHealthSummary("operational", undefined).label).toBe("Router operational");
    expect(deploymentHealthSummary("unhealthy", { unhealthy: 1, unknown: 0 }).color).toBe(
      "var(--err)",
    );
  });
});

// MAG-5295: on a chain's page the pulse is read for that chain, so the
// provider counts are the chain's. The RPS pill and the router's status are
// the whole router's on every page.
describe("topbarFigures - what the topbar shows from a pulse", () => {
  const onChain: DeploymentPulse = {
    health: "unhealthy",
    throughputRps: 2,
    upstreamHealthCounts: { unhealthy: 1, unknown: 0 },
    allChains: { health: "operational", throughputRps: 50 },
    lastUpdated: "2026-11-13T00:00:00.000Z",
  };

  it("shows the whole router's status and RPS beside the chain's provider counts", () => {
    expect(topbarFigures(onChain)).toEqual({ health: "operational", rps: 50, counts: { unhealthy: 1, unknown: 0 } });
    expect(deploymentHealthSummary(topbarFigures(onChain).health, topbarFigures(onChain).counts).label)
      .toBe("Router operational · 1 provider unhealthy");
  });

  it("falls back to the pulse's own figures from an api that sends no allChains", () => {
    const { allChains: _dropped, ...older } = onChain;
    expect(topbarFigures(older as DeploymentPulse)).toEqual({ health: "unhealthy", rps: 2, counts: { unhealthy: 1, unknown: 0 } });
  });

  it("has nothing to show before the first read", () => {
    expect(topbarFigures(undefined)).toEqual({ health: undefined, rps: undefined, counts: undefined });
  });
});
