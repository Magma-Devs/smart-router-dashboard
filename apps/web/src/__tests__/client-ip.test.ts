import { describe, expect, it, vi } from "vitest";

// next-auth's runtime needs Next's server modules, which vitest cannot load.
// Nothing here is about the providers, so they are stand-ins.
vi.mock("next-auth", () => ({ CredentialsSignin: class extends Error {} }));
vi.mock("next-auth/providers/google", () => ({ default: (o: object) => ({ id: "google", ...o }) }));
vi.mock("next-auth/providers/github", () => ({ default: (o: object) => ({ id: "github", ...o }) }));
vi.mock("next-auth/providers/credentials", () => ({ default: (o: object) => ({ id: "credentials", ...o }) }));

const { clientIpFrom } = await import("@/auth.config");

/**
 * Which entry of `X-Forwarded-For` is the browser.
 *
 * This is a security property rather than a formatting detail: whatever this
 * returns is forwarded to the api, written to the session row, and recorded as
 * the address on every access event for that sign-in. Reading the left-most
 * entry — where a caller's own header value survives — lets somebody choose
 * what their sign-in attempts are logged as.
 */

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe("clientIpFrom", () => {
  it("forwards no address when nothing sits in front of the web", () => {
    // TRUST_PROXY_HOPS=0: Next leaves a browser's own X-Forwarded-For intact,
    // so every entry is the browser's choice and none of them can be believed.
    expect(clientIpFrom(headers({ "x-forwarded-for": "6.6.6.6" }), 0)).toBeUndefined();
    expect(clientIpFrom(headers({ "x-real-ip": "6.6.6.6" }), 0)).toBeUndefined();
  });

  it("takes the entry the single trusted proxy wrote", () => {
    expect(clientIpFrom(headers({ "x-forwarded-for": "198.51.100.9" }), 1)).toBe("198.51.100.9");
  });

  it("ignores an address the caller put in front of it", () => {
    // The ingress appends, so a client-supplied value stays on the left. This
    // is the forgery the hop count exists to defeat.
    const h = headers({ "x-forwarded-for": "1.2.3.4, 198.51.100.9" });
    expect(clientIpFrom(h, 1)).toBe("198.51.100.9");
    expect(clientIpFrom(h, 1)).not.toBe("1.2.3.4");
  });

  it("counts back through two proxies", () => {
    // client → edge → ingress → web, so the chain reads
    // "<spoofed>, <client>, <edge>" and the client is two from the right.
    const h = headers({ "x-forwarded-for": "1.2.3.4, 198.51.100.9, 10.0.0.5" });
    expect(clientIpFrom(h, 2)).toBe("198.51.100.9");
  });

  it("claims nothing when the chain is shorter than the hop count", () => {
    // Misconfigured, or the header was stripped. Recording this container's
    // own address is honest; picking the only entry available is not.
    expect(clientIpFrom(headers({ "x-forwarded-for": "1.2.3.4" }), 2)).toBeUndefined();
  });

  it("falls back to x-real-ip only when there is no chain at all", () => {
    expect(clientIpFrom(headers({ "x-real-ip": "203.0.113.7" }), 1)).toBe("203.0.113.7");
    // With a chain present the hop count decides, and x-real-ip is not consulted.
    const both = headers({ "x-forwarded-for": "1.2.3.4, 198.51.100.9", "x-real-ip": "1.2.3.4" });
    expect(clientIpFrom(both, 1)).toBe("198.51.100.9");
  });

  it("tolerates whitespace and empty entries", () => {
    expect(clientIpFrom(headers({ "x-forwarded-for": " 1.2.3.4 ,  , 198.51.100.9 " }), 1)).toBe(
      "198.51.100.9",
    );
  });

  it("has nothing to report without headers", () => {
    expect(clientIpFrom(null, 1)).toBeUndefined();
    expect(clientIpFrom(headers({}), 1)).toBeUndefined();
  });
});
