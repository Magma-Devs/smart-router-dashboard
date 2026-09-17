import { describe, expect, it } from "vitest";
import { TOTP_STEP_SECONDS } from "@sr/shared";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  otpauthUri,
  totpCodeAtStep,
  totpStepAt,
  verifyTotp,
} from "../services/totp.js";

/**
 * RFC 6238 Appendix B, the SHA-1 rows.
 *
 * The published vectors are eight digits; ours are six, and the RFC's own
 * truncation means the six-digit code is the last six characters of the eight —
 * so the expectation below is derived from the published value rather than from
 * our implementation, which is the entire point of using them. If these pass,
 * this agrees with every other TOTP implementation.
 *
 * Secret is the ASCII string "12345678901234567890", which is
 * GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ in base32.
 */
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const RFC_VECTORS: ReadonlyArray<{ seconds: number; eightDigits: string }> = [
  { seconds: 59, eightDigits: "94287082" },
  { seconds: 1111111109, eightDigits: "07081804" },
  { seconds: 1111111111, eightDigits: "14050471" },
  { seconds: 1234567890, eightDigits: "89005924" },
  { seconds: 2000000000, eightDigits: "69279037" },
  // Past 2^31 — catches a 32-bit counter, which is the mistake this would
  // otherwise ship with.
  { seconds: 20000000000, eightDigits: "65353130" },
];

describe("base32", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xff, 0xab, 0xcd]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  });

  it("encodes the RFC's secret the way authenticator apps expect", () => {
    expect(base32Encode(Buffer.from("12345678901234567890", "ascii"))).toBe(RFC_SECRET);
  });

  it("accepts what a person types off a screen — spaces, dashes, lower case, padding", () => {
    const expected = Buffer.from("12345678901234567890", "ascii");
    expect(base32Decode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq")).toEqual(expected);
    expect(base32Decode("GEZD-GNBV-GY3T-QOJQ-GEZD-GNBV-GY3T-QOJQ")).toEqual(expected);
    expect(base32Decode(`${RFC_SECRET}======`)).toEqual(expected);
  });

  it("returns null rather than throwing on a character outside the alphabet", () => {
    // 0, 1 and 8 are deliberately absent from base32 — they are the characters
    // people mistype for O, I and B.
    expect(base32Decode("GEZDGNBV0")).toBeNull();
    expect(base32Decode("")).toBeNull();
  });
});

describe("totpStepAt", () => {
  it("is floor(unix seconds / 30)", () => {
    expect(totpStepAt(0)).toBe(0);
    expect(totpStepAt(29_999)).toBe(0);
    expect(totpStepAt(30_000)).toBe(1);
    expect(totpStepAt(59 * 1000)).toBe(1);
  });
});

describe("totpCodeAtStep — RFC 6238 vectors", () => {
  for (const { seconds, eightDigits } of RFC_VECTORS) {
    const expected = eightDigits.slice(-6);
    it(`T=${seconds} → ${expected}`, () => {
      const step = totpStepAt(seconds * 1000);
      expect(totpCodeAtStep(RFC_SECRET, step)).toBe(expected);
    });
  }

  it("returns null for an undecodable secret rather than throwing", () => {
    expect(totpCodeAtStep("not!base32", 1)).toBeNull();
    expect(totpCodeAtStep("", 1)).toBeNull();
  });
});

describe("verifyTotp", () => {
  const NOW = 1234567890 * 1000;
  const STEP = totpStepAt(NOW);
  const CODE = totpCodeAtStep(RFC_SECRET, STEP)!;

  it("accepts the current code and reports the step it matched", () => {
    expect(verifyTotp(RFC_SECRET, CODE, { now: NOW })).toEqual({ ok: true, step: STEP });
  });

  it("accepts the previous and next window — a phone 20 seconds out still works", () => {
    const previous = totpCodeAtStep(RFC_SECRET, STEP - 1)!;
    const next = totpCodeAtStep(RFC_SECRET, STEP + 1)!;
    // A phone 20s slow submits the previous step's code; 20s fast, the next.
    expect(verifyTotp(RFC_SECRET, previous, { now: NOW })).toEqual({ ok: true, step: STEP - 1 });
    expect(verifyTotp(RFC_SECRET, next, { now: NOW })).toEqual({ ok: true, step: STEP + 1 });
  });

  it("refuses two steps out", () => {
    const far = totpCodeAtStep(RFC_SECRET, STEP + 2)!;
    expect(verifyTotp(RFC_SECRET, far, { now: NOW })).toEqual({ ok: false, reason: "mismatch" });
  });

  it("refuses a code already spent, even while it is still current", () => {
    // The replay the ±1 window would otherwise open: same code, same 30-second
    // slot, second use.
    expect(verifyTotp(RFC_SECRET, CODE, { now: NOW, lastStep: STEP })).toEqual({
      ok: false,
      reason: "reused",
    });
    // And the previous window, once the current one has been spent.
    const previous = totpCodeAtStep(RFC_SECRET, STEP - 1)!;
    expect(verifyTotp(RFC_SECRET, previous, { now: NOW, lastStep: STEP })).toEqual({
      ok: false,
      reason: "reused",
    });
  });

  it("still accepts the next step after the current one was spent", () => {
    const next = totpCodeAtStep(RFC_SECRET, STEP + 1)!;
    expect(verifyTotp(RFC_SECRET, next, { now: NOW, lastStep: STEP })).toEqual({
      ok: true,
      step: STEP + 1,
    });
  });

  it("rejects anything that is not six digits before touching the secret", () => {
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 5"]) {
      expect(verifyTotp(RFC_SECRET, bad, { now: NOW })).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("tolerates spaces and dashes in what the user typed", () => {
    const spaced = `${CODE.slice(0, 3)} ${CODE.slice(3)}`;
    expect(verifyTotp(RFC_SECRET, spaced, { now: NOW })).toEqual({ ok: true, step: STEP });
  });

  it("reports a bad stored secret distinctly from a wrong code", () => {
    expect(verifyTotp("not!base32", CODE, { now: NOW })).toEqual({
      ok: false,
      reason: "bad_secret",
    });
  });
});

describe("generateTotpSecret", () => {
  it("is 32 base32 characters and decodes to 20 bytes", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
  });

  it("does not repeat", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateTotpSecret()));
    expect(seen.size).toBe(50);
  });
});

describe("otpauthUri", () => {
  it("carries the issuer in both places apps read it from", () => {
    const uri = otpauthUri({
      secret: RFC_SECRET,
      account: "dana@example.com",
      issuer: "Smart Router",
    });
    // Google Authenticator reads the label prefix; most others read the param.
    expect(uri).toContain("otpauth://totp/Smart%20Router:dana%40example.com?");
    expect(uri).toContain("issuer=Smart+Router");
    expect(uri).toContain(`secret=${RFC_SECRET}`);
  });

  it("pins the three parameters we build against", () => {
    const uri = otpauthUri({ secret: RFC_SECRET, account: "a@b.c", issuer: "X" });
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain(`period=${TOTP_STEP_SECONDS}`);
  });

  it("escapes a label that would otherwise truncate", () => {
    // A `/` or `:` in either half silently ends the label at that character.
    const uri = otpauthUri({ secret: RFC_SECRET, account: "a/b:c@d.e", issuer: "Ops: EU" });
    expect(uri).toContain("otpauth://totp/Ops%3A%20EU:a%2Fb%3Ac%40d.e?");
  });
});
