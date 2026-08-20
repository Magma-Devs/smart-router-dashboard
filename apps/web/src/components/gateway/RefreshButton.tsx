"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";

/* RefreshButton — re-fetch every panel on the page NOW, without waiting out
 * the SWR poll interval (15s by default, and heavy PromQL reads can make a
 * stale view linger longer). One shared control so every page offers the
 * same affordance in its header row, next to the window selector.
 *
 * It broadcasts a revalidation to every mounted SWR key rather than tracking
 * what the page fetches — the page IS its mounted hooks, so that set is
 * exactly "everything visible". */
export function RefreshButton() {
  const { mutate } = useSWRConfig();
  const [busy, setBusy] = useState(false);

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
  );
}
