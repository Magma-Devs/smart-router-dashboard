import { describe, it, expect } from "vitest";
import { providerName } from "../services/provider-names.js";

describe("providerName", () => {
  it("writes a provider the way its company does, whatever the values file typed", () => {
    expect(providerName("quicknode")).toBe("QuickNode");
    expect(providerName("QUICKNODE")).toBe("QuickNode");
    expect(providerName("blockdaemon")).toBe("Blockdaemon");
    expect(providerName("drpc")).toBe("dRPC");
  });

  it("keeps a name it does not know exactly as configured — never a guessed brand", () => {
    expect(providerName("tatum-eu-2")).toBe("tatum-eu-2");
    expect(providerName("myNode")).toBe("myNode");
  });
});
