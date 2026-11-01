"use client";

import { useState, useSyncExternalStore, type CSSProperties } from "react";
import { useSWRConfig } from "swr";
import { getIdlePhase, subscribeIdle } from "@/lib/idle-store";

const PAUSED_SAYS = "Polling paused after an hour without activity · move the mouse to resume";
const PILL_H = 28;

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
 * While the idle gate has polling paused (an hour with nobody at the page,
 * lib/idle-store.ts), the icon turns amber and a "Paused" pill sits beside
 * it wherever the header has room for all of it: a screen someone only looks
 * at must not pass the last numbers off as live. */
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
    // One item in the header whatever the state, so the row gains no gap. It
    // takes the row's free space before anything else does, up to the pill,
    // and never more than the space it finds: the pill's track starts at 0.
    <span style={{
      display: "inline-grid", gridTemplateColumns: "minmax(0, max-content) auto", alignItems: "center",
      flex: "1000 1 0%", minWidth: "min-content", maxWidth: "max-content",
    }}>
      {/* The pill shows whole or not at all: after the zero-width first item,
          a pill that doesn't fit wraps to a line the slot doesn't show. */}
      <span role="status" style={{
        minWidth: 0, height: paused ? PILL_H : undefined, overflow: "hidden",
        display: "flex", flexWrap: "wrap", justifyContent: "flex-end", alignContent: "flex-start",
      }}>
        {paused && <><span style={{ width: 0, height: PILL_H }} /><PausedPill /></>}
      </span>
      <button
        type="button"
        className="gw-btn gw-btn--ghost"
        onClick={refresh}
        disabled={busy}
        aria-label="Refresh data"
        title="Re-fetch everything on this page"
        style={{ padding: "5px 8px", display: "inline-flex", alignItems: "center", cursor: busy ? "default" : "pointer", color: paused ? "var(--warn)" : undefined }}
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
    </span>
  );
}

const VISUALLY_HIDDEN: CSSProperties = {
  position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap",
};

/**
 * The topbar's pill shape, one word long so it fits most headers; the whole
 * sentence is its tooltip and what a screen reader says. Hovering it resumes
 * polling, so the words on the pill are what a person reads.
 */
function PausedPill() {
  return (
    <span
      title={PAUSED_SAYS}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, flex: "none", height: PILL_H,
        marginRight: 8, padding: "0 10px", border: "1px solid var(--line-2)", borderRadius: 999,
        fontSize: 12, lineHeight: "16px", color: "var(--text-2)", whiteSpace: "nowrap",
      }}
    >
      <span className="dot dot--warn" />
      <span aria-hidden="true">Paused</span>
      <span style={VISUALLY_HIDDEN}>{PAUSED_SAYS}</span>
    </span>
  );
}
