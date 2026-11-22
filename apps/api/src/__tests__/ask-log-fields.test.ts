import { describe, expect, it } from "vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { AskFailure } from "../services/ask/errors.js";
import { askErrorFields } from "../services/ask/log-fields.js";

const connectionString = "postgres://ask:synthetic-password@db.internal:5432/dashboard";

/** The shape a refused connection reaches the Ask code in: the ORM's wrapper
 * around the driver's error, whose message names the address. */
function refused(): DrizzleQueryError {
  const cause = Object.assign(
    new Error(`connect ECONNREFUSED 127.0.0.1:5432 (${connectionString})`),
    {
      code: "ECONNREFUSED",
    },
  );
  return new DrizzleQueryError("select * from ask_runs", [connectionString], cause);
}

class PostgresError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "PostgresError";
  }
}

describe("askErrorFields", () => {
  it("names the wrapper's class, the driver error's class and its code", () => {
    expect(askErrorFields(refused())).toEqual({
      errorClass: "DrizzleQueryError",
      causeClass: "Error",
      errorCode: "ECONNREFUSED",
    });
  });

  it("reads a Postgres SQLSTATE from the cause", () => {
    const cause = new PostgresError(
      `password authentication failed (${connectionString})`,
      "28P01",
    );
    expect(askErrorFields(new DrizzleQueryError("select 1", [], cause))).toEqual({
      errorClass: "DrizzleQueryError",
      causeClass: "PostgresError",
      errorCode: "28P01",
    });
  });

  it("reads the code of an error with no cause", () => {
    expect(askErrorFields(new AskFailure("ASK_UNAVAILABLE"))).toEqual({
      errorClass: "AskFailure",
      errorCode: "ASK_UNAVAILABLE",
    });
  });

  it("never carries a message, a query, a parameter or a connection string", () => {
    const fields = JSON.stringify(askErrorFields(refused()));
    expect(fields).not.toContain("postgres://");
    expect(fields).not.toContain("synthetic-password");
    expect(fields).not.toContain("127.0.0.1");
    expect(fields).not.toContain("select");
  });

  it("drops a code that is not a plain identifier", () => {
    const error = Object.assign(new Error("boom"), { code: connectionString });
    expect(askErrorFields(error)).toEqual({ errorClass: "Error" });
    expect(askErrorFields(Object.assign(new Error("boom"), { code: "hunter2" }))).toEqual({
      errorClass: "Error",
    });
    expect(askErrorFields(Object.assign(new Error("boom"), { code: 42 }))).toEqual({
      errorClass: "Error",
    });
  });

  it("names a thrown value that is not an object by its type", () => {
    expect(askErrorFields(connectionString)).toEqual({ errorClass: "string" });
    expect(askErrorFields(undefined)).toEqual({ errorClass: "undefined" });
    expect(askErrorFields(null)).toEqual({ errorClass: "null" });
  });

  it("ends on a cause that refers back to its error", () => {
    const error = Object.assign(new Error("loop"), { code: "ELOOP" });
    (error as { cause?: unknown }).cause = error;
    expect(askErrorFields(error)).toEqual({ errorClass: "Error", errorCode: "ELOOP" });
  });
});
