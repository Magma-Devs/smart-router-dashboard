import { afterEach, describe, expect, it } from "vitest";
import { targetLabel } from "@/components/audit/bits";
import { auditExportPath, EMPTY_FILTERS, hasAnyFilter } from "@/components/audit/useAuditFeed";
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

describe("auditExportPath", () => {
  const savedTz = process.env.TZ;
  afterEach(() => {
    if (savedTz === undefined) delete process.env.TZ;
    else process.env.TZ = savedTz;
  });

  it("exports the whole log when nothing is filtered", () => {
    expect(auditExportPath(EMPTY_FILTERS)).toBe("/api/audit/export.csv");
  });

  /** The file has to answer the same question the screen is showing; a filter
   *  the download quietly ignored would produce a wider record than the person
   *  thought they asked for. */
  it("carries every filter the screen has applied", () => {
    process.env.TZ = "UTC";
    const path = auditExportPath({
      group: "config",
      actor: "dana@customer.com",
      targetId: "ep_8143",
      from: "2026-08-01",
      to: "2026-08-09",
    });
    expect(path).toContain("group=config");
    expect(path).toContain("actor=dana%40customer.com");
    expect(path).toContain("target_id=ep_8143");
    expect(path).toContain("from=2026-08-01T00%3A00%3A00.000Z");
    // Inclusive of the whole closing day, not midnight at the start of it.
    expect(path).toContain("to=2026-08-09T23%3A59%3A59.999Z");
  });

  /** The dates are days on the reader's clock, the one the log is shown in:
   *  a day picked in Jerusalem starts at 21:00 UTC the evening before. */
  it("reads From and To as whole days where the reader is", () => {
    process.env.TZ = "Asia/Jerusalem";
    const summer = auditExportPath({ ...EMPTY_FILTERS, from: "2026-08-01", to: "2026-08-09" });
    expect(summer).toContain("from=2026-07-31T21%3A00%3A00.000Z");
    expect(summer).toContain("to=2026-08-09T20%3A59%3A59.999Z");

    process.env.TZ = "America/New_York";
    const winter = auditExportPath({ ...EMPTY_FILTERS, from: "2026-01-05", to: "2026-01-05" });
    expect(winter).toContain("from=2026-01-05T05%3A00%3A00.000Z");
    expect(winter).toContain("to=2026-01-06T04%3A59%3A59.999Z");
  });

  it("does not pin an order or a page size", () => {
    // Both belong to the on-screen feed. An export is the whole match, and the
    // spreadsheet re-sorts in one click.
    const path = auditExportPath({ ...EMPTY_FILTERS, group: "access" });
    expect(path).not.toContain("order=");
    expect(path).not.toContain("per_page=");
    expect(path).not.toContain("after=");
  });
});
