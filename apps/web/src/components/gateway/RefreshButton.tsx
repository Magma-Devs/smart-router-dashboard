"use client";

import { useState, useSyncExternalStore } from "react";
import { useSWRConfig } from "swr";
import { getIdlePhase, subscribeIdle } from "@/lib/idle-store";

/* RefreshButton — re-fetch every panel on the page NOW, without waiting out
 * the SWR poll interval (15 s to 15 minutes by window, see lib/poll.ts, and
 * heavy PromQL reads can make a stale view linger longer). One shared control
 * so every page offers the same affordance in its header row, next to the
 * window selector.
 *
 * It broadcasts a revalidation to every mounted SWR key rather than tracking
 * what the page fetches — the page IS its mounted hooks, so that set is
 * exactly "everything visible".
 *
 * Beside it, the paused pill: an hour with nobody at the page stops every
 * poll (the idle gate, lib/idle-store.ts), and a screen someone only looks at
 * must not pass the last numbers off as live. */
export function RefreshButton() {
  const { mutate } = useSWRConfig();
  const [busy, setBusy] = useState(false);
  const paused = useSyncExternalStore(subscribeIdle, getIdlePhase, () => "active") === "paused";

  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await mutate(() => true, undefined, { revalidate: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {paused && <PausedPill />}
      <button
        type="button"
        className="gw-btn gw-btn--ghost"
        onClick={refresh}
        disabled={busy}
        aria-label="Refresh data"
        title="Re-fetch everything on this page"
        style={{ padding: "5px 8px", display: "inline-flex", alignItems: "center", cursor: busy ? "default" : "pointer" }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={busy ? { animation: "gw-refresh-spin 0.8s linear infinite" } : undefined}
        >
          {busy && <style>{`@keyframes gw-refresh-spin{to{transform:rotate(360deg)}}`}</style>}
          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
          <path d="M3 21v-5h5" />
        </svg>
      </button>
    </>
  );
}

/**
 * The topbar's pill shape. It takes the row's free space before anything else
 * and gives it up first, so a crowded row cuts its words, never the controls
 * beside it. No tooltip: the pointer that would hover it resumes polling.
 */
function PausedPill() {
  return (
    <span
      role="status"
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, flex: "1000 1 0%", minWidth: 0, maxWidth: "max-content",
        overflow: "hidden", padding: "5px 10px", border: "1px solid var(--line-2)", borderRadius: 999,
        fontSize: 12, lineHeight: "16px", color: "var(--text-2)", whiteSpace: "nowrap",
      }}
    >
      <span className="dot dot--warn" />
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>Polling paused · move the mouse to resume</span>
    </span>
  );
}
