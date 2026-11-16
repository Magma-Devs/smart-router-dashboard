import { describe, expect, it } from "vitest";
import type { KeyedMutator } from "swr";
import {
  INVITE_STATE_LABELS,
  closedCount,
  inviteActions,
  memberActions,
  memberListUpdates,
  menuFocusAfter,
  menuOnScroll,
  menuPosition,
  pendingCount,
  twoFactorCell,
  visibleInvites,
  withMemberChanged,
  withMemberRemoved,
  type Invite,
  type Member,
  type MembersResponse,
} from "../team-state";

const member = (over: Partial<Member>): Member => ({
  id: "m",
  name: null,
  email: "m@example.com",
  role: "read_only",
  twoFactorEnabled: true,
  lastActiveAt: null,
  joinedAt: "2026-11-01T00:00:00.000Z",
  isMagmaAccount: false,
  ...over,
});

const list = (): MembersResponse => ({
  members: [
    member({ id: "a1", email: "a1@example.com", role: "admin" }),
    member({ id: "a2", email: "a2@example.com", role: "admin" }),
    member({ id: "r1", email: "r1@example.com", role: "requester" }),
  ],
  adminCount: 2,
  soleAdmin: false,
});

const invite = (id: string, state: Invite["state"]): Invite => ({
  id,
  email: `${id}@example.com`,
  role: "read_only",
  createdAt: "2026-11-01T00:00:00.000Z",
  expiresAt: "2026-11-08T00:00:00.000Z",
  resendCount: 0,
  state,
});

const noop = () => {};

describe("withMemberChanged", () => {
  it("changes only that member's row", () => {
    const next = withMemberChanged(list(), "r1", { role: "approver" })!;
    expect(next.members.map((m) => [m.id, m.role])).toEqual([
      ["a1", "admin"],
      ["a2", "admin"],
      ["r1", "approver"],
    ]);
  });

  it("recounts the admins, so the sole-admin prompt follows a demotion", () => {
    const next = withMemberChanged(list(), "a2", { role: "read_only" })!;
    expect(next.adminCount).toBe(1);
    expect(next.soleAdmin).toBe(true);
  });

  it("clears 2FA on a reset", () => {
    const next = withMemberChanged(list(), "a2", { twoFactorEnabled: false })!;
    expect(next.members.find((m) => m.id === "a2")?.twoFactorEnabled).toBe(false);
    expect(next.members.find((m) => m.id === "a1")?.twoFactorEnabled).toBe(true);
  });

  it("leaves a list that has not loaded alone", () => {
    expect(withMemberChanged(undefined, "a1", { role: "admin" })).toBeUndefined();
  });
});

describe("withMemberRemoved", () => {
  it("drops the row and recounts", () => {
    const next = withMemberRemoved(list(), "a1")!;
    expect(next.members.map((m) => m.id)).toEqual(["a2", "r1"]);
    expect(next.soleAdmin).toBe(true);
  });
});

describe("memberListUpdates", () => {
  // The row must change as soon as the api confirms, from its answer, and the
  // list must still be read again: a bare `mutate()` only does the second.
  function capture() {
    const calls: Array<{ update: unknown; opts: unknown }> = [];
    const mutate = ((update: unknown, opts: unknown) => {
      calls.push({ update, opts });
      return Promise.resolve(undefined);
    }) as unknown as KeyedMutator<MembersResponse>;
    return { calls, updates: memberListUpdates(mutate) };
  }

  const applied = (call: { update: unknown }) => {
    expect(typeof call.update).toBe("function");
    return (call.update as (d: MembersResponse) => MembersResponse)(list());
  };

  it("writes a role change into the row, then revalidates", () => {
    const { calls, updates } = capture();
    updates.roleChanged("r1", "admin");
    expect(calls).toHaveLength(1);
    expect(applied(calls[0]!).members.find((m) => m.id === "r1")?.role).toBe("admin");
    expect(calls[0]!.opts).toEqual({ revalidate: true });
  });

  it("writes a 2FA reset into the row, then revalidates", () => {
    const { calls, updates } = capture();
    updates.twoFactorReset("a1");
    expect(applied(calls[0]!).members.find((m) => m.id === "a1")?.twoFactorEnabled).toBe(false);
    expect(calls[0]!.opts).toEqual({ revalidate: true });
  });

  it("drops a removed member's row, then revalidates", () => {
    const { calls, updates } = capture();
    updates.removed("r1");
    expect(applied(calls[0]!).members.map((m) => m.id)).toEqual(["a1", "a2"]);
    expect(calls[0]!.opts).toEqual({ revalidate: true });
  });
});

describe("twoFactorCell", () => {
  it("reads Yes once set up", () => {
    expect(twoFactorCell(true, null)).toEqual({ label: "Yes", tip: null, tone: "plain" });
  });

  it("reads Not set up, and says what that means, rather than a bare No", () => {
    expect(twoFactorCell(false, null)).toEqual({
      label: "Not set up",
      tip: "Can't use the dashboard until they set it up",
      tone: "attention",
    });
  });

  it("tells the first admin, on their own row, how long they have", () => {
    expect(twoFactorCell(false, 12).tip).toBe(
      "You can use the dashboard for 12 more days. Set it up on your Account page.",
    );
    expect(twoFactorCell(false, 1).tip).toContain("for 1 more day.");
  });
});

