import { describe, expect, it } from "vitest";
import { decodeHandoff, encodeHandoff } from "../two-factor-handoff";

/**
 * The cookie that carries a two-factor challenge from a Google or GitHub
 * sign-in to the code screen. Any client can send any cookie, so the decoder is
 * the part that matters: it must refuse everything it did not write.
 */

const handoff = {
  challenge: "Xb7Qm2Kv9Rt4Lz0Ap6Ce8Nh1Sj3Dw5y",
  email: "dana@example.com",
  provider: "google" as const,
};

describe("two-factor handoff", () => {
  it("round-trips what the sign-in callback writes", () => {
    expect(decodeHandoff(encodeHandoff(handoff))).toEqual(handoff);
  });

  it.each([
    ["nothing", undefined],
    ["an empty value", ""],
    ["something that is not base64 JSON", "not-a-handoff"],
    ["a provider it does not know", encodeHandoff({ ...handoff, provider: "discord" as never })],
    ["a challenge that was not minted by the api", encodeHandoff({ ...handoff, challenge: "short" })],
    ["a missing address", encodeHandoff({ ...handoff, email: "" })],
    ["an oversized value", "a".repeat(4096)],
  ])("refuses %s", (_label, value) => {
    expect(decodeHandoff(value)).toBeNull();
  });
});
