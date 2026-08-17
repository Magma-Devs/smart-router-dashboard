import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@sr/db/testing";
import { invitations, sessions, users, type User } from "@sr/db";
import {
  changeMemberRole,
  countAdmins,
  listMembers,
  removeMember,
} from "../services/members.js";
import { createInvitation } from "../services/invitations.js";
import { createSession, listActiveSessions } from "../services/sessions.js";

describe("members", () => {
  let t: TestDb;
  let admin: User;
  let member: User;

  beforeEach(async () => {
    t = await createTestDb();
    const [a] = await t.db
      .insert(users)
      .values({ email: "admin@example.com", role: "admin", name: "Admin" })
      .returning();
    admin = a!;
    const [m] = await t.db
      .insert(users)
      .values({ email: "dana@example.com", role: "approver", name: "Dana Levi" })
      .returning();
    member = m!;
  });
  afterEach(async () => {
    await t.close();
  });

  describe("the list", () => {
    it("shows active people with what the review needs", async () => {
      const rows = await listMembers(t.db);
      expect(rows.map((r) => r.email)).toEqual(["admin@example.com", "dana@example.com"]);
      const dana = rows.find((r) => r.email === "dana@example.com")!;
      expect(dana.role).toBe("approver");
      expect(dana.joinedAt).toBeInstanceOf(Date);
    });

    it("leaves 2FA null rather than claiming 'no'", async () => {
      // MAG-2730 hasn't shipped. "No" would be true today and wrong the day it
      // does, and the repo's honesty contract rules out inventing the value.
      expect((await listMembers(t.db)).every((r) => r.twoFactorEnabled === null)).toBe(true);
    });

    it("omits removed people — their record is for the audit log, not this screen", async () => {
      await removeMember(t.db, { id: member.id, actorId: admin.id });
      expect((await listMembers(t.db)).map((r) => r.email)).toEqual(["admin@example.com"]);
      // But the row itself survives.
      expect(await t.db.select().from(users)).toHaveLength(2);
    });

    it("counts admins, for the prompt that is never a block", async () => {
      expect(await countAdmins(t.db)).toBe(1);
      await changeMemberRole(t.db, { id: member.id, role: "admin", actorId: admin.id });
      expect(await countAdmins(t.db)).toBe(2);
    });
  });

  describe("changing a role", () => {
    it("takes effect on the row, so the current session sees it", async () => {
      const result = await changeMemberRole(t.db, {
        id: member.id,
        role: "read_only",
        actorId: admin.id,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.previousRole).toBe("approver");
      expect(result.user.role).toBe("read_only");
    });

    it("does not revoke sessions, because it does not need to", async () => {
      // The api reads the role from the row on every request. Revoking would
      // sign someone out for a change that already applies.
      await createSession(t.db, {
        userId: member.id,
        authMethod: "password",
        client: { ip: null, userAgent: null },
      });
      await changeMemberRole(t.db, { id: member.id, role: "read_only", actorId: admin.id });
      expect(await listActiveSessions(t.db, member.id)).toHaveLength(1);
    });

    it("refuses self-demotion", async () => {
      expect(await changeMemberRole(t.db, { id: admin.id, role: "read_only", actorId: admin.id })).toEqual({
        ok: false,
        reason: "self",
      });
    });

    it("refuses someone already removed", async () => {
      await removeMember(t.db, { id: member.id, actorId: admin.id });
      expect(await changeMemberRole(t.db, { id: member.id, role: "admin", actorId: admin.id })).toEqual({
        ok: false,
        reason: "not_found",
      });
    });
  });

  describe("removing someone", () => {
    it("is a state change, not a deletion", async () => {
      const result = await removeMember(t.db, { id: member.id, actorId: admin.id });
      expect(result.ok).toBe(true);

      const [row] = await t.db.select().from(users).where(eq(users.id, member.id));
      expect(row?.status).toBe("removed");
      expect(row?.removedBy).toBe(admin.id);
      expect(row?.removedAt).toBeInstanceOf(Date);
      // The name stays, which is what an auditor reads.
      expect(row?.email).toBe("dana@example.com");
      expect(row?.name).toBe("Dana Levi");
    });

    it("kills their sessions within the same transaction", async () => {
      await createSession(t.db, { userId: member.id, authMethod: "password", client: { ip: null, userAgent: null } });
      await createSession(t.db, { userId: member.id, authMethod: "password", client: { ip: null, userAgent: null } });

      await removeMember(t.db, { id: member.id, actorId: admin.id });

      expect(await listActiveSessions(t.db, member.id)).toHaveLength(0);
      const rows = await t.db.select().from(sessions).where(eq(sessions.userId, member.id));
      expect(rows.every((r) => r.revokedReason === "member_removed")).toBe(true);
    });

    it("stamps the cutoff too, for tokens we hold no session row for", async () => {
      await removeMember(t.db, { id: member.id, actorId: admin.id });
      const [row] = await t.db.select().from(users).where(eq(users.id, member.id));
      expect(row?.signedOutAllAt).toBeInstanceOf(Date);
    });

    it("revokes a pending invitation to their address", async () => {
      // Otherwise removing someone mid-onboarding leaves a live link that
      // recreates them.
      const invited = await createInvitation(t.db, {
        email: "newcomer@example.com",
        role: "requester",
        createdBy: admin.id,
        mode: "onprem",
      });
      if (!invited.ok) throw new Error("setup");
      const [newcomer] = await t.db
        .insert(users)
        .values({ email: "newcomer@example.com", role: "requester" })
        .returning();

      await removeMember(t.db, { id: newcomer!.id, actorId: admin.id });

      const [inv] = await t.db
        .select()
        .from(invitations)
        .where(eq(invitations.id, invited.created.invitation.id));
      expect(inv?.revokedAt).toBeInstanceOf(Date);
    });

    it("frees their address to be invited again", async () => {
      await removeMember(t.db, { id: member.id, actorId: admin.id });
      const again = await createInvitation(t.db, {
        email: "dana@example.com",
        role: "read_only",
        createdBy: admin.id,
        mode: "onprem",
      });
      expect(again.ok).toBe(true);
    });

    it("refuses self-removal", async () => {
      expect(await removeMember(t.db, { id: admin.id, actorId: admin.id })).toEqual({
        ok: false,
        reason: "self",
      });
    });

    it("does not block removing the last admin", async () => {
      // Deliberate divergence from lava-connect: admin has to stay
      // transferable, or a departing employee's account can't be removed. The
      // sole-admin case is a prompt on the screen, not a refusal here.
      const [other] = await t.db
        .insert(users)
        .values({ email: "other@example.com", role: "admin" })
        .returning();
      expect((await removeMember(t.db, { id: admin.id, actorId: other!.id })).ok).toBe(true);
      expect(await countAdmins(t.db)).toBe(1);
    });
  });
});