describe("memberActions", () => {
  const on = { changeRole: noop, resetLink: noop, resetTwoFactor: noop, remove: noop };

  it("offers the same actions in the same order whatever the member's 2FA", () => {
    const enrolled = memberActions({ twoFactorEnabled: true }, on).map((a) => a.label);
    const not = memberActions({ twoFactorEnabled: false }, on).map((a) => a.label);
    expect(enrolled).toEqual(["Change role", "Reset link", "Reset 2FA", "Remove"]);
    expect(not).toEqual(enrolled);
  });

  it("disables Reset 2FA, with the reason, when there is nothing to reset", () => {
    const reset = memberActions({ twoFactorEnabled: false }, on).find(
      (a) => a.label === "Reset 2FA",
    )!;
    expect(reset.disabled).toBe(true);
    expect(reset.hint).toMatch(/not set up 2FA/);
    expect(
      memberActions({ twoFactorEnabled: true }, on).find((a) => a.label === "Reset 2FA")!.disabled,
    ).toBe(false);
  });

  it("marks only Remove as destructive", () => {
    expect(
      memberActions({ twoFactorEnabled: true }, on)
        .filter((a) => a.danger)
        .map((a) => a.label),
    ).toEqual(["Remove"]);
  });
});

describe("inviteActions", () => {
  const on = { resend: noop, revoke: noop };

  it("offers Resend and Revoke on a pending or an expired invitation", () => {
    expect(inviteActions({ state: "pending" }, on).map((a) => a.label)).toEqual([
      "Resend",
      "Revoke",
    ]);
    expect(inviteActions({ state: "expired" }, on).map((a) => a.label)).toEqual([
      "Resend",
      "Revoke",
    ]);
  });

  it("offers nothing on a revoked one", () => {
    expect(inviteActions({ state: "revoked" }, on)).toEqual([]);
  });
});

describe("the Invites tab", () => {
  const invites = [
    invite("p1", "pending"),
    invite("r1", "revoked"),
    invite("e1", "expired"),
    invite("p2", "pending"),
  ];

  it("counts pending invitations only", () => {
    expect(pendingCount(invites)).toBe(2);
    expect(closedCount(invites)).toBe(2);
  });

  it("hides revoked and expired invitations until asked", () => {
    expect(visibleInvites(invites, false).map((i) => i.id)).toEqual(["p1", "p2"]);
    expect(visibleInvites(invites, true).map((i) => i.id)).toEqual(["p1", "r1", "e1", "p2"]);
  });

  it("capitalises every state", () => {
    expect(INVITE_STATE_LABELS).toEqual({
      pending: "Pending",
      expired: "Expired",
      revoked: "Revoked",
    });
  });
});

describe("menuFocusAfter", () => {
  it("opens onto the first item going down and the last going up", () => {
    expect(menuFocusAfter("ArrowDown", -1, 4)).toBe(0);
    expect(menuFocusAfter("ArrowUp", -1, 4)).toBe(3);
  });

  it("wraps at both ends", () => {
    expect(menuFocusAfter("ArrowDown", 3, 4)).toBe(0);
    expect(menuFocusAfter("ArrowUp", 0, 4)).toBe(3);
  });

  it("jumps with Home and End and ignores other keys", () => {
    expect(menuFocusAfter("Home", 2, 4)).toBe(0);
    expect(menuFocusAfter("End", 0, 4)).toBe(3);
    expect(menuFocusAfter("a", 1, 4)).toBeNull();
    expect(menuFocusAfter("ArrowDown", -1, 0)).toBeNull();
  });
});

describe("menuPosition", () => {
  const viewport = { width: 1024, height: 700 };
  const menu = { width: 170, height: 150 };

  it("opens under the button with the right edges aligned", () => {
    expect(menuPosition({ top: 100, bottom: 130, right: 900 }, menu, viewport)).toEqual({
      left: 730,
      top: 134,
    });
  });

  it("opens above the button when there is no room below", () => {
    expect(menuPosition({ top: 600, bottom: 630, right: 900 }, menu, viewport).top).toBe(446);
  });

  it("stays 8 px inside the viewport's edges", () => {
    expect(menuPosition({ top: 100, bottom: 130, right: 100 }, menu, viewport).left).toBe(8);
    expect(menuPosition({ top: 100, bottom: 130, right: 1100 }, menu, viewport).left).toBe(846);
  });
});

describe("menuOnScroll", () => {
  it("follows the button while any of it is on screen", () => {
    expect(menuOnScroll({ top: 300, bottom: 330, right: 900 }, 700)).toBe("follow");
    expect(menuOnScroll({ top: -20, bottom: 10, right: 900 }, 700)).toBe("follow");
    expect(menuOnScroll({ top: 690, bottom: 720, right: 900 }, 700)).toBe("follow");
  });

  it("closes once the button has scrolled out of view", () => {
    expect(menuOnScroll({ top: -40, bottom: -10, right: 900 }, 700)).toBe("close");
    expect(menuOnScroll({ top: 700, bottom: 730, right: 900 }, 700)).toBe("close");
  });
});
