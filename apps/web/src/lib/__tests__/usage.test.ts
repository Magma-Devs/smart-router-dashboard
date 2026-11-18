import { describe, expect, it } from "vitest";
import { pageOf, searchKind, tabOf } from "../usage";

describe("usage data's page, tab and look-up kind", () => {
  it("names the page and the tab", () => {
    expect(pageOf("/metrics")).toBe("metrics");
    expect(pageOf("/upstreams")).toBe("upstreams");
    expect(pageOf("/standalone")).toBe("standalone");
    expect(pageOf("/login")).toBe("other");
    expect(tabOf("/metrics", "?tab=errors")).toBe("errors");
    expect(tabOf("/metrics", "")).toBe("metrics");
    expect(tabOf("/team", "?tab=errors")).toBe("none");
  });

  it("says what kind of value was looked up, never the value", () => {
    const now = 1_792_323_767;
    const minted = ((BigInt(now - 60) << 32n) | 7n).toString();
    expect(searchKind(minted, now)).toBe("request-id");
    expect(searchKind("15972212763463815960", now)).toBe("old-request-id");
    expect(searchKind("0x" + "ab".repeat(32), now)).toBe("hash");
    expect(searchKind("my-order-42", now)).toBe("other");
  });
});
