import { describe, expect, it } from "vitest";
import type { VendorStatus } from "@sr/shared";
import {
  affectedVendors,
  measuredSeverity,
  measuredStatusLabel,
  officialSeverity,
  officialStatusLabel,
  vendorBannerKey,
  vendorHasIncident,
  vendorSeverity,
} from "../vendor-status";

function vendor(official: string, measured: string | null = "unconfigured", slug = "drpc"): VendorStatus {
  return {
    slug,
    name: slug,
    statusPage: `https://status.${slug}.example`,
    website: null,
    paused: false,
    official: { status: official, description: null, fetchedAt: null },
    measuredStatus: measured,
    officialLastChangeAt: null,
    measuredLastChangeAt: null,
  };
}

describe("severity", () => {
  it.each([
    ["operational", "operational"],
    ["maintenance", "degraded"],
    ["minor", "degraded"],
    ["major", "outage"],
    ["critical", "outage"],
  ] as const)("maps the index's `%s` to %s", (status, severity) => {
    expect(officialSeverity(status)).toBe(severity);
  });

  it("treats BOTH of the index's no-data words as unknown, never as red", () => {
    // `unavailable` means the vendor publishes no machine-readable feed;
    // `unknown` means the feed exists but couldn't be read. Neither is an
    // outage, and half the catalog sits in one of them permanently.
    expect(officialSeverity("unavailable")).toBe("unknown");
    expect(officialSeverity("unknown")).toBe("unknown");
    expect(measuredSeverity("unconfigured")).toBe("unknown");
    expect(measuredSeverity("paused")).toBe("unknown");
  });

  it("calls a word it has never seen unknown rather than guessing a colour", () => {
    expect(officialSeverity("brand-new-word")).toBe("unknown");
    expect(measuredSeverity(null)).toBe("unknown");
  });

  it("takes the worse of what they publish and what the index measures", () => {
    expect(vendorSeverity(vendor("operational", "down"))).toBe("outage");
    expect(vendorSeverity(vendor("minor", "up"))).toBe("degraded");
    expect(vendorSeverity(vendor("operational", "up"))).toBe("operational");
    expect(vendorSeverity(vendor("unknown", "unconfigured"))).toBe("unknown");
  });
});

describe("vendorHasIncident", () => {
  it("is true only for a reported problem", () => {
    expect(vendorHasIncident(vendor("minor"))).toBe(true);
    expect(vendorHasIncident(vendor("major"))).toBe(true);
    expect(vendorHasIncident(vendor("operational", "down"))).toBe(true);
  });

  it("is false for the states that mean nobody is reporting", () => {
    // The banner these feed would be permanent, and a permanent banner is one
    // nobody reads when it finally matters.
    expect(vendorHasIncident(vendor("unknown", "unconfigured"))).toBe(false);
    expect(vendorHasIncident(vendor("unavailable", null))).toBe(false);
    expect(vendorHasIncident(vendor("operational", "unconfigured"))).toBe(false);
  });
});

describe("affectedVendors", () => {
  const vendors = [
    vendor("minor", "unconfigured", "chainstack"),
    vendor("major", "unconfigured", "quicknode"),
    vendor("operational", "unconfigured", "drpc"),
    vendor("critical", "unconfigured", "tatum"),
  ];

  it("keeps only the vendors this topology actually routes through", () => {
    // tatum is on fire, but nothing here is pointed at it.
    const out = affectedVendors(vendors, new Set(["chainstack", "drpc"]));
    expect(out.map((v) => v.slug)).toEqual(["chainstack"]);
  });

  it("puts the worst first", () => {
    const out = affectedVendors(vendors, new Set(["chainstack", "quicknode"]));
    expect(out.map((v) => v.slug)).toEqual(["quicknode", "chainstack"]);
  });

  it("shows nothing at all when the index could not be read", () => {
    expect(affectedVendors(null, new Set(["chainstack"]))).toEqual([]);
  });
});

describe("labels", () => {
  it("keeps a word the index invents, capitalised but not renamed", () => {
    expect(officialStatusLabel("brand-new-word")).toBe("Brand-new-word");
    expect(measuredStatusLabel(null)).toBe("Unknown");
    expect(officialStatusLabel("unavailable")).toBe("No status feed");
  });
});

describe("vendorBannerKey", () => {
  it("changes when the vendor's state does — dismissing `minor` must not hide `major`", () => {
    expect(vendorBannerKey(vendor("minor"))).not.toBe(vendorBannerKey(vendor("major")));
    expect(vendorBannerKey(vendor("minor"))).toBe(vendorBannerKey(vendor("minor")));
  });
});
