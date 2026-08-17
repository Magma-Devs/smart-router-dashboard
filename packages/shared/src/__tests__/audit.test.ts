import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTIONS,
  AUDIT_EVENTS,
  AUDIT_GROUPS,
  auditActionsInGroup,
  auditEventSpec,
  auditGroupOf,
  carriesAccessContext,
  carriesChanges,
  isAuditAction,
  isAuditGroup,
  type AuditAction,
} from "../constants/audit-events.js";
import {
  AUDIT_CHANGED,
  AUDIT_DELETED,
  AUDIT_NEW,
  AUDIT_NONE,
  auditChange,
  auditFlag,
  auditList,
  auditSecret,
  auditText,
  isAuditMarker,
} from "../audit/format.js";

/**
 * The catalog's invariants, not its contents. Asserting all forty names would
 * only restate the file; what is worth pinning is the handful of properties the
 * ticket states as done-whens, because those are what a later edit breaks
 * silently.
 */
describe("audit event catalog", () => {
  it("covers every group with at least one event", () => {
    for (const group of AUDIT_GROUPS) {
      expect(auditActionsInGroup(group).length, `empty group: ${group}`).toBeGreaterThan(0);
    }
  });

  it("places every event in a known group", () => {
    for (const action of AUDIT_ACTIONS) {
      expect(isAuditGroup(auditGroupOf(action)), `bad group on ${action}`).toBe(true);
    }
  });

  it("names events as lowercase dotted segments", () => {
    for (const action of AUDIT_ACTIONS) {
      expect(action, `${action} is not a well-formed event name`).toMatch(
        /^[a-z0-9]+(?:[._][a-z0-9]+)*$/,
      );
    }
  });

  /**
   * MAG-2770's done-when: "Access events carry the IP, the client and the
   * session. Config events do not." This is the assertion that keeps a later
   * catalog edit from quietly widening what a config row may hold — the database
   * CHECK is a backstop, but this is where the rule is decided.
   */
  it("never lets a config or approval event carry access context", () => {
    for (const action of [...auditActionsInGroup("config"), ...auditActionsInGroup("approval")]) {
      expect(carriesAccessContext(action), `${action} must not carry access context`).toBe(false);
    }
  });

  it("gives every access event its context", () => {
    for (const action of auditActionsInGroup("access")) {
      expect(carriesAccessContext(action), `${action} must carry access context`).toBe(true);
    }
  });

  /** Host recovery has no browser: no IP, no client, no session to record. */
  it("does not ask host recovery for browser context it cannot have", () => {
    expect(carriesAccessContext("host.recovery")).toBe(false);
  });

  it("marks the events that carry a before and after", () => {
    expect(carriesChanges("member.role_changed")).toBe(true);
    expect(carriesChanges("endpoint.providers.changed")).toBe(true);
    // Facts with nothing to diff.
    expect(carriesChanges("signin.succeeded")).toBe(false);
    expect(carriesChanges("change.approved")).toBe(false);
  });

  it("carries a published description for every event", () => {
    // docs/AUDIT.md is generated from these; a blank one ships a blank doc row.
    for (const action of AUDIT_ACTIONS) {
      expect(
        auditEventSpec(action).description.length,
        `${action} has no description`,
      ).toBeGreaterThan(20);
    }
  });

  it("recognises known event names and rejects everything else", () => {
    expect(isAuditAction("signin.failed")).toBe(true);
    expect(isAuditAction("signin.failure")).toBe(false);
    expect(isAuditAction("")).toBe(false);
    expect(isAuditAction(null)).toBe(false);
    // Inherited object properties must not read as events.
    expect(isAuditAction("toString")).toBe(false);
    expect(isAuditAction("constructor")).toBe(false);
  });

  it("exposes every catalog key through AUDIT_ACTIONS", () => {
    expect(AUDIT_ACTIONS).toHaveLength(Object.keys(AUDIT_EVENTS).length);
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });

  it("keeps the four tickets' events all present", () => {
    // One representative per emitting task — the catalog is the contract
    // between them, so losing a whole task's block should fail loudly.
    const expected: AuditAction[] = [
      "signin.failed", // MAG-2729
      "2fa.reset", // MAG-2730
      "endpoint.providers.changed", // MAG-2731
      "setup.completed", // added here, absent from 2770's published table
    ];
    for (const action of expected) expect(isAuditAction(action)).toBe(true);
  });
});

