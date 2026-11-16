import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, AUDIT_GROUPS } from "@sr/shared";
import {
  AUDIT_EVENT_LABELS,
  AUDIT_GROUP_LABELS,
  eventLabel,
  groupLabel,
} from "@/components/audit/event-labels";

/**
 * The names the audit page gives events and groups. Every event having one is
 * the typecheck's job (`Record<AuditAction, string>`); these pin what the
 * names say.
 */

describe("eventLabel", () => {
  it("names an event in words rather than by its code", () => {
    expect(eventLabel("password.reset_requested")).toBe("Password reset requested");
    expect(eventLabel("signin.failed")).toBe("Sign-in failed");
    expect(eventLabel("session.revoked")).toBe("Session ended");
  });

  it("reads a code outside the catalog as itself", () => {
    expect(eventLabel("widget.frobbed")).toBe("widget.frobbed");
  });

  it("gives every event its own name, none of them a code", () => {
    const labels = AUDIT_ACTIONS.map((action) => AUDIT_EVENT_LABELS[action]);
    for (const [i, label] of labels.entries()) {
      expect(label, AUDIT_ACTIONS[i]).toMatch(/^[A-Z0-9][^._]*$/);
    }
    // Two events under one name would read as one on screen.
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("writes US English, 2FA by that name, and no long dashes", () => {
    for (const label of [
      ...Object.values(AUDIT_EVENT_LABELS),
      ...Object.values(AUDIT_GROUP_LABELS),
    ]) {
      expect(label).not.toMatch(/[—–]|cancelled|authoris|recognis|two-factor/i);
      expect(label).not.toMatch(/2fa/);
    }
  });
});

describe("groupLabel", () => {
  it("names every group", () => {
    for (const group of AUDIT_GROUPS) expect(groupLabel(group)).toBe(AUDIT_GROUP_LABELS[group]);
    expect(groupLabel("2fa")).toBe("2FA");
    expect(groupLabel("config")).toBe("Configuration");
  });

  it("reads the writer's fallback group as itself", () => {
    expect(groupLabel("unclassified")).toBe("unclassified");
  });
});
