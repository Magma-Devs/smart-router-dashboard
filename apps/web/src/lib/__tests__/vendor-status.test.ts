import { describe, expect, it } from "vitest";
import type { VendorChainStatus, VendorStatus } from "@sr/shared";
import {
  affectedVendorChains,
  chainVerdictFor,
  isChainIncident,
  pruneDismissals,
  vendorChainKey,
  vendorSeverity,
  vendorStatusLabel,
  vendorTagClass,
  worstChainVerdict,
} from "../vendor-status";

function verdict(status: string, componentName = "Ethereum · Mainnet — JSON-RPC API"): VendorChainStatus {
  return status === "unknown"
    ? { status, components: [], reason: "No component on their status page maps to this chain." }
    : { status, components: [{ name: componentName, status }], reason: null };
}

function vendor(
  slug: string,
  chains: Record<string, VendorChainStatus>,
  officialStatus = "minor",
): VendorStatus {
  return {
    slug,
    name: slug,
    statusPage: `https://status.${slug}.example`,
    website: null,
    paused: false,
    chains,
    official: { status: officialStatus, description: null, fetchedAt: null },
    measuredStatus: "unconfigured",
    officialLastChangeAt: null,
    measuredLastChangeAt: null,
  };
}

describe("severity", () => {
  it.each([
    ["operational", "operational"],
    ["up", "operational"],
    ["minor", "degraded"],
    ["degraded", "degraded"],
    ["major", "outage"],
    ["critical", "outage"],
    ["down", "outage"],
    ["maintenance", "maintenance"],
  ] as const)("maps `%s` to %s", (status, severity) => {
    expect(vendorSeverity(status)).toBe(severity);
  });

  it("treats every no-data word as unknown, never as red", () => {
    // `unavailable` = the vendor publishes no machine-readable feed;
    // `unknown` = nothing on their page maps to this chain;
    // `unconfigured` = the index probes nothing for them. None is an outage.
    for (const word of ["unavailable", "unknown", "unconfigured", "paused"]) {
      expect(vendorSeverity(word)).toBe("unknown");
    }
  });

  it("calls a word it has never seen unknown rather than guessing a colour", () => {
    expect(vendorSeverity("brand-new-word")).toBe("unknown");
    expect(vendorSeverity(null)).toBe("unknown");
  });

  it("does not resolve a prototype member into a severity", () => {
    // A status string of "constructor" used to come back as a function and
    // take the whole shell down on the first .toLowerCase().
    expect(vendorSeverity("constructor")).toBe("unknown");
    expect(vendorSeverity("__proto__")).toBe("unknown");
    expect(vendorStatusLabel("constructor")).toBe("Constructor");
    expect(vendorTagClass(vendorSeverity("constructor"))).toBe("gw-tag");
  });
});

describe("chip text and colour", () => {
  it("takes both from the SAME verdict — a red chip can never read Operational", () => {
    // The bug this pins: colour from the worst of two observers, text from one.
    const v = vendor("drpc", { ETH1: verdict("major") });
    const worst = worstChainVerdict(v, ["ETH1"]);
    expect(worst?.severity).toBe("outage");
    expect(vendorStatusLabel(worst?.verdict.status)).toBe("Major issues");
    expect(vendorTagClass(worst?.severity ?? "unknown")).toBe("gw-tag gw-tag--err");
  });

  it("labels the no-feed state grey, not green", () => {
    const v = vendor("grove", { ETH1: { status: "unavailable", components: [], reason: "…" } });
    const worst = worstChainVerdict(v, ["ETH1"]);
    expect(worst?.severity).toBe("unknown");
    expect(vendorStatusLabel(worst?.verdict.status)).toBe("No status feed");
    expect(vendorTagClass(worst?.severity ?? "operational")).toBe("gw-tag");
  });
});

