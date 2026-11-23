import { describe, expect, it } from "vitest";
import { NARROWED_NOTE, failedRead, narrowedRead } from "../services/ask/read-notes.js";

const base = { sourceId: "acme-logs", operationId: "logs.query_range" };

describe("what a read says it did differently", () => {
  it("is nothing for a read answered as asked, the only shape MCP v0.1.7 sends", () => {
    expect(narrowedRead({ ...base, ok: true, data: {} })).toBeNull();
    expect(narrowedRead({ ...base, ok: false, error: "SOURCE_TIMEOUT" })).toBeNull();
  });

  it("gives a narrowed read's window and tells the model it covers part", () => {
    const window = { requested: { start: 0, end: 86_400 }, read: { start: 43_200, end: 86_400 } };
    expect(
      narrowedRead({
        ...base,
        ok: true,
        partial: true,
        window,
        guidance: "Continue with end=43200.",
      }),
    ).toEqual({
      partial: true,
      window: window.read,
      fields: {
        narrowed: {
          asked: { from: "1970-01-01T00:00:00.000Z", to: "1970-01-02T00:00:00.000Z" },
          read: { from: "1970-01-01T12:00:00.000Z", to: "1970-01-02T00:00:00.000Z" },
        },
        note: NARROWED_NOTE,
        guidance: "Continue with end=43200.",
      },
    });
  });

  it("marks a narrowed read with no window, and keeps its times as asked", () => {
    const narrowed = narrowedRead({
      ...base,
      ok: true,
      partial: true,
      adjusted: { query: "x[1h]" },
    });
    expect(narrowed).toEqual({
      partial: true,
      fields: { narrowed: true, note: NARROWED_NOTE, ranAs: { query: "x[1h]" } },
    });
  });

  it("does not call an adjusted step a part", () => {
    expect(narrowedRead({ ...base, ok: true, adjusted: { step: 236 } })).toEqual({
      partial: false,
      fields: { ranAs: { step: 236 } },
    });
  });
});

describe("a read that was not answered", () => {
  it("carries the server's code and its guidance", () => {
    expect(
      failedRead({ ...base, ok: false, error: "SOURCE_REJECTED", guidance: "Check its syntax." }),
    ).toEqual({
      error: "Read not answered: SOURCE_REJECTED",
      guidance: "Check its syntax.",
    });
  });

  it("carries the code alone from a server that gives no guidance", () => {
    expect(failedRead({ ...base, ok: false, error: "SOURCE_UNAVAILABLE" })).toEqual({
      error: "Read not answered: SOURCE_UNAVAILABLE",
    });
  });

  it("never passes on text that is not a code", () => {
    for (const error of [undefined, "secret detail from upstream", "lower_case", ""])
      expect(failedRead({ ...base, ok: false, error })).toEqual({
        error: "Read not answered: READ_FAILED",
      });
  });
});
