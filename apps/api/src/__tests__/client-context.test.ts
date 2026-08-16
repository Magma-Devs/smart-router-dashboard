import { describe, expect, it } from "vitest";
import { normalizeIp, parseClient } from "../services/client-context.js";

describe("parseClient", () => {
  it.each([
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      "Chrome 141 / macOS",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
      "Firefox 131 / Windows",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
      "Safari 18 / macOS",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
      "Safari 18 / iOS",
    ],
    [
      "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
      "Chrome 141 / Android",
    ],
  ])("reads %# as a recognisable device", (ua, expected) => {
    expect(parseClient(ua)).toBe(expected);
  });

  it("prefers the specific browser over the ones it impersonates", () => {
    // Edge and Opera both claim Chrome, and Chrome claims Safari. Matching in
    // the wrong order would report every browser as Safari.
    expect(
      parseClient(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
      ),
    ).toBe("Edge 141 / Windows");
    expect(
      parseClient(
        "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/115.0.0.0",
      ),
    ).toBe("Opera 115 / Windows");
  });

  it("returns what it can when only one half is recognisable", () => {
    expect(parseClient("curl/8.7.1")).toBeNull();
    expect(parseClient("Something (Windows NT 10.0)")).toBe("Windows");
  });

  it("is null for nothing at all — callers render an em dash, not a guess", () => {
    expect(parseClient(null)).toBeNull();
    expect(parseClient(undefined)).toBeNull();
    expect(parseClient("")).toBeNull();
  });
});

describe("normalizeIp", () => {
  it("keeps ordinary addresses", () => {
    expect(normalizeIp("84.229.11.6")).toBe("84.229.11.6");
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
    expect(normalizeIp(" 10.0.0.1 ")).toBe("10.0.0.1");
  });

  it("unwraps the IPv4-mapped form a dual-stack listener reports", () => {
    // Otherwise every audit row from an IPv4 client reads `::ffff:10.0.0.1`.
    expect(normalizeIp("::ffff:10.0.0.1")).toBe("10.0.0.1");
  });

  it("rejects anything Postgres `inet` would throw on", () => {
    // A malformed proxy header must not be able to fail a sign-in.
    for (const value of ["", "  ", "not-an-ip", "999.1.1.1", "10.0.0", "localhost", null, undefined]) {
      expect(normalizeIp(value), `should reject ${String(value)}`).toBeNull();
    }
  });
});
