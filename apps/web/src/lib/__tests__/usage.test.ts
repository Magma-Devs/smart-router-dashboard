import { describe, expect, it } from "vitest";
import { arrivedFrom, pageOf, searchKind, tabOf, visitFrom, VISIT_AWAY_MS } from "../usage";

describe("usage visits", () => {
  const id = () => "new-visit-id";
  it("carries a visit on until 30 minutes pass with no event", () => {
    const stored = { id: "abc-visit-1", start: 1_000, last: 2_000, seq: 4 };
    expect(visitFrom(stored, 2_000 + VISIT_AWAY_MS - 1, id)).toEqual({ visit: stored, isNew: false });
    expect(visitFrom(stored, 2_000 + VISIT_AWAY_MS, id)).toEqual({ visit: { id: "new-visit-id", start: 2_000 + VISIT_AWAY_MS, last: 2_000 + VISIT_AWAY_MS, seq: 0 }, isNew: true });
    expect(visitFrom(null, 5, id).isNew).toBe(true);
  });

  it("tells how a visit arrived from its first URL", () => {
    expect(arrivedFrom("?tab=request&request=0xabc")).toBe("link-request");
    expect(arrivedFrom("?chain=ETH1&window=1d")).toBe("link");
    expect(arrivedFrom("?window=1d")).toBe("typed");
    expect(arrivedFrom("")).toBe("typed");
  });

  it("names the page and the tab", () => {
    expect(pageOf("/metrics")).toBe("metrics");
    expect(pageOf("/upstreams")).toBe("upstreams");
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
