import { describe, expect, it } from "vitest";
import {
  CUSTOMER_NAME_MAX_LENGTH,
  UNNAMEABLE_CUSTOMERS,
  isNameableCustomerId,
  isUnnameableCustomer,
  parseCustomerName,
  sameCustomerName,
} from "../constants/customer-names.js";

describe("parseCustomerName", () => {
  it("trims and folds inner spaces into one", () => {
    expect(parseCustomerName("  Acme   Wallet\tEU ")).toEqual({ ok: true, name: "Acme Wallet EU" });
  });

  it("stores the NFC form", () => {
    expect(parseCustomerName("Café")).toEqual({ ok: true, name: "Café" });
  });

  it("refuses a value that is not text, or is blank", () => {
    expect(parseCustomerName(7).ok).toBe(false);
    expect(parseCustomerName(null).ok).toBe(false);
    expect(parseCustomerName("   ").ok).toBe(false);
  });

  it("refuses a name past the length cap, counted in characters", () => {
    expect(parseCustomerName("é".repeat(CUSTOMER_NAME_MAX_LENGTH)).ok).toBe(true);
    expect(parseCustomerName("a".repeat(CUSTOMER_NAME_MAX_LENGTH + 1)).ok).toBe(false);
  });

  it.each(["a|b", "a`b", "<b>", "a\\b", "[a](b)"])(
    "refuses %j, which breaks Markdown or HTML",
    (raw) => {
      expect(parseCustomerName(raw).ok).toBe(false);
    },
  );

  it.each(["a\u0000b", "a​b", "a‮b", "a b"])("refuses invisible character in %j", (raw) => {
    expect(parseCustomerName(raw).ok).toBe(false);
  });

  it("refuses every reserved value, in any case", () => {
    for (const reserved of UNNAMEABLE_CUSTOMERS) {
      expect(parseCustomerName(reserved).ok).toBe(false);
      expect(parseCustomerName(reserved.toUpperCase()).ok).toBe(false);
    }
  });
});

describe("sameCustomerName", () => {
  it("compares canonical forms without case", () => {
    expect(sameCustomerName("Acme  Wallet", " acme wallet")).toBe(true);
    expect(sameCustomerName("Acme", "Acme EU")).toBe(false);
  });
});

describe("isUnnameableCustomer", () => {
  it("knows the router's own values", () => {
    expect(isUnnameableCustomer("defaultdappid")).toBe(true);
    expect(isUnnameableCustomer("acme")).toBe(false);
  });
});

describe("isNameableCustomerId", () => {
  it("takes a caller's id as the router counts it", () => {
    expect(isNameableCustomerId("f".repeat(64))).toBe(true);
    expect(isNameableCustomerId("team a/prod")).toBe(true);
  });

  it("refuses the reserved values, exactly as the router writes them", () => {
    for (const reserved of UNNAMEABLE_CUSTOMERS) expect(isNameableCustomerId(reserved)).toBe(false);
  });

  it("refuses what the router would count as other, or nothing", () => {
    expect(isNameableCustomerId("")).toBe(false);
    expect(isNameableCustomerId("a".repeat(129))).toBe(false);
    expect(isNameableCustomerId("é".repeat(65))).toBe(false);
    expect(isNameableCustomerId("a\u0000")).toBe(false);
    expect(isNameableCustomerId("a\ud800")).toBe(false);
    expect(isNameableCustomerId("😀".repeat(32))).toBe(true);
    expect(isNameableCustomerId("😀".repeat(33))).toBe(false);
    expect(isNameableCustomerId(42)).toBe(false);
  });
});
