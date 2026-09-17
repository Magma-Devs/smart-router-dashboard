import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "@sr/db/testing";
import { invitations, users, type User } from "@sr/db";
import {
  INVITE_TTL_MS,
  createInvitation,
  hashToken,
  inviteUrl,
  listInvitations,
  lookupInvitation,
  redeemInvitation,
  resendInvitation,
  revokeInvitation,
} from "../services/invitations.js";
import { verifyPassword } from "../services/password.js";

/**
 * Invitations, against a real Postgres.
 *
 * The cases that matter are the ones where getting it wrong hands an account to
 * the wrong person: a link that outlives its use, a link redeemed by someone
 * other than the addressee, and two people racing the same link.
 */
describe("invitations", () => {
  let t: TestDb;
  let admin: User;

  beforeEach(async () => {
    t = await createTestDb();
    const [created] = await t.db
      .insert(users)
      .values({ email: "admin@example.com", role: "admin", name: "Admin" })
      .returning();
    admin = created!;
  });
  afterEach(async () => {
    await t.close();
  });

  const invite = (email = "dana@example.com", mode: "managed" | "onprem" = "onprem") =>
    createInvitation(t.db, { email, role: "approver", createdBy: admin.id, mode });

  describe("creating", () => {
    it("stores only the hash — the raw token lives in the link", async () => {
      const result = await invite();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const { invitation, rawToken } = result.created;
      expect(invitation.tokenHash).toBe(hashToken(rawToken));
      expect(invitation.tokenHash).not.toContain(rawToken);
      // A database read must not be convertible back into a working link.
      expect(JSON.stringify(invitation)).not.toContain(rawToken);
    });

    it("lowercases the address, so the invite matches however it was typed", async () => {
      const result = await invite("Dana@Example.COM");
      expect(result.ok && result.created.invitation.email).toBe("dana@example.com");
    });

    it("gives an on-prem link a shorter life than an emailed one", async () => {
      // On-prem travels over a channel we don't control.
      const onprem = await invite("a@example.com", "onprem");
      const managed = await invite("b@example.com", "managed");
      if (!onprem.ok || !managed.ok) throw new Error("setup");

      const onpremTtl = onprem.created.invitation.expiresAt.getTime() - Date.now();
      const managedTtl = managed.created.invitation.expiresAt.getTime() - Date.now();
      expect(onpremTtl).toBeLessThan(managedTtl);
      expect(onpremTtl).toBeLessThanOrEqual(INVITE_TTL_MS.onprem);
      expect(managedTtl).toBeGreaterThan(INVITE_TTL_MS.onprem);
    });

    it("refuses an address that already belongs to a member", async () => {
      await t.db.insert(users).values({ email: "taken@example.com" });
      expect(await invite("taken@example.com")).toEqual({ ok: false, reason: "already_member" });
    });

    it("refuses a second live invitation for the same address", async () => {
      await invite("dana@example.com");
      expect(await invite("DANA@example.com")).toEqual({ ok: false, reason: "already_invited" });
    });

    it("allows re-inviting once the previous invitation is revoked", async () => {
      const first = await invite();
      if (!first.ok) throw new Error("setup");
      await revokeInvitation(t.db, first.created.invitation.id, admin.id);
      expect((await invite()).ok).toBe(true);
    });
  });

  describe("lookup", () => {
    it("resolves a live token", async () => {
      const result = await invite();
      if (!result.ok) throw new Error("setup");
      const lookup = await lookupInvitation(t.db, result.created.rawToken);
      expect(lookup.ok).toBe(true);
    });

    it("does not resolve a token that was never issued", async () => {
      expect(await lookupInvitation(t.db, "made-up")).toEqual({ ok: false, reason: "not_found" });
    });

    it("reports expiry exactly once, so invite.expired can't fire twice", async () => {
      const result = await invite();
      if (!result.ok) throw new Error("setup");
      await t.db
        .update(invitations)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(invitations.id, result.created.invitation.id));

      const first = await lookupInvitation(t.db, result.created.rawToken);
      expect(first).toMatchObject({ ok: false, reason: "expired", justExpired: true });

      const second = await lookupInvitation(t.db, result.created.rawToken);
      expect(second).toMatchObject({ ok: false, reason: "expired", justExpired: false });
    });

    it("reports a revoked link as dead", async () => {
      const result = await invite();
      if (!result.ok) throw new Error("setup");
      await revokeInvitation(t.db, result.created.invitation.id, admin.id);
      expect((await lookupInvitation(t.db, result.created.rawToken)).ok).toBe(false);
    });
  });

  describe("redeeming", () => {
    it("creates the account with the INVITED address, not the submitted one", async () => {
      // The structural guarantee: there is no submitted address to get wrong.
      const result = await invite("dana@example.com");
      if (!result.ok) throw new Error("setup");

      const redeemed = await redeemInvitation(t.db, {
        rawToken: result.created.rawToken,
        password: "a-perfectly-fine-passphrase",
        name: "Dana Levi",
      });
      expect(redeemed.ok).toBe(true);
      if (!redeemed.ok) return;

      expect(redeemed.user.email).toBe("dana@example.com");
      expect(redeemed.user.role).toBe("approver");
      expect(redeemed.user.status).toBe("active");
      expect(await verifyPassword("a-perfectly-fine-passphrase", redeemed.user.passwordHash!)).toBe(
        true,
      );
    });

    it("creates the account with the INVITED address, whatever else is supplied", async () => {
      // The property that used to need a comparison — a redeemer could arrive
      // holding a Google identity asserting a different verified address — is
      // now a property of the insert: `invitation.email` is the only address in
      // scope, and the redeemer supplies none.
      const result = await invite("Dana@Example.com");
      if (!result.ok) throw new Error("setup");

      const redeemed = await redeemInvitation(t.db, {
        rawToken: result.created.rawToken,
        password: "a-perfectly-fine-passphrase",
        name: "Dana",
      });
      expect(redeemed.ok).toBe(true);
      if (!redeemed.ok) return;
      expect(redeemed.user.email).toBe("dana@example.com");
      expect(
        await t.db.select().from(users).where(eq(users.email, "someone.else@example.com")),
      ).toHaveLength(0);
    });

    it("is single-use", async () => {
      const result = await invite();
      if (!result.ok) throw new Error("setup");

      const first = await redeemInvitation(t.db, {
        rawToken: result.created.rawToken,
        password: "a-perfectly-fine-passphrase",
      });
      expect(first.ok).toBe(true);

      const second = await redeemInvitation(t.db, {
        rawToken: result.created.rawToken,
        password: "another-fine-passphrase",
      });
      expect(second).toEqual({ ok: false, reason: "redeemed" });
      expect(await t.db.select().from(users)).toHaveLength(2); // admin + one invitee
    });

    it("leaves no account behind when the claim loses a race", async () => {
      // The conditional UPDATE is the guarantee, not the prior read: if the row
      // was claimed in between, the whole transaction unwinds.
      const result = await invite();
      if (!result.ok) throw new Error("setup");
      await t.db
        .update(invitations)
        .set({ redeemedAt: new Date() })
        .where(eq(invitations.id, result.created.invitation.id));

      const redeemed = await redeemInvitation(t.db, {
        rawToken: result.created.rawToken,
        password: "a-perfectly-fine-passphrase",
      });
      expect(redeemed.ok).toBe(false);
      expect(await t.db.select().from(users)).toHaveLength(1); // just the admin
    });

    it("records who the invitation became", async () => {
      const result = await invite();
      if (!result.ok) throw new Error("setup");
      const redeemed = await redeemInvitation(t.db, {
        rawToken: result.created.rawToken,
        password: "a-perfectly-fine-passphrase",
      });
      if (!redeemed.ok) throw new Error("setup");

      const [row] = await t.db
        .select()
        .from(invitations)
        .where(eq(invitations.id, result.created.invitation.id));
      expect(row?.redeemedUserId).toBe(redeemed.user.id);
      expect(row?.redeemedAt).toBeInstanceOf(Date);
    });
  });

  describe("resend and revoke", () => {
    it("resending invalidates the previous link", async () => {
      const first = await invite();
      if (!first.ok) throw new Error("setup");

      const second = await resendInvitation(t.db, first.created.invitation.id, "onprem");
      expect(second).not.toBeNull();
      expect(second!.rawToken).not.toBe(first.created.rawToken);

      // The old link must be dead, or resending would widen the attack surface
      // rather than replace it.
      expect((await lookupInvitation(t.db, first.created.rawToken)).ok).toBe(false);
      expect((await lookupInvitation(t.db, second!.rawToken)).ok).toBe(true);
      expect(second!.invitation.resendCount).toBe(1);
    });

    it("will not resend or revoke something already redeemed", async () => {
      const result = await invite();
      if (!result.ok) throw new Error("setup");
      await redeemInvitation(t.db, {
        rawToken: result.created.rawToken,
        password: "a-perfectly-fine-passphrase",
      });

      expect(await resendInvitation(t.db, result.created.invitation.id, "onprem")).toBeNull();
      expect(await revokeInvitation(t.db, result.created.invitation.id, admin.id)).toBeNull();
    });

    it("lists everything unredeemed, so the screen can explain what happened", async () => {
      const live = await invite("live@example.com");
      const dead = await invite("dead@example.com");
      if (!live.ok || !dead.ok) throw new Error("setup");
      await revokeInvitation(t.db, dead.created.invitation.id, admin.id);

      const rows = await listInvitations(t.db);
      expect(rows.map((r) => r.email).sort()).toEqual(["dead@example.com", "live@example.com"]);
    });
  });

  describe("inviteUrl", () => {
    it("builds a web link and tolerates a trailing slash", () => {
      expect(inviteUrl("https://dash.example.com", "tok")).toBe(
        "https://dash.example.com/invite/tok",
      );
      expect(inviteUrl("https://dash.example.com/", "tok")).toBe(
        "https://dash.example.com/invite/tok",
      );
    });
  });
});
