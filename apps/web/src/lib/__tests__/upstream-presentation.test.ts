import { describe, expect, it } from "vitest";
import type { DeploymentPulse } from "@sr/shared";
import {
  deploymentHealthSummary,
  blockBehind,
  upstreamCaveat,
  topbarFigures,
  upstreamHealthNotice,
  upstreamMetricColor,
} from "../upstream-presentation";

describe("MAG-4226: current health takes precedence over historical metrics", () => {
  it.each(["unhealthy", "unknown"] as const)(
    "does not paint past successes green when health is %s",
    (health) => {
      expect(upstreamMetricColor(health, "var(--ok)")).toBe("var(--text-3)");
      expect(upstreamHealthNotice(health)).toMatch(/^This provider/);
    },
  );

  it("keeps historical statistics meaningful for an operational upstream", () => {
    expect(upstreamMetricColor("operational", "var(--warn)")).toBe("var(--warn)");
    expect(upstreamHealthNotice("operational")).toBeNull();
  });

  // MAG-5349: its requests are the only health evidence, so they keep their colors.
  it("keeps the request metric colors of an untracked upstream, with a note instead of an alert", () => {
    expect(upstreamMetricColor("untracked", "var(--ok)")).toBe("var(--ok)");
    expect(upstreamMetricColor("untracked", "var(--warn)")).toBe("var(--warn)");
    expect(upstreamHealthNotice("untracked")).toContain("no block height by design");
  });

  it("does not call missing health down or disabled", () => {
    expect(upstreamHealthNotice("unknown")).toContain("health is not known");
    expect(upstreamHealthNotice("unknown")).not.toMatch(/disabled|down|unhealthy/i);
  });

  it("reports partial upstream failure even while the router serves traffic", () => {
    expect(deploymentHealthSummary("operational", { unhealthy: 1, unknown: 0 })).toEqual({
      label: "1 provider unhealthy",
      color: "var(--warn)",
    });
    expect(deploymentHealthSummary("operational", { unhealthy: 2, unknown: 3 })?.label).toBe("2 providers unhealthy · 3 to check");
  });

  it("reports missing upstream health and a missing router measurement explicitly", () => {
    expect(deploymentHealthSummary(undefined, undefined)).toEqual({
      label: "Router health not known",
      color: "var(--warn)",
    });
    expect(deploymentHealthSummary("operational", { unhealthy: 0, unknown: 1 })).toEqual({
      label: "1 provider to check",
      color: "var(--warn)",
    });
  });

  it("says nothing while the router and every provider are fine, and red only for the router's own trouble", () => {
    expect(deploymentHealthSummary("operational", undefined)).toBeNull();
    expect(deploymentHealthSummary("operational", { unhealthy: 0, unknown: 0 })).toBeNull();
    expect(deploymentHealthSummary("unhealthy", { unhealthy: 1, unknown: 0 })).toEqual({
      label: "Router unhealthy · 1 provider unhealthy",
      color: "var(--err)",
    });
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
    attention: [],
    lastUpdated: "2026-11-13T00:00:00.000Z",
  };

  it("shows the whole router's status and RPS beside the chain's provider counts", () => {
    expect(topbarFigures(onChain)).toEqual({ health: "operational", rps: 50, counts: { unhealthy: 1, unknown: 0 } });
    expect(deploymentHealthSummary(topbarFigures(onChain).health, topbarFigures(onChain).counts)?.label)
      .toBe("1 provider unhealthy");
  });

  it("falls back to the pulse's own figures from an api that sends no allChains", () => {
    const { allChains: _dropped, ...older } = onChain;
    expect(topbarFigures(older as DeploymentPulse)).toEqual({ health: "unhealthy", rps: 2, counts: { unhealthy: 1, unknown: 0 } });
  });

  it("has nothing to show before the first read", () => {
    expect(topbarFigures(undefined)).toEqual({ health: undefined, rps: undefined, counts: undefined });
  });
});

describe("upstreamCaveat - what an Operational status leaves out about its block", () => {
  const base = { health: "operational" as const, behindSec: 47, stale: false };

  it("says a provider well behind the chain, or a block that stopped moving", () => {
    expect(upstreamCaveat(base)).toBe("47 s behind the chain");
    expect(upstreamCaveat({ ...base, stale: true })).toBe("its block stopped moving");
  });

  it("stays quiet under 30 seconds behind, or with no block rate", () => {
    expect(upstreamCaveat({ ...base, behindSec: 3 })).toBeNull();
    expect(upstreamCaveat({ ...base, behindSec: null })).toBeNull();
  });

  it("adds nothing to a provider that isn't operational: its status carries the reason", () => {
    expect(upstreamCaveat({ ...base, health: "unhealthy" })).toBeNull();
  });
});

describe("blockBehind - a provider's block against the chain's latest", () => {
  const at = (over: Partial<Parameters<typeof blockBehind>[0]> = {}) => ({ latestBlock: 1_000, blockLag: 0, behindSec: 0, stale: false, ...over });

  it("says latest at the chain's highest block", () => {
    expect(blockBehind(at())).toEqual({ text: "latest", tone: "ok" });
  });

  it("says how many blocks behind and how long that is, marked from 30 seconds", () => {
    expect(blockBehind(at({ blockLag: 2, behindSec: 4.2 }))).toEqual({ text: "2 behind · 4 s", tone: "plain" });
    expect(blockBehind(at({ blockLag: 3, behindSec: 36 }))).toEqual({ text: "3 behind · 36 s", tone: "warn" });
    expect(blockBehind(at({ blockLag: 1_200, behindSec: 14_400 }), (n) => n.toLocaleString("en-US"))).toEqual({ text: "1,200 behind · 4 h", tone: "warn" });
    // No block rate for the chain: the count alone, and no mark, since blocks alone can't say how late.
    expect(blockBehind(at({ blockLag: 5, behindSec: null }))).toEqual({ text: "5 behind", tone: "plain" });
  });

  it("marks a block that stopped moving", () => {
    expect(blockBehind(at({ stale: true }))).toEqual({ text: "not moving", tone: "warn" });
    expect(blockBehind(at({ blockLag: 40, behindSec: 480, stale: true }))).toEqual({ text: "40 behind · 8 min · not moving", tone: "warn" });
  });

  it("says nothing without a block or the chain's latest", () => {
    expect(blockBehind(at({ latestBlock: null }))).toBeNull();
    expect(blockBehind(at({ blockLag: null }))).toBeNull();
  });
});