describe("audit value formatting", () => {
  it("writes an empty value as (none), never blank", () => {
    expect(auditText(null)).toBe(AUDIT_NONE);
    expect(auditText(undefined)).toBe(AUDIT_NONE);
    expect(auditText("")).toBe(AUDIT_NONE);
    expect(auditText("   ")).toBe(AUDIT_NONE);
    expect(auditList([])).toBe(AUDIT_NONE);
    expect(auditList(null)).toBe(AUDIT_NONE);
    expect(auditFlag(null)).toBe(AUDIT_NONE);
  });

  it("keeps real scalars intact", () => {
    expect(auditText("eth-jsonrpc")).toBe("eth-jsonrpc");
    expect(auditText(" primary ")).toBe("primary");
    expect(auditText(0)).toBe("0");
  });

  it("writes on and off as yes and no", () => {
    expect(auditFlag(true)).toBe("yes");
    expect(auditFlag(false)).toBe("no");
  });

  it("writes a list in a stable order regardless of input order", () => {
    expect(auditList(["QuickNode", "Alchemy"])).toBe("Alchemy, QuickNode");
    expect(auditList(["Alchemy", "QuickNode"])).toBe("Alchemy, QuickNode");
  });

  it("de-duplicates and drops blanks from a list", () => {
    expect(auditList(["Alchemy", "Alchemy", "", null, "  ", "QuickNode"])).toBe(
      "Alchemy, QuickNode",
    );
  });

  it("reads a removal as a real transition", () => {
    // The reason (none) exists at all: this has to be unambiguous.
    const change = auditChange("providers", auditList(["Alchemy", "QuickNode"]), auditList([]));
    expect(change).toEqual({ field: "providers", from: "Alchemy, QuickNode", to: AUDIT_NONE });
  });

  it("never writes a secret, only that it changed", () => {
    const secret = "sk_live_9f2a4c81b7e30d6a91be";
    const written = auditSecret(secret);
    expect(written).toBe("(changed, ends 91be)");
    // The whole point: nothing but the last four characters may appear.
    expect(written).not.toContain("sk_live");
    expect(written).not.toContain(secret.slice(0, -4));
  });

  it("redacts a node URL the same way", () => {
    expect(auditSecret("https://eth.example.com/v2/6d41f8a24c02")).toBe("(changed, ends 4c02)");
  });

  it("withholds the suffix when it would reveal most of a short value", () => {
    expect(auditSecret("abcd")).toBe(AUDIT_CHANGED);
    expect(auditSecret("abcdefg")).toBe(AUDIT_CHANGED);
    // At the boundary a four-character tail is half the value — still too much
    // to be worth it, so the guard is exclusive.
    expect(auditSecret("abcdefgh")).toBe("(changed, ends efgh)");
  });

  it("treats an absent secret as absent, not as changed", () => {
    // "the field was cleared" and "the field holds a secret" are different facts.
    expect(auditSecret(null)).toBe(AUDIT_NONE);
    expect(auditSecret("")).toBe(AUDIT_NONE);
  });

  it("recognises its own markers", () => {
    expect(isAuditMarker(AUDIT_NONE)).toBe(true);
    expect(isAuditMarker(AUDIT_NEW)).toBe(true);
    expect(isAuditMarker(AUDIT_DELETED)).toBe(true);
    expect(isAuditMarker(AUDIT_CHANGED)).toBe(true);
    expect(isAuditMarker(auditSecret("sk_live_9f2a4c81b7e30d6a91be"))).toBe(true);
    expect(isAuditMarker("Alchemy, QuickNode")).toBe(false);
    expect(isAuditMarker("(changed, ends 91be) and also leaked")).toBe(false);
  });

  it("drops a field that did not move", () => {
    expect(auditChange("role", "approver", "approver")).toBeNull();
    expect(auditChange("role", "requester", "approver")).toEqual({
      field: "role",
      from: "requester",
      to: "approver",
    });
  });

  it("reads a creation and a deletion as the ticket writes them", () => {
    expect(auditChange("providers", AUDIT_NEW, auditList(["Alchemy"]))).toEqual({
      field: "providers",
      from: AUDIT_NEW,
      to: "Alchemy",
    });
    expect(auditChange("host", "eth.example.com", AUDIT_DELETED)?.to).toBe(AUDIT_DELETED);
  });
});
