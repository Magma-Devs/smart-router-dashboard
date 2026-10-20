"use client";

import { useEffect, useState } from "react";

/* The Grafana that hosts the logs board, for "View full logs" and each log
   row's "Logs" link. Resolved at runtime from /api/config (which reads
   DASHBOARD_GRAFANA_URL from the container env), so one published web image
   can point at any Grafana. Falls back to the build-time
   NEXT_PUBLIC_GRAFANA_URL; null when neither names one, and the links are
   hidden. Asked once per session; a failed ask is asked again next time. */
const BUILD_GRAFANA_URL = process.env.NEXT_PUBLIC_GRAFANA_URL || null;

let asked: Promise<string | null> | null = null;

function runtimeGrafanaUrl(): Promise<string | null> {
  if (!asked) {
    asked = fetch("/api/config")
      .then((r) => r.json())
      .then((c: { grafanaUrl?: unknown }) => (typeof c?.grafanaUrl === "string" && c.grafanaUrl ? c.grafanaUrl : null))
      .catch(() => {
        asked = null;
        return null;
      });
  }
  return asked;
}

export function useGrafanaUrl(): string | null {
  const [url, setUrl] = useState<string | null>(BUILD_GRAFANA_URL);
  useEffect(() => {
    let alive = true;
    void runtimeGrafanaUrl().then((u) => {
      if (alive && u) setUrl(u);
    });
    return () => {
      alive = false;
    };
  }, []);
  return url;
}
