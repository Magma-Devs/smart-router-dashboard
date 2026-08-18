import { describe, expect, it } from "vitest";
import { initialTargetFor, isPinnable, pinRefusalFor, pinRefusalHintFor } from "../pin-support";

describe("pinRefusalFor", () => {
  it("has nothing to say about a primary upstream", () => {
    expect(pinRefusalFor("primary")).toBeNull();
    expect(isPinnable("primary")).toBe(true);
  });

  it("explains the backup pool rather than letting the request fail", () => {
    const reason = pinRefusalFor("backup");
    expect(reason).toContain("backup");
    // The router's own words, so the drawer's copy and the error a reader may
    // already have in front of them line up.
    expect(reason).toContain("Selected provider not available");
    expect(isPinnable("backup")).toBe(false);
  });
});

describe("pinRefusalHintFor", () => {
  it("says nothing where nothing is disabled", () => {
    expect(pinRefusalHintFor("primary")).toBeNull();
  });

  it("fits a tooltip and still names the cause and the way out", () => {
    const hint = pinRefusalHintFor("backup")!;
    // A hover that runs past a line or two is read as decoration, not as the
    // answer to "why is this off?".
    expect(hint.length).toBeLessThan(160);
    expect(hint).toContain("Backup");
    expect(hint).toContain("direct");
  });
});

describe("initialTargetFor", () => {
  it("opens a primary upstream on the router — the path a real client takes", () => {
    expect(initialTargetFor({ tier: "primary", directAvailable: true })).toBe("router");
    expect(initialTargetFor({ tier: "primary", directAvailable: false })).toBe("router");
  });

  it("opens a backup upstream on the direct leg, the only one that reaches it", () => {
    expect(initialTargetFor({ tier: "backup", directAvailable: true })).toBe("upstream");
  });

  it("stays on the router when there is no direct target to open on", () => {
    // A grpc-only row, or one with no url for the selected transport: the
    // drawer would otherwise open on a mode with no Send button.
    expect(initialTargetFor({ tier: "backup", directAvailable: false })).toBe("router");
  });
});
