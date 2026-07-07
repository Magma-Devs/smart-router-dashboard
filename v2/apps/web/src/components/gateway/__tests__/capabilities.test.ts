import { describe, expect, it } from "vitest";
import { capabilitiesOf } from "@/components/gateway/CapabilityTags";

describe("capabilitiesOf", () => {
  it("keeps only known addons, in canonical order", () => {
    // Input order is trace,archive,debug — output is always archive,debug,trace.
    expect(capabilitiesOf({ addons: ["trace", "archive", "debug"] })).toEqual([
      "archive",
      "debug",
      "trace",
    ]);
  });

  it("drops unknown addons (e.g. skip-verification tokens)", () => {
    expect(capabilitiesOf({ addons: ["archive", "pruning", "tokens-owner-indexed"] })).toEqual([
      "archive",
    ]);
  });

  it("appends a derived ws capability", () => {
    expect(capabilitiesOf({ addons: ["archive"], hasWs: true })).toEqual(["archive", "ws"]);
    expect(capabilitiesOf({ hasWs: true })).toEqual(["ws"]);
  });

  it("is case-insensitive on addon names", () => {
    expect(capabilitiesOf({ addons: ["ARCHIVE", "Debug"] })).toEqual(["archive", "debug"]);
  });

  it("returns nothing when there are no capabilities", () => {
    expect(capabilitiesOf({})).toEqual([]);
    expect(capabilitiesOf({ addons: [] })).toEqual([]);
    expect(capabilitiesOf({ addons: ["pruning"] })).toEqual([]);
  });
});
