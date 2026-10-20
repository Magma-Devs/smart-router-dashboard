import { describe, expect, it } from "vitest";
import { DEFAULT_DB_POOL } from "@sr/db";
import { readDbPoolOptions } from "../config.js";

/**
 * `DB_POOL_MAX` / `DB_IDLE_TIMEOUT_S`, as the db plugin reads them. The
 * fleet sizes a shared instance's connection budget from the pool each
 * backend is told to hold, so the one thing this must never do is turn a
 * value somebody set into a silent default.
 */
describe("readDbPoolOptions", () => {
  it("takes the library defaults when neither variable is set", () => {
    expect(readDbPoolOptions({})).toEqual({
      max: DEFAULT_DB_POOL.max,
      idleTimeout: DEFAULT_DB_POOL.idleTimeout,
    });
    expect(readDbPoolOptions({})).toEqual({ max: 20, idleTimeout: 30 });
  });

  it("treats an empty or blank value as unset", () => {
    expect(readDbPoolOptions({ DB_POOL_MAX: "", DB_IDLE_TIMEOUT_S: "  " })).toEqual({
      max: 20,
      idleTimeout: 30,
    });
  });

  it("reads both, trimmed", () => {
    expect(readDbPoolOptions({ DB_POOL_MAX: " 5 ", DB_IDLE_TIMEOUT_S: "0" })).toEqual({
      max: 5,
      idleTimeout: 0,
    });
  });

  it("refuses a pool that could hold nothing", () => {
    expect(() => readDbPoolOptions({ DB_POOL_MAX: "0" })).toThrow(
      /DB_POOL_MAX must be a whole number of at least 1/,
    );
  });

  it("refuses anything that is not a whole number, naming the variable", () => {
    for (const bad of ["abc", "-1", "2.5", "1e2", "0x10", "5 connections"]) {
      expect(() => readDbPoolOptions({ DB_POOL_MAX: bad })).toThrow(/DB_POOL_MAX/);
    }
    for (const bad of ["never", "-30", "0.5"]) {
      expect(() => readDbPoolOptions({ DB_IDLE_TIMEOUT_S: bad })).toThrow(/DB_IDLE_TIMEOUT_S/);
    }
  });

  it("quotes the offending value in the error", () => {
    expect(() => readDbPoolOptions({ DB_POOL_MAX: "twenty" })).toThrow('"twenty"');
  });
});
