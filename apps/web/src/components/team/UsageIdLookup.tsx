"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { Role } from "@sr/shared";
import { useApi } from "@/hooks/use-api";
import { RoleBadge } from "./bits";

/** What `GET /api/usage/viewers/:id` answers. */
interface ViewerLookup {
  member: { id: string; email: string; name: string | null; role: Role; status: string } | null;
}

/** A usage id as Mixpanel shows it: its distinct id, 32 hex characters. */
export const usageIdOf = (raw: string | null): string | null => {
  const id = raw?.trim().toLowerCase() ?? "";
  return /^[0-9a-f]{32}$/.test(id) ? id : null;
};

/**
 * `/team?usage=<id>`, for an admin: which member a usage id (Mixpanel's
 * distinct id for a person) belongs to. Usage data names people by that id
 * only; this page is where it becomes a person again, for those who already
 * see every member here.
 */
export function UsageIdLookup({ isAdmin }: { isAdmin: boolean }) {
  const raw = useSearchParams().get("usage");
  const id = usageIdOf(raw);
  const found = useApi<ViewerLookup>(isAdmin && id ? `/api/usage/viewers/${id}` : null, 0);
  if (raw === null || !isAdmin) return null;
  let body: React.ReactNode;
  if (!id) body = <>“{raw.slice(0, 40)}” is not a usage id: one is 32 letters and digits, as Mixpanel shows it.</>;
  else if (found.error) body = <>Could not look up usage id <code>{id}</code>.</>;
  else if (!found.data) body = <>Looking up usage id <code>{id}</code>…</>;
  else if (!found.data.member) body = <>No member of this deployment has usage id <code>{id}</code>.</>;
  else {
    const m = found.data.member;
    body = (
      <>
        Usage id <code>{id}</code> is <strong>{m.name || m.email}</strong>
        {m.name ? <> ({m.email})</> : null} <RoleBadge role={m.role} />
        {m.status !== "active" ? <> · {m.status}</> : null}
      </>
    );
  }
  return (
    <div
      role="status"
      style={{
        display: "flex",
        gap: 10,
        alignItems: "center",
        justifyContent: "space-between",
        background: "color-mix(in srgb, var(--info) 6%, transparent)",
        border: "1px solid color-mix(in srgb, var(--info) 30%, transparent)",
        borderRadius: 8,
        padding: "10px 12px",
        marginBottom: 16,
        fontSize: 12.5,
      }}
    >
      <span>{body}</span>
      <Link href="/team" className="gw-btn gw-btn--ghost" style={{ padding: "2px 8px", fontSize: 11 }}>
        Close
      </Link>
    </div>
  );
}
