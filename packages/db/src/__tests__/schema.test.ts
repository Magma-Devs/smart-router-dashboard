import { describe, expect, it } from "vitest";
import { getTableColumns, getTableName } from "drizzle-orm";
import { users } from "../schema.js";

/**
 * Schema-shape pins (no database needed). The api's auth services and the
 * 0000_init.sql migration both depend on these exact names — a drive-by
 * rename would typecheck fine but break at runtime, so pin them here.
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
      "isSuspended",
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
  });

  it("email is required, provider ids are optional", () => {
    const cols = getTableColumns(users);
    expect(cols.email!.notNull).toBe(true);
    expect(cols.googleId!.notNull).toBe(false);
    expect(cols.githubId!.notNull).toBe(false);
    expect(cols.discordId!.notNull).toBe(false);
  });
});
