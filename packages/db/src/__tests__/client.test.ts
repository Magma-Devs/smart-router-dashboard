import { describe, expect, it } from "vitest";
import { createDb, DEFAULT_DB_POOL, isTlsServername } from "../client.js";

/**
 * The pool options reach the driver, and the ones that could not work are
 * refused before they do. Nothing here connects: postgres-js opens a socket
 * on the first query and none is sent, so the unroutable address (RFC 5737)
 * is never dialled.
 */
const URL = "postgres://sr:x@192.0.2.1:5432/na";

describe("createDb", () => {
  it("opens the pool at the library defaults when told nothing", async () => {
    const h = createDb(URL);
    try {
      expect(h.sql.options.max).toBe(DEFAULT_DB_POOL.max);
      expect(h.sql.options.idle_timeout).toBe(DEFAULT_DB_POOL.idleTimeout);
      expect(h.sql.options.connect_timeout).toBe(10);
    } finally {
      await h.sql.end({ timeout: 0 });
    }
  });

  it("hands the driver the pool size and the idle timeout it is given", async () => {
    const h = createDb(URL, { max: 5, idleTimeout: 7 });
    try {
      expect(h.sql.options.max).toBe(5);
      expect(h.sql.options.idle_timeout).toBe(7);
    } finally {
      await h.sql.end({ timeout: 0 });
    }
  });

  it("at 0 keeps idle connections for the life of the process", async () => {
    const h = createDb(URL, { idleTimeout: 0 });
    try {
      // postgres-js stores "no idle timeout" as a falsy option and never arms
      // the timer; either spelling of that is the behaviour asked for.
      expect(h.sql.options.idle_timeout || 0).toBe(0);
      expect(h.sql.options.max).toBe(DEFAULT_DB_POOL.max);
    } finally {
      await h.sql.end({ timeout: 0 });
    }
  });

  it("refuses a pool that could hold nothing", () => {
    expect(() => createDb(URL, { max: 0 })).toThrow(/pool size/);
    expect(() => createDb(URL, { max: -3 })).toThrow(/pool size/);
    expect(() => createDb(URL, { max: 2.5 })).toThrow(/pool size/);
  });

  it("refuses a negative or fractional idle timeout", () => {
    expect(() => createDb(URL, { idleTimeout: -1 })).toThrow(/idle timeout/);
    expect(() => createDb(URL, { idleTimeout: 1.5 })).toThrow(/idle timeout/);
  });

  // The fleet dials a cloudflared sidecar on loopback while the TLS session
  // ends on RDS: the name the certificate must carry comes from the option,
  // not from the address dialled.
  it("verifies the certificate against the server name it is given, whatever the URL says", async () => {
    // The URL asks for an unverified `require`; the option wins over it.
    const h = createDb("postgres://sr:x@127.0.0.1:5432/na?sslmode=require", {
      tlsServername: "fleet-prod.abc123.us-east-1.rds.amazonaws.com",
    });
    try {
      expect(h.sql.options.ssl).toEqual({ servername: "fleet-prod.abc123.us-east-1.rds.amazonaws.com" });
    } finally {
      await h.sql.end({ timeout: 0 });
    }
  });

  it("leaves TLS to the URL when no server name is given", async () => {
    const plain = createDb(URL);
    const full = createDb(`${URL}?sslmode=verify-full`);
    const blank = createDb(URL, { tlsServername: "  " });
    try {
      expect(plain.sql.options.ssl).toBe(false);
      expect(full.sql.options.ssl).toBe("verify-full");
      expect(blank.sql.options.ssl).toBe(false);
    } finally {
      await Promise.all([plain, full, blank].map((h) => h.sql.end({ timeout: 0 })));
    }
  });

  it("refuses a server name that is not a DNS name", () => {
    for (const bad of ["https://db.example.com", "db.example.com:5432", "db example", "10.0.0.1", "-db.example.com"]) {
      expect(() => createDb(URL, { tlsServername: bad })).toThrow(/TLS server name/);
    }
    expect(isTlsServername("db.example.com")).toBe(true);
    expect(isTlsServername("rds")).toBe(true);
  });
});
