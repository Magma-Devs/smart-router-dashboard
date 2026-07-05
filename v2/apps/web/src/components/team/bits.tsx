"use client";

/* Ported verbatim from the design prototype (page-team.jsx —
   ROLE_LABELS / ROLE_COLOR / RoleBadge / InitialsAvatar). */

export type TeamRole = "owner" | "admin" | "member";

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: TeamRole;
  self?: boolean;
}

export const ROLE_LABELS: Record<TeamRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };
export const ROLE_COLOR: Record<TeamRole, string> = { owner: "brand", admin: "info", member: "" };

export function RoleBadge({ role }: { role: TeamRole }) {
  return <span className={"gw-tag gw-tag--" + (ROLE_COLOR[role] || "")}>{ROLE_LABELS[role] || role}</span>;
}

export function InitialsAvatar({ name, size = 30 }: { name: string; size?: number }) {
  const initials = (name || "?").split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
  const hue = name ? (name.charCodeAt(0) * 37 + name.charCodeAt(1 % name.length) * 13) % 360 : 200;
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", flexShrink: 0,
      background: `oklch(0.5 0.18 ${hue})`, color: "#fff",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: Math.round(size * 0.37), fontWeight: 700, letterSpacing: "-0.01em",
    }}>{initials}</div>
  );
}
