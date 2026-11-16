"use client";

import type { CSSProperties } from "react";
import { ROLES, ROLE_COLORS, ROLE_DESCRIPTIONS, ROLE_LABELS, type Role } from "@sr/shared";
import { INVITE_STATE_LABELS, type InviteState } from "./team-state";

/**
 * A role's chip colours, from its one colour in `ROLE_COLORS`. The text mixes
 * the colour with the theme's text colour, so it darkens on the light theme
 * and lightens on the dark one, and stays readable on its tint in both. A
 * role this build does not know gets the plain grey chip.
 */
export function roleChipStyle(role: Role): CSSProperties {
  const colour = (ROLE_COLORS as Partial<Record<string, string>>)[role];
  if (!colour) return {};
  return {
    color: `color-mix(in srgb, ${colour} 62%, var(--text))`,
    background: `color-mix(in srgb, ${colour} 14%, transparent)`,
  };
}

/** The role chip, the same on the Team page, in both role dialogs and on the
 *  join page. */
export function RoleBadge({ role }: { role: Role }) {
  return (
    <span className="gw-tag" style={roleChipStyle(role)}>
      {ROLE_LABELS[role] ?? role}
    </span>
  );
}

const STATE_DOT: Record<InviteState, string> = {
  pending: "var(--info)",
  expired: "var(--text-4)",
  revoked: "var(--text-4)",
};

/** An invitation's state: outlined with a dot, so it never reads as a role. */
export function InviteStateChip({ state }: { state: InviteState }) {
  return (
    <span
      className="gw-tag"
      style={{
        background: "transparent",
        border: "1px solid var(--line-2)",
        color: "var(--text-2)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: STATE_DOT[state] ?? "var(--text-4)",
        }}
      />
      {INVITE_STATE_LABELS[state] ?? state}
    </span>
  );
}

/** The role choice in the invite and change-role dialogs: each role's chip
 *  and what it can do. */
export function RolePicker({
  value,
  onChange,
  gap = 8,
}: {
  value: Role;
  onChange: (role: Role) => void;
  gap?: number;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap }}>
      {ROLES.map((r) => (
        <button
          key={r}
          type="button"
          aria-pressed={value === r}
          onClick={() => onChange(r)}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 10,
            padding: "10px 12px",
            borderRadius: 8,
            border: "1px solid " + (value === r ? "var(--brand)" : "var(--line)"),
            background: value === r ? "rgba(255,57,0,0.04)" : "var(--surface)",
            cursor: "pointer",
            textAlign: "left",
            fontFamily: "inherit",
            color: "var(--text)",
          }}
        >
          <div
            style={{
              width: 14,
              height: 14,
              borderRadius: "50%",
              flexShrink: 0,
              marginTop: 2,
              border: "2px solid " + (value === r ? "var(--brand)" : "var(--line-2)"),
              background: value === r ? "var(--brand)" : "transparent",
            }}
          />
          <div>
            <RoleBadge role={r} />
            <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 4 }}>
              {ROLE_DESCRIPTIONS[r]}
            </div>
          </div>
        </button>
      ))}
    </div>
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
