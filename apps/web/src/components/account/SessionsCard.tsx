"use client";

import useSWR from "swr";
import { useState } from "react";
import { apiGet, apiSend } from "@/lib/api-client";
import { relativeTime } from "@/components/team/bits";

interface SessionsResponse {
  sessions: Array<{
    id: string;
    client: string | null;
    ip: string | null;
    authMethod: string;
    createdAt: string;
    lastSeenAt: string;
    current: boolean;
  }>;
}

/** Where you are signed in, and the ability to cut any of it off. This is the
 *  screen that makes "I think someone else is in my account" actionable. */
export function SessionsCard() {
  const { data, mutate } = useSWR<SessionsResponse>("/api/account/sessions", apiGet, {
    refreshInterval: 30000,
  });
  const [busy, setBusy] = useState<string | null>(null);

  async function revoke(id: string) {
    setBusy(id);
    try {
      await apiSend("DELETE", `/api/account/sessions/${id}`);
      await mutate();
    } finally {
      setBusy(null);
    }
  }

  async function revokeAll() {
    setBusy("all");
    try {
      await apiSend("DELETE", "/api/account/sessions");
      // This signs out the tab we're in too, deliberately.
      window.location.href = "/login";
    } finally {
      setBusy(null);
    }
  }

  const sessions = data?.sessions ?? [];

  return (
    <div className="gw-card" style={{ marginBottom: 14 }}>
      <div className="gw-row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Active sessions</div>
        {sessions.length > 1 && (
          <button
            className="gw-btn"
            style={{ fontSize: 11, padding: "4px 9px" }}
            disabled={busy === "all"}
            onClick={() => void revokeAll()}
          >
            Sign out everywhere
          </button>
        )}
      </div>
      <div style={{ display: "grid", gap: 7 }}>
        {sessions.map((s) => (
          <div
            key={s.id}
            className="gw-row"
            style={{
              padding: "10px 11px",
              borderRadius: 7,
              background: "var(--bg)",
              border: "1px solid " + (s.current ? "var(--brand)" : "var(--line)"),
              gap: 10,
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>
                {s.client ?? "Unrecognised device"}
                {s.current && (
                  <span style={{ color: "var(--brand)", fontWeight: 600 }}> · this device</span>
                )}
              </div>
              <div
                className="gw-mono"
                style={{ fontSize: 11, color: "var(--text-3)", marginTop: 2 }}
              >
                {s.ip ?? "—"} · signed in {relativeTime(s.createdAt)} · seen{" "}
                {relativeTime(s.lastSeenAt)}
              </div>
            </div>
            {!s.current && (
              <button
                className="gw-btn"
                style={{ fontSize: 11, padding: "4px 9px" }}
                disabled={busy === s.id}
                onClick={() => void revoke(s.id)}
              >
                Sign out
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
