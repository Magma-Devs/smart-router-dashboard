import { describe, expect, it, vi } from "vitest";

/* A regenerated catalog can put another explorer first. A transaction link
 * follows the explorer whose page was watched, never whichever comes first,
 * and goes away with it. */
vi.mock("../constants/chain-explorers.generated.json", () => ({
  default: {
    ETH1: [
      { name: "blockscout", url: "https://eth.blockscout.com", kind: "block", verified: "registry", source: "test" },
      { name: "etherscan", url: "https://etherscan.io", kind: "block", verified: "registry", source: "test" },
    ],
    BASE: [{ name: "basescout", url: "https://base.blockscout.com", kind: "block", verified: "registry", source: "test" }],
  },
}));

const { explorerTxUrl } = await import("../constants/explorers.js");
const HASH = "0x" + "ab".repeat(32);

describe("explorerTxUrl after the catalog moves", () => {
  it("links the watched explorer wherever it sits in the list", () => {
    expect(explorerTxUrl("ETH1", HASH)).toBe(`https://etherscan.io/tx/${HASH}`);
  });

  it("links nothing once the watched explorer is gone from the list", () => {
    expect(explorerTxUrl("BASE", HASH)).toBeNull();
  });
});
