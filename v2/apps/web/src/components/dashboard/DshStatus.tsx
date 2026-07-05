"use client";

/* DshStatus — live status badge, ported 1:1 from the design prototype's
   DSHStatus (SR_Dashboard/magma/page-dashboard.jsx ~611-638). Fetches the
   public statuspage summary; renders "–" when unreachable. */

import { useEffect, useState } from "react";

interface StatusState {
  state: "loading" | "ok" | "degraded" | "outage" | "unknown";
  label?: string;
}

export function DshStatus() {
  const [st, setSt] = useState<StatusState>({ state: "loading" });
  useEffect(() => {
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    fetch("https://status.magmadevs.com/api/v2/status.json", ctrl ? { signal: ctrl.signal } : {})
      .then((r) => r.json())
      .then((d: { status?: { indicator?: string } }) => {
        const ind = d && d.status && d.status.indicator;
        if (ind === "none") setSt({ state: "ok", label: "Operational" });
        else if (ind === "minor") setSt({ state: "degraded", label: "Degraded" });
        else if (ind === "major" || ind === "critical") setSt({ state: "outage", label: "Outage" });
        else setSt({ state: "unknown" });
      })
      .catch(() => setSt({ state: "unknown" }));
    return () => { if (ctrl) ctrl.abort(); };
  }, []);
  const dotColor = st.state === "ok" ? "var(--ok)" : st.state === "degraded" ? "var(--warn)" : st.state === "outage" ? "var(--err)" : "var(--text-4)";
  return (
    <a href="https://status.magmadevs.com" target="_blank" rel="noreferrer"
      title={st.state === "unknown" ? "Status unavailable" : undefined}
      style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-3)", textDecoration: "none", flexShrink: 0 }}>
      {st.state === "unknown"
        ? <span style={{ fontSize: 13, color: "var(--text-4)", lineHeight: 1 }}>–</span>
        : <span style={{ width: 6, height: 6, borderRadius: "50%", background: dotColor, flexShrink: 0 }} />}
      Smart Router · {st.state === "loading" ? "…" : st.state === "unknown" ? "–" : st.label}
    </a>
  );
}