describe("worstChainVerdict", () => {
  const v = vendor("quicknode", {
    ETH1: verdict("operational"),
    SOLANA: verdict("major"),
    BTC: verdict("maintenance"),
  });

  it("speaks only for the chains the card serves", () => {
    // QuickNode is on fire for Solana; a card serving only Ethereum through
    // them must not say so.
    expect(worstChainVerdict(v, ["ETH1"])?.verdict.status).toBe("operational");
    expect(worstChainVerdict(v, ["ETH1", "SOLANA"])?.verdict.status).toBe("major");
  });

  it("puts a real fault above maintenance and maintenance above operational", () => {
    expect(worstChainVerdict(v, ["ETH1", "BTC"])?.spec).toBe("BTC");
    expect(worstChainVerdict(v, ["BTC", "SOLANA"])?.spec).toBe("SOLANA");
  });

  it("is null when the api judged none of this card's chains — no chip at all", () => {
    expect(worstChainVerdict(v, ["COSMOSHUB"])).toBeNull();
    expect(worstChainVerdict(vendor("x", {}), ["ETH1"])).toBeNull();
  });

  it("reads a chain verdict without tripping over prototype keys", () => {
    expect(chainVerdictFor(vendor("x", {}), "constructor")).toBeNull();
  });
});

describe("affectedVendorChains", () => {
  const vendors = [
    vendor("quicknode", { ETH1: verdict("operational"), SOLANA: verdict("minor") }),
    vendor("drpc", { ETH1: verdict("major") }),
    vendor("tenderly", { ETH1: verdict("unknown") }),
    vendor("grove", { ETH1: { status: "unavailable", components: [], reason: "…" } }),
    vendor("blockpi", { ETH1: verdict("maintenance") }),
  ];

  it("reports one entry per (vendor, chain) actually reporting a problem, worst first", () => {
    expect(affectedVendorChains(vendors).map((v) => `${v.vendor.slug}:${v.spec}`)).toEqual([
      "drpc:ETH1",
      "quicknode:SOLANA",
    ]);
  });

  it("never fires on the states that mean nobody is reporting, or on planned work", () => {
    const firing = affectedVendorChains(vendors).map((v) => v.vendor.slug);
    expect(firing).not.toContain("tenderly");
    expect(firing).not.toContain("grove");
    expect(firing).not.toContain("blockpi");
  });

  it("shows nothing at all when the index could not be read", () => {
    expect(affectedVendorChains(null)).toEqual([]);
  });

  it("agrees with isChainIncident", () => {
    expect(isChainIncident("outage")).toBe(true);
    expect(isChainIncident("degraded")).toBe(true);
    expect(isChainIncident("maintenance")).toBe(false);
    expect(isChainIncident("unknown")).toBe(false);
    expect(isChainIncident("operational")).toBe(false);
  });
});

describe("dismissals", () => {
  it("keys by vendor, chain AND state — a worse state is a new notice", () => {
    expect(vendorChainKey("drpc", "ETH1", "minor")).not.toBe(vendorChainKey("drpc", "ETH1", "major"));
    expect(vendorChainKey("drpc", "ETH1", "minor")).not.toBe(vendorChainKey("drpc", "SOLANA", "minor"));
    expect(vendorChainKey("drpc", "ETH1", "minor")).toBe(vendorChainKey("drpc", "ETH1", "minor"));
  });

  it("forgets a dismissal once that chain stops reporting", () => {
    // Recovered, then broke again the same way: the second incident is news.
    const dismissedKeys = [vendorChainKey("drpc", "ETH1", "minor")];
    const recovered = [vendor("drpc", { ETH1: verdict("operational") })];
    expect(pruneDismissals(dismissedKeys, recovered)).toEqual([]);
  });

  it("keeps a dismissal while the chain is still reporting", () => {
    const dismissedKeys = [vendorChainKey("drpc", "ETH1", "minor")];
    const still = [vendor("drpc", { ETH1: verdict("minor") })];
    expect(pruneDismissals(dismissedKeys, still)).toEqual(dismissedKeys);
  });

  it("leaves dismissals alone when there is no data to judge them by", () => {
    const dismissedKeys = [vendorChainKey("drpc", "ETH1", "minor")];
    expect(pruneDismissals(dismissedKeys, null)).toEqual(dismissedKeys);
  });
});
