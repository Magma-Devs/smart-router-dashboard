/**
 * The dashboard's four roles, in ascending order of privilege.
 *
 * They are **cumulative** — each includes everything below it — so authorisation
 * is an ordinal comparison rather than a permission matrix:
 *
 * | | See dashboard and audit | Propose changes | Approve others' | Manage people | Self-approve |
 * |---|---|---|---|---|---|
 * | `read_only` | yes | no  | no  | no  | no  |
 * | `requester` | yes | yes | no  | no  | no  |
 * | `approver`  | yes | yes | yes | no  | no  |
 * | `admin`     | yes | yes | yes | yes | yes |
 *
 * This module is the single source of the ordering. The api gates on it
 * (`requireRole`) and the web uses it to decide which controls to render — and
 * the whole point of them sharing one implementation is that they can't drift
 * into disagreeing about who may do what.
 *
 * **The web's use is cosmetic.** Hiding a button is not a permission check; the
 * api re-reads the live role on every mutation regardless.
 *
 * See `docs/ACCOUNTS-DESIGN.md` §3.
 */
export const ROLES = ["read_only", "requester", "approver", "admin"] as const;

export type Role = (typeof ROLES)[number];

/** Ordinal per role — index into `ROLES`. Higher is more privileged. */
const RANK: Record<Role, number> = {
  read_only: 0,
  requester: 1,
  approver: 2,
  admin: 3,
};

/** Human labels for the UI. */
export const ROLE_LABELS: Record<Role, string> = {
  read_only: "Read-only",
  requester: "Requester",
  approver: "Approver",
  admin: "Admin",
};

/** One line each, shown beside the choice in the invite and change-role dialogs. */
export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  read_only: "Can see the dashboard and the audit log. Cannot change anything.",
  requester: "Can propose configuration changes for someone else to approve.",
  approver: "Can approve changes proposed by other people.",
  admin: "Can manage members and roles, and approve their own changes.",
};

/** True when `value` is one of the four roles. */
export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * Does `role` carry at least the privileges of `minimum`?
 *
 * An unrecognised role is **not** privileged. A row written by a future version
 * with a role this build has never heard of gets the least access, never the
 * most — the safe direction when the two ends of a rolling deploy disagree.
 */
export function roleAtLeast(role: unknown, minimum: Role): boolean {
  if (!isRole(role)) return false;
  return RANK[role] >= RANK[minimum];
}

/**
 * Ordinal for sorting a member list by privilege. Unknown roles sort below
 * everything, matching how `roleAtLeast` treats them.
 */
export function roleRank(role: unknown): number {
  return isRole(role) ? RANK[role] : -1;
}
