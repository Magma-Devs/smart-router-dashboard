/**
 * Who a browser's usage data says it is (MAG-5373, MAG-5413). The web starts
 * Mixpanel's browser SDK with what `GET /api/usage/config` answers; this
 * decides the signed-in user's part of that answer: an opaque id, whether
 * they are our own staff, their role, the month the account was made, whether
 * 2FA is set up and how this session signed in. A customer's address or
 * account id never goes out; a staff member's address does, so our own
 * profiles are named.
 */
import { createHash } from "node:crypto";
import type { Database } from "@sr/db";
import { users } from "@sr/db";
import type { Role } from "@sr/shared";
import type { UsageSettings } from "../config.js";

/** How a session signed in, as usage data names it: the first factor, never the code after it. */
export const USAGE_SIGN_INS = ["password", "google", "github", "invite", "other"] as const;
export type UsageSignIn = (typeof USAGE_SIGN_INS)[number];

/** The signed-in user as usage data names them. */
export interface UsageViewer {
  /**
   * The first 32 hex characters of sha256(`<tenant>:<user id>`): the same
   * person on every visit to this deployment, and nothing that leads back to
   * the account without the database (`findViewer`).
   */
  id: string;
  staff: boolean;
  role: Role;
  /** The address, for staff only: a customer's is never sent. */
  email?: string;
  /** The month the account was made (`2026-11`), or null when unknown. */
  created: string | null;
  /** Whether an authenticator is set up, or null when unknown. */
  twoFactor: boolean | null;
  /** How this session signed in, or null when unknown. */
  signIn: UsageSignIn | null;
}

/** What `viewerOf` reads: the gate's `authUser`, whose row and session are there on a live request. */
export interface UsageUser {
  id: string;
  email: string;
  role: Role;
  user?: { createdAt: Date; totpEnrolledAt: Date | null };
  session?: { authMethod: string };
}

export const usageId = (tenant: string, userId: string): string =>
  createHash("sha256").update(`${tenant}:${userId}`).digest("hex").slice(0, 32);

const domainOf = (email: string) => email.split("@").pop()?.toLowerCase() ?? "";

function signInOf(method: string | undefined): UsageSignIn | null {
  if (method === undefined) return null;
  const first = method.split("+")[0] as UsageSignIn;
  return (USAGE_SIGN_INS as readonly string[]).includes(first) ? first : "other";
}

/** Null without a signed-in user. */
export function viewerOf(user: UsageUser | null | undefined, s: UsageSettings): UsageViewer | null {
  if (!user) return null;
  const staff = s.staffDomains.includes(domainOf(user.email));
  return {
    id: usageId(s.tenant, user.id),
    staff,
    role: user.role,
    ...(staff ? { email: user.email.toLowerCase() } : {}),
    created: user.user ? user.user.createdAt.toISOString().slice(0, 7) : null,
    twoFactor: user.user ? user.user.totpEnrolledAt !== null : null,
    signIn: signInOf(user.session?.authMethod),
  };
}

/** A member as the usage-id look-up names them. */
export interface UsageMember {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  status: string;
}

/**
 * The member of this deployment a usage id belongs to, removed members
 * included, or null. Every account is hashed: a deployment's team is a
 * handful of rows, and the id is not stored anywhere.
 */
export async function findViewer(db: Database, tenant: string, id: string): Promise<UsageMember | null> {
  const rows = await db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role, status: users.status })
    .from(users);
  return rows.find((row) => usageId(tenant, row.id) === id) ?? null;
}
