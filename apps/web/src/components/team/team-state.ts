import type { KeyedMutator } from "swr";
import type { Role } from "@sr/shared";

/* The Team page's logic that holds no React: what a row says, which actions it
 * offers, which invitations show, and how a confirmed change reaches the list. */

export interface Member {
  id: string;
  name: string | null;
  email: string;
  role: Role;
  twoFactorEnabled: boolean;
  lastActiveAt: string | null;
  joinedAt: string;
  isMagmaAccount: boolean;
}

export interface MembersResponse {
  members: Member[];
  adminCount: number;
  soleAdmin: boolean;
}

export type InviteState = "pending" | "expired" | "revoked";

export interface Invite {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
  resendCount: number;
  state: InviteState;
}

export interface InvitesResponse {
  invites: Invite[];
}

// ── Members ──────────────────────────────────────────────────────────────────

/**
 * The list with one member's row changed, and the admin count recomputed from
 * it. The list holds every active member, the same rows the api counts, so the
 * sole-admin prompt follows a demotion without waiting for the next read.
 */
export function withMemberChanged(
  data: MembersResponse | undefined,
  id: string,
  change: Partial<Pick<Member, "role" | "twoFactorEnabled">>,
): MembersResponse | undefined {
  if (!data) return data;
  return recount(data.members.map((m) => (m.id === id ? { ...m, ...change } : m)));
}

export function withMemberRemoved(
  data: MembersResponse | undefined,
  id: string,
): MembersResponse | undefined {
  if (!data) return data;
  return recount(data.members.filter((m) => m.id !== id));
}

function recount(members: Member[]): MembersResponse {
  const adminCount = members.filter((m) => m.role === "admin").length;
  return { members, adminCount, soleAdmin: adminCount === 1 };
}

/**
 * What a member action does to the list once the api has confirmed it: the
 * row changes at once, from the api's answer, and the list is then read again.
 * A write into SWR's cache is not a revalidation, so it lands even while the
 * idle gate has polling paused.
 */
export function memberListUpdates(mutate: KeyedMutator<MembersResponse>) {
  const apply = (update: (d: MembersResponse | undefined) => MembersResponse | undefined) =>
    void mutate(update, { revalidate: true });
  return {
    roleChanged: (id: string, role: Role) => apply((d) => withMemberChanged(d, id, { role })),
    twoFactorReset: (id: string) =>
      apply((d) => withMemberChanged(d, id, { twoFactorEnabled: false })),
    removed: (id: string) => apply((d) => withMemberRemoved(d, id)),
  };
}

/** The 2FA cell: "Yes", or "Not set up" with what that means for them. */
export function twoFactorCell(
  enabled: boolean,
  /** The signed-in admin's own grace, when this row is theirs and they have one. */
  ownGraceDaysLeft: number | null,
): { label: string; tip: string | null; tone: "plain" | "attention" } {
  if (enabled) return { label: "Yes", tip: null, tone: "plain" };
  // Only the first admin has a grace period, and nobody joins while it runs
  // (inviting needs 2FA), so the one row it applies to is the reader's own.
  if (ownGraceDaysLeft !== null) {
    const days = ownGraceDaysLeft === 1 ? "1 more day" : `${ownGraceDaysLeft} more days`;
    return {
      label: "Not set up",
      tip: `You can use the dashboard for ${days}. Set it up on your Account page.`,
      tone: "attention",
    };
  }
  return {
    label: "Not set up",
    tip: "Can't use the dashboard until they set it up",
    tone: "attention",
  };
}

// ── Row actions ──────────────────────────────────────────────────────────────

export interface RowAction {
  label: string;
  onSelect: () => void;
  /** Drawn in the error colour: it takes something away. */
  danger?: boolean;
  disabled?: boolean;
  /** Why it does what it does, or why it is disabled. */
  hint?: string;
}

/**
 * Every row offers the same four, in the same order, whatever the member's 2FA
 * says: Reset 2FA is disabled rather than missing for someone with nothing to
 * clear, so nothing on the row moves between members.
 */
export function memberActions(
  member: Pick<Member, "twoFactorEnabled">,
  on: {
    changeRole: () => void;
    resetLink: () => void;
    resetTwoFactor: () => void;
    remove: () => void;
  },
): RowAction[] {
  return [
    { label: "Change role", onSelect: on.changeRole },
    {
      label: "Reset link",
      onSelect: on.resetLink,
      hint: "Generate a single-use password-reset link to hand over",
    },
    {
      label: "Reset 2FA",
      onSelect: on.resetTwoFactor,
      disabled: !member.twoFactorEnabled,
      hint: member.twoFactorEnabled
        ? "Clear their authenticator, for a lost phone"
        : "They have not set up 2FA, so there is nothing to reset",
    },
    { label: "Remove", onSelect: on.remove, danger: true },
  ];
}

/** A revoked invitation offers nothing; a pending or an expired one can be
 *  sent again (a new link, a new expiry) or revoked. */
export function inviteActions(
  invite: Pick<Invite, "state">,
  on: { resend: () => void; revoke: () => void },
): RowAction[] {
  if (invite.state === "revoked") return [];
  return [
    {
      label: "Resend",
      onSelect: on.resend,
      hint: "Send a new link. The previous one stops working.",
    },
    { label: "Revoke", onSelect: on.revoke, danger: true },
  ];
}

// ── Invitations ──────────────────────────────────────────────────────────────

export const INVITE_STATE_LABELS: Record<InviteState, string> = {
  pending: "Pending",
  expired: "Expired",
  revoked: "Revoked",
};

/** The Invites tab's count: invitations someone can still accept. */
export function pendingCount(invites: readonly Pick<Invite, "state">[]): number {
  return invites.filter((i) => i.state === "pending").length;
}

/** Revoked and expired invitations, which stay out of the list until asked for. */
export function closedCount(invites: readonly Pick<Invite, "state">[]): number {
  return invites.length - pendingCount(invites);
}

export function visibleInvites<T extends Pick<Invite, "state">>(
  invites: readonly T[],
  showClosed: boolean,
): T[] {
  return showClosed ? [...invites] : invites.filter((i) => i.state === "pending");
}

// ── Menu keys ────────────────────────────────────────────────────────────────

/**
 * Where a key moves focus in an open menu of `count` items, from `current`
 * (-1: nothing focused yet). Arrows wrap, Home and End jump; null for any
 * other key. Disabled items stay focusable, as the ARIA menu pattern asks, so
 * a keyboard user can find them and read why.
 */
export function menuFocusAfter(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
      return current < 0 ? 0 : (current + 1) % count;
    case "ArrowUp":
      return current < 0 ? count - 1 : (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
