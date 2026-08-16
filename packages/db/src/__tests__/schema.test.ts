import { describe, expect, it } from "vitest";
import { getTableColumns, getTableName } from "drizzle-orm";
import { sessions, users } from "../schema.js";

/**
 * Schema-shape pins (no database needed). The api's auth services and the
 * migrations both depend on these exact names — a drive-by rename would
 * typecheck fine but break at runtime, so pin them here. Behaviour that needs a
 * real planner (the partial index, cascades) is covered in migrations.test.ts.
 */
describe("users schema", () => {
  it("is the `users` table", () => {
    expect(getTableName(users)).toBe("users");
  });

  it("carries the auth columns the api reads", () => {
    const cols = getTableColumns(users);
    for (const key of [
      "id",
      "email",
      "name",
      "avatarUrl",
      "passwordHash",
      "googleId",
      "githubId",
      "discordId",
      "role",
      "status",
      "removedAt",
      "removedBy",
      "passwordUpdatedAt",
      "lastActiveAt",
      "signedOutAllAt",
      "createdAt",
      "lastSignInAt",
    ]) {
      expect(cols, `missing column mapping: ${key}`).toHaveProperty(key);
    }
  });

  it("maps camelCase properties to snake_case SQL names", () => {
    const cols = getTableColumns(users);
    expect(cols.passwordHash!.name).toBe("password_hash");
    expect(cols.avatarUrl!.name).toBe("avatar_url");
    expect(cols.lastSignInAt!.name).toBe("last_sign_in_at");
    expect(cols.lastActiveAt!.name).toBe("last_active_at");
    expect(cols.passwordUpdatedAt!.name).toBe("password_updated_at");
  });

  it("email is required, provider ids are optional", () => {
    const cols = getTableColumns(users);
    expect(cols.email!.notNull).toBe(true);
    expect(cols.googleId!.notNull).toBe(false);
    expect(cols.githubId!.notNull).toBe(false);
    expect(cols.discordId!.notNull).toBe(false);
  });

  it("defaults new accounts to the least-privileged role", () => {
    // Over-granting on insert is the failure mode that matters; a missing
    // `.default()` would silently make `role` nullable-ish at the call site.
    expect(getTableColumns(users).role!.default).toBe("read_only");
  });
});

describe("sessions schema", () => {
  it("is the `sessions` table", () => {
    expect(getTableName(sessions)).toBe("sessions");
  });

  it("carries what the auth plugin and the audit log read", () => {
    const cols = getTableColumns(sessions);
    for (const key of [
      "id",
      "userId",
      "createdAt",
      "lastSeenAt",
      "expiresAt",
      "revokedAt",
      "revokedBy",
      "revokedReason",
      "ip",
      "userAgent",
      "client",
      "authMethod",
    ]) {
      expect(cols, `missing column mapping: ${key}`).toHaveProperty(key);
    }
  });

  it("requires the columns a session cannot be valid without", () => {
    const cols = getTableColumns(sessions);
    expect(cols.userId!.notNull).toBe(true);
    expect(cols.expiresAt!.notNull).toBe(true);
    expect(cols.authMethod!.notNull).toBe(true);
    // Client context is best-effort — a sign-in must not fail for lack of it.
    expect(cols.ip!.notNull).toBe(false);
    expect(cols.client!.notNull).toBe(false);
  });
});
