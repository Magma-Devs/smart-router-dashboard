/**
 * Who a browser's usage data says it is (MAG-5373). The web starts Mixpanel's
 * browser SDK with what `GET /api/usage/config` answers; this decides the
 * signed-in user's part of that answer: an opaque id, and whether they are
 * our own staff, with their role. Never the address or the account id.
 */
import { createHash } from "node:crypto";
import type { Role } from "@sr/shared";
import type { UsageSettings } from "../config.js";

/** The signed-in user as usage data names them. */
export interface UsageViewer {
  /**
   * The first 32 hex characters of sha256(`<tenant>:<user id>`): the same
   * person on every visit to this deployment, and nothing that leads back to
   * the account without the database.
   */
  id: string;
  staff: boolean;
  role: Role;
}

/** Null without a signed-in user. */
export function viewerOf(user: { id: string; email: string; role: Role } | null | undefined, s: UsageSettings): UsageViewer | null {
  if (!user) return null;
  const domain = user.email.split("@").pop()?.toLowerCase() ?? "";
  return {
    id: createHash("sha256").update(`${s.tenant}:${user.id}`).digest("hex").slice(0, 32),
    staff: s.staffDomains.includes(domain),
    role: user.role,
  };
}
