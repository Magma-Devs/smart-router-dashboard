import { describe, expect, it } from "vitest";
import { attention, byAttention, chainHref, resolveScope, scopeFromSearch, tabFromSearch, type DrawerChain } from "../chain-drawer";
import { errRateColor } from "../colors";

const row = (over: Partial<DrawerChain>): DrawerChain => ({
  spec: "ETH1", name: "Ethereum", mainnet: true, health: "operational",
  requests: 100, errPct: 0, noTraffic: false, ...over,
});

describe("byAttention", () => {
  it("puts problems first: unhealthy, then red and amber error rates, then the rest", () => {
    const sorted = byAttention([
      row({ spec: "QUIET", name: "Quiet", requests: 900 }),
      row({ spec: "AMBER", name: "Amber", errPct: 0.8 }),
      row({ spec: "IDLE", name: "Idle", health: "unknown", requests: 0, errPct: null, noTraffic: true }),
      row({ spec: "DOWN", name: "Down", health: "unhealthy", errPct: 0 }),
      row({ spec: "RED", name: "Red", errPct: 6.25 }),
    ]);
    expect(sorted.map((r) => r.spec)).toEqual(["DOWN", "RED", "AMBER", "QUIET", "IDLE"]);
  });

  it("orders equally healthy chains busiest first, then by name", () => {
    const sorted = byAttention([
      row({ spec: "B", name: "Bitcoin", requests: 5 }),
      row({ spec: "S", name: "Solana", requests: 50 }),
      row({ spec: "A", name: "Aptos", requests: 5 }),
    ]);
    expect(sorted.map((r) => r.spec)).toEqual(["S", "A", "B"]);
  });

  it("treats a chain with no metrics in the window as the least urgent, not as down", () => {
    expect(attention(row({ health: "unknown", errPct: null }))).toBeGreaterThan(attention(row({})));
  });

  it("does not reorder the caller's array", () => {
    const rows = [row({ spec: "Q", requests: 1 }), row({ spec: "D", health: "unhealthy" })];
    byAttention(rows);
    expect(rows.map((r) => r.spec)).toEqual(["Q", "D"]);
  });
});

describe("scopeFromSearch", () => {
  it("reads the chain and the router a page URL names", () => {
    expect(scopeFromSearch("?chain=SOLANA")).toEqual({ chain: "SOLANA", router: null });
    expect(scopeFromSearch("?tab=errors&chain=ETH1&router=eth-prod")).toEqual({ chain: "ETH1", router: "eth-prod" });
  });

  it("reads none where there is none, or where the value is malformed", () => {
    expect(scopeFromSearch("")).toEqual({ chain: null, router: null });
    expect(scopeFromSearch("?chain=&router=")).toEqual({ chain: null, router: null });
    expect(scopeFromSearch("?chain=ETH1%22%7D&router=a%20b")).toEqual({ chain: null, router: null });
    expect(scopeFromSearch(`?chain=${"A".repeat(65)}`).chain).toBeNull();
  });
});

describe("tabFromSearch", () => {
  const tabs = ["metrics", "upstreams", "errors"] as const;

  it("reads the tab a page URL names", () => {
    expect(tabFromSearch("?chain=ETH1&tab=upstreams", tabs)).toBe("upstreams");
  });

  it("falls back to the first tab when the URL names none of them", () => {
    expect(tabFromSearch("", tabs)).toBe("metrics");
    expect(tabFromSearch("?tab=", tabs)).toBe("metrics");
    expect(tabFromSearch("?tab=traffic", tabs)).toBe("metrics");
    expect(tabFromSearch("?tab=Errors", tabs)).toBe("metrics");
  });
});

describe("resolveScope", () => {
  const routers = [
    { id: "eth-prod", spec: "ETH1" },
    { id: "eth-staging", spec: "ETH1" },
    { id: "SOLANA", spec: "SOLANA" },
  ];

  it("gives a router its own chain, whatever chain the URL named", () => {
    expect(resolveScope({ chain: null, router: "eth-prod" }, routers)).toEqual({ chain: "ETH1", router: "eth-prod" });
    expect(resolveScope({ chain: "SOLANA", router: "eth-staging" }, routers)).toEqual({ chain: "ETH1", router: "eth-staging" });
  });

  it("reads the router of a chain nothing else serves as that chain", () => {
    expect(resolveScope({ chain: null, router: "SOLANA" }, routers)).toEqual({ chain: "SOLANA", router: null });
  });

  it("drops a router the config doesn't have, keeping the chain", () => {
    expect(resolveScope({ chain: "ETH1", router: "gone" }, routers)).toEqual({ chain: "ETH1", router: null });
    expect(resolveScope({ chain: null, router: "gone" }, [])).toEqual({ chain: null, router: null });
  });

  it("leaves the scope as asked until the config has been read", () => {
    expect(resolveScope({ chain: null, router: "eth-prod" }, null)).toEqual({ chain: null, router: "eth-prod" });
    expect(resolveScope({ chain: "ETH1", router: null }, routers)).toEqual({ chain: "ETH1", router: null });
  });
});

describe("chainHref", () => {
  it("links one chain's metrics, one of its routers, or every chain's", () => {
    expect(chainHref("ETH1")).toBe("/metrics?chain=ETH1");
    expect(chainHref("ETH1", "eth-staging")).toBe("/metrics?chain=ETH1&router=eth-staging");
    expect(chainHref(null)).toBe("/metrics");
  });
});

describe("errRateColor", () => {
  it("uses the Routers table's bands", () => {
    expect(errRateColor(null)).toBe("var(--text-4)");
    expect(errRateColor(0.49)).toBe("var(--text-2)");
    expect(errRateColor(0.49, "var(--text-3)")).toBe("var(--text-3)");
    expect(errRateColor(0.5)).toBe("var(--warn)");
    expect(errRateColor(1.49)).toBe("var(--warn)");
    expect(errRateColor(1.5)).toBe("var(--err)");
  });
});
