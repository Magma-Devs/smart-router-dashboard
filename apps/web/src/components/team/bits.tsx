"use client";

import { ROLE_LABELS, type Role } from "@sr/shared";

/** Colour by privilege, so the eye finds the admins first. */
const ROLE_COLOR: Record<Role, string> = {
  admin: "brand",
  approver: "info",
  requester: "",
  read_only: "",
};

export function RoleBadge({ role }: { role: Role }) {
  return (
    <span className={"gw-tag gw-tag--" + (ROLE_COLOR[role] || "")}>
      {ROLE_LABELS[role] ?? role}
    </span>
  );
}

/**
 * The Magma Devs account on a managed deployment — ours, not one of the
 * customer's people.
 *
 * Brand colour on purpose: it is the one tag in the palette that means "us",
 * and the requirement is visibility, not subtlety. An admin account sitting
 * unlabelled among the customer's own team is a hidden account, which is the
 * thing MAG-2729 forbids.
 *
 * It is a label and nothing more. The row keeps every ordinary control,
 * Remove included, and no list or export filters on it.
 */
export function MagmaAccountTag() {
  return (
    <span
      className="gw-tag gw-tag--brand"
      style={{ marginLeft: 6, verticalAlign: "middle", fontWeight: 500 }}
      title="Operated by Magma Devs, not a member of your team. It can be removed like any other member."
    >
      Magma Devs
    </span>
  );
}

export function InitialsAvatar({ name, size = 30 }: { name: string; size?: number }) {
  const initials = (name || "?")
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const hue = name ? (name.charCodeAt(0) * 37 + name.charCodeAt(1 % name.length) * 13) % 360 : 200;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        flexShrink: 0,
        background: `oklch(0.5 0.18 ${hue})`,
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: Math.round(size * 0.37),
        fontWeight: 700,
        letterSpacing: "-0.01em",
      }}
    >
      {initials}
    </div>
  );
}

/** "3 days ago", or an em dash for someone who has never signed in. Relative
 *  beats a timestamp here: the question is "is this person still around", and
 *  nobody reads an ISO date to answer it. */
export function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
