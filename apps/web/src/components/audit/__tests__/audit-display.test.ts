import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  actorEmail,
  approvalField,
  AuditDetail,
  auditSheetHeading,
  targetName,
} from "@/components/audit/bits";
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

/** A refused sign-in for an address with no account: the typed address is
 *  both the actor's name and email, and the target is that address. */
const failedSignIn = (over: Partial<AuditEventRecord> = {}): AuditEventRecord =>
  event({
    action: "signin.failed",
    group: "access",
    actor: { type: "user", id: null, name: "dana@example.com", email: "dana@example.com" },
    target: null,
    note: "unknown address",
    context: { ip: "203.0.113.7", client: "Firefox 140 / Linux", session: null },
    ...over,
  });

const detail = (e: AuditEventRecord) =>
  renderToStaticMarkup(createElement(AuditDetail, { event: e }));
const count = (html: string, text: string) => html.split(text).length - 1;

describe("targetName", () => {
  it("shows the name it had at the time and leaves the id to the detail sheet", () => {
    expect(targetName(event())).toBe("eth-jsonrpc");
  });

  it("falls back to the kind of object rather than a long id", () => {
    const unnamed = event({
      target: { type: "session", id: "4f1e9a0c-1b2d-4e3f-8a9b-0c1d2e3f4a5b", name: null },
    });
    expect(targetName(unnamed)).toBe("session");
  });

  it("is null when the event acted on nothing", () => {
    expect(targetName(event({ target: null }))).toBeNull();
  });
});

describe("actorEmail", () => {
  it("is the address when it says more than the name", () => {
    expect(actorEmail(event().actor)).toBe("dana@customer.com");
  });

  /** A failed sign-in records the typed address as the name too. */
  it("is null when the name already is the address, in any case", () => {
    expect(actorEmail(failedSignIn().actor)).toBeNull();
    expect(
      actorEmail({ type: "user", id: null, name: "Dana@Example.com", email: "dana@example.com" }),
    ).toBeNull();
  });

  it("is null for an actor with no address", () => {
    expect(actorEmail({ type: "host", id: null, name: "root", email: null })).toBeNull();
  });
});

describe("approvalField", () => {
  it("names the request a change came from", () => {
    expect(approvalField(event({ request: "req_31" }))).toEqual({ request: "req_31" });
  });

  /** Approval events are not written, so "not required" would describe a
   *  check that does not exist. */
  it("shows no field while approvals are not written", () => {
    expect(approvalField(event())).toBeNull();
    expect(approvalField(failedSignIn())).toBeNull();
  });

  it("says not required for a config change once approvals are written, and nothing for a sign-in", () => {
    expect(approvalField(event(), true)).toBe("not required");
    expect(approvalField(failedSignIn(), true)).toBeNull();
  });
});

describe("auditSheetHeading", () => {
  it("titles the sheet with the event's name and its group's name", () => {
    expect(auditSheetHeading(failedSignIn())).toEqual({
      title: "Sign-in failed",
      sub: "dana@example.com · Access",
    });
    expect(auditSheetHeading(event({ action: "2fa.reset", group: "2fa" })).sub).toBe(
      "Dana Levi · 2FA",
    );
  });
});

describe("AuditDetail", () => {
  /** The emails state times in UTC; the sheet gives the instant in UTC beside
   *  the reader's own, so a row can be matched with the notice it sent. */
  it("gives the time in UTC as well", () => {
    expect(detail(event())).toMatch(
      /<time dateTime="2026-08-09T14:22:07.000Z"[^>]*>Aug 9, 2026, 14:22:07 UTC<\/time>/,
    );
  });

  it("keeps the event's code and the target's id", () => {
    const html = detail(event());
    expect(html).toContain("endpoint.providers.changed");
    expect(html).toContain("eth-jsonrpc");
    expect(html).toContain("endpoint · ep_8143");
  });

  it("shows no approval field while approvals are not written", () => {
    expect(detail(event())).not.toContain("Approval request");
    expect(detail(event({ request: "req_31" }))).toContain("req_31");
  });

  it("names a failed sign-in's address once", () => {
    expect(count(detail(failedSignIn()), "dana@example.com")).toBe(1);
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
