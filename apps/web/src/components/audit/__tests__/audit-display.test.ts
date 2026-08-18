import { describe, expect, it } from "vitest";
import { eventDateParts, eventTime, targetLabel } from "@/components/audit/bits";
import { EMPTY_FILTERS, hasAnyFilter } from "@/components/audit/useAuditFeed";
import type { AuditEventRecord } from "@sr/shared";

/**
 * The pure parts of the audit row. Components themselves aren't unit-tested
 * here by repo convention — these are the bits where being wrong is invisible
 * rather than obvious on screen.
 */

function event(over: Partial<AuditEventRecord> = {}): AuditEventRecord {
  return {
    id: "0f4c",
    time: "2026-08-09T14:22:07.000Z",
    action: "endpoint.providers.changed",
    group: "config",
    source: "dashboard",
    actor: { type: "user", id: null, name: "Dana Levi", email: "dana@customer.com" },
    target: { type: "endpoint", id: "ep_8143", name: "eth-jsonrpc" },
    request: null,
    note: null,
    changes: [],
    ...over,
  };
}

describe("eventTime", () => {
  it("writes the instant exactly as the ticket does", () => {
    expect(eventTime("2026-08-09T14:22:07.000Z")).toBe("2026-08-09 14:22:07Z");
  });

  /**
   * The one that matters. Rendering through `Date` would shift the clock by the
   * reader's offset, so two people looking at the same incident would quote
   * different times to each other — and neither would be wrong on their own
   * screen, which is what makes it hard to catch.
   */
  it("does not shift with the reader's timezone", () => {
    const iso = "2026-08-09T23:30:00.000Z";
    expect(eventTime(iso)).toBe("2026-08-09 23:30:00Z");
    expect(eventTime(iso).slice(0, 10)).toBe("2026-08-09");
    expect(eventDateParts(iso)).toEqual({ date: "2026-08-09", time: "23:30:00Z" });
  });

  it("keeps whole seconds, dropping the milliseconds the API sends", () => {
    expect(eventTime("2026-08-09T14:22:07.891Z")).toBe("2026-08-09 14:22:07Z");
  });
});

describe("targetLabel", () => {
  it("shows the name it had at the time, with the id that outlives a rename", () => {
    expect(targetLabel(event())).toBe("eth-jsonrpc (ep_8143)");
  });

  it("falls back to the id alone rather than printing an empty bracket", () => {
    expect(targetLabel(event({ target: { type: "endpoint", id: "ep_8143", name: null } }))).toBe(
      "ep_8143",
    );
  });

  it("is null when the event acted on nothing", () => {
    expect(targetLabel(event({ target: null }))).toBeNull();
  });
});

describe("hasAnyFilter", () => {
  /** Drives which of the two "nothing here" states a reader sees, so getting it
   *  wrong tells someone with a narrow filter that nothing ever happened. */
  it("is false for an untouched form", () => {
    expect(hasAnyFilter(EMPTY_FILTERS)).toBe(false);
  });

  it("is false for whitespace someone typed and deleted", () => {
    expect(hasAnyFilter({ ...EMPTY_FILTERS, actor: "   " })).toBe(false);
  });

  it("is true for any real value", () => {
    expect(hasAnyFilter({ ...EMPTY_FILTERS, group: "config" })).toBe(true);
    expect(hasAnyFilter({ ...EMPTY_FILTERS, from: "2026-08-01" })).toBe(true);
  });
});
