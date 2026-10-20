import { describe, expect, it } from "vitest";
import { createDb, DEFAULT_DB_POOL } from "../client.js";

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
});
