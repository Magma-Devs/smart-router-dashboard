import { describe, expect, it } from "vitest";
import {
  ROLES,
  ROLE_COLORS,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  isRole,
  roleAtLeast,
  roleRank,
  type Role,
} from "../constants/roles.js";

describe("ROLES", () => {
  it("is ordered least- to most-privileged", () => {
    expect(ROLES).toEqual(["read_only", "requester", "approver", "admin"]);
  });

  it("labels and describes every role", () => {
    for (const role of ROLES) {
      expect(ROLE_LABELS[role], `no label for ${role}`).toBeTruthy();
      expect(ROLE_DESCRIPTIONS[role], `no description for ${role}`).toBeTruthy();
    }
  });
});

describe("ROLE_DESCRIPTIONS", () => {
  it("promises no approvals: requester and approver have read-only's access", () => {
    expect(ROLE_DESCRIPTIONS.requester).toBe("Same access as Read-only for now.");
    expect(ROLE_DESCRIPTIONS.approver).toBe("Same access as Read-only for now.");
    for (const role of ROLES) {
      expect(ROLE_DESCRIPTIONS[role], role).not.toMatch(/approv|propos/i);
    }
  });

  it("says what an admin can do", () => {
    expect(ROLE_DESCRIPTIONS.admin).toBe(
      "Can invite and remove members, change roles, and reset passwords and 2FA.",
    );
  });

  it("uses no long dashes", () => {
    for (const role of ROLES) expect(ROLE_DESCRIPTIONS[role], role).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("ROLE_COLORS", () => {
  it("gives every role its own colour", () => {
    const colours = ROLES.map((role) => ROLE_COLORS[role]);
    for (const [i, c] of colours.entries()) {
      expect(c, `no colour for ${ROLES[i]}`).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(new Set(colours).size).toBe(ROLES.length);
  });

  it("draws no role in a red hue", () => {
    // Red is for errors and destructive actions. Hue of the sRGB colour, in
    // degrees: red sits within 20 of 0.
    for (const role of ROLES) {
      const [r, g, b] = [1, 3, 5].map(
        (i) => parseInt(ROLE_COLORS[role].slice(i, i + 2), 16) / 255,
      ) as [number, number, number];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max - min < 0.1) continue; // a grey has no hue
      let hue =
        max === r
          ? ((g - b) / (max - min)) * 60
          : max === g
            ? (2 + (b - r) / (max - min)) * 60
            : (4 + (r - g) / (max - min)) * 60;
      if (hue < 0) hue += 360;
      expect(Math.min(hue, 360 - hue), `${role} is red`).toBeGreaterThan(20);
    }
  });
});

describe("isRole", () => {
  it("accepts the four roles", () => {
    for (const role of ROLES) expect(isRole(role)).toBe(true);
  });

  it("rejects anything else", () => {
    // `owner` and `member` are the old vocabularies (prototype and v1 enum) —
    // if either leaks back in, it must not be treated as a role.
    for (const value of ["owner", "member", "Admin", "", null, undefined, 3, {}]) {
      expect(isRole(value), `should reject ${String(value)}`).toBe(false);
    }
  });
});

describe("roleAtLeast", () => {
  it("is reflexive — every role meets its own bar", () => {
    for (const role of ROLES) expect(roleAtLeast(role, role)).toBe(true);
  });

  it("is cumulative in one direction only", () => {
    const pairs: Array<[Role, Role, boolean]> = [
      ["admin", "read_only", true],
      ["admin", "approver", true],
      ["approver", "requester", true],
      ["requester", "read_only", true],
      ["read_only", "requester", false],
      ["requester", "approver", false],
      ["approver", "admin", false],
      ["read_only", "admin", false],
    ];
    for (const [role, minimum, expected] of pairs) {
      expect(roleAtLeast(role, minimum), `${role} >= ${minimum}`).toBe(expected);
    }
  });

  it("treats an unrecognised role as unprivileged, including for the lowest bar", () => {
    // The rolling-deploy case: a row written by a newer build carries a role
    // this one has never heard of. Least access is the safe answer.
    for (const value of ["superuser", "owner", "member", null, undefined, ""]) {
      expect(roleAtLeast(value, "read_only"), `${String(value)} >= read_only`).toBe(false);
      expect(roleAtLeast(value, "admin"), `${String(value)} >= admin`).toBe(false);
    }
  });
});

describe("roleRank", () => {
  it("orders the roles for a sortable member list", () => {
    expect([...ROLES].sort((a, b) => roleRank(b) - roleRank(a))).toEqual([
      "admin",
      "approver",
      "requester",
      "read_only",
    ]);
  });

  it("sorts an unknown role below every real one", () => {
    expect(roleRank("nonsense")).toBeLessThan(roleRank("read_only"));
  });
});
