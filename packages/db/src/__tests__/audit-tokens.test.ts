import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../testing.js";
import {
  mintAuditToken,
  resolveAuditToken,
  revokeAuditToken,
  revokeAuditTokensCreatedBy,
} from "../audit-tokens.js";
import { auditTokens } from "../schema-audit.js";
import { users } from "../schema.js";

let t: TestDb;

beforeEach(async () => {
  t = await createTestDb();
});
afterEach(async () => {
  await t.close();
});

async function admin(email: string): Promise<string> {
  const [row] = await t.db
    .insert(users)
    .values({ email, role: "admin" })
    .returning({ id: users.id });
  return row!.id;
}

describe("revokeAuditTokensCreatedBy", () => {
  it("revokes the live tokens one admin created, and nobody else's", async () => {
    const bea = await admin("bea@example.com");
    const ada = await admin("ada@example.com");
    const live = await mintAuditToken(t.db, { name: "SIEM", createdBy: bea, createdByName: "Bea" });
    const gone = await mintAuditToken(t.db, { name: "old", createdBy: bea, createdByName: "Bea" });
    await revokeAuditToken(t.db, { id: gone.row.id, revokedBy: bea, revokedByName: "Bea" });
    const adas = await mintAuditToken(t.db, {
      name: "Ada's",
      createdBy: ada,
      createdByName: "Ada",
    });

    const revoked = await revokeAuditTokensCreatedBy(t.db, {
      createdBy: bea,
      revokedBy: ada,
      revokedByName: "Ada",
    });

    // Only the one that still worked, so a revocation row is never written twice.
    expect(revoked.map((r) => r.id)).toEqual([live.row.id]);
    expect(revoked[0]).toMatchObject({ revokedBy: ada, revokedByName: "Ada" });
    expect(await resolveAuditToken(t.db, live.secret)).toBeNull();
    expect(await resolveAuditToken(t.db, adas.secret)).not.toBeNull();
    const [earlier] = await t.db.select().from(auditTokens).where(eq(auditTokens.id, gone.row.id));
    expect(earlier?.revokedByName).toBe("Bea");
  });
});
