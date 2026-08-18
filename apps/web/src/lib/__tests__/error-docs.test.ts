import { describe, expect, it } from "vitest";
import { errorDocsUrl } from "../error-docs";

const PAGE = "https://docs.magmadevs.com/reference/error-codes/";

describe("errorDocsUrl", () => {
  it("sends each layer's codes to the table that defines it", () => {
    expect(errorDocsUrl("PROTOCOL_CONNECTION_RESET")).toBe(`${PAGE}#layer-a-protocol-errors-protocol_-10001999`);
    expect(errorDocsUrl("NODE_INTERNAL_ERROR")).toBe(`${PAGE}#layer-b-node-errors-node_-20002999`);
    expect(errorDocsUrl("CHAIN_NONCE_TOO_LOW")).toBe(`${PAGE}#layer-c-blockchain-errors-chain_-30003999`);
    expect(errorDocsUrl("USER_INVALID_PARAMS")).toBe(`${PAGE}#layer-d-user-errors-user_-40004999`);
  });

  it("sends UNKNOWN_ERROR where the fallback is explained, not to a layer", () => {
    expect(errorDocsUrl("UNKNOWN_ERROR")).toBe(`${PAGE}#how-classification-works`);
  });

  it("lands on the page when the code is one the reference doesn't cover", () => {
    expect(errorDocsUrl("SOMETHING_NEW")).toBe(PAGE);
    expect(errorDocsUrl("")).toBe(PAGE);
  });

  it("reads a label however the metric cased or padded it", () => {
    expect(errorDocsUrl("  node_rate_limited  ")).toBe(`${PAGE}#layer-b-node-errors-node_-20002999`);
  });
});
