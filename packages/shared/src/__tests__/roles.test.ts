import { describe, expect, it } from "vitest";
import {
  ROLES,
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
