import { describe, expect, it } from "vitest";
import {
  deploymentHealthSummary,
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
      label: "Router operational · 1 upstream unhealthy",
      color: "var(--warn)",
    });
  });

  it("reports missing upstream health and a missing router measurement explicitly", () => {
    expect(deploymentHealthSummary(undefined, undefined)).toEqual({
      label: "Router health unknown",
      color: "var(--warn)",
    });
    expect(deploymentHealthSummary("operational", { unhealthy: 0, unknown: 1 })).toEqual({
      label: "Router operational · 1 upstream unknown",
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
