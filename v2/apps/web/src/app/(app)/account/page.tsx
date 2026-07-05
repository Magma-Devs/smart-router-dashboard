"use client";

import { useState } from "react";

export default function AccountPage() {
  const [version, setVersion] = useState<string | null>(null);

  // Lazy-load build provenance from the api /version endpoint.
  if (version === null && typeof window !== "undefined") {
    fetch(`${process.env.NEXT_PUBLIC_API_URL ?? ""}/version`)
      .then((r) => r.json())
      .then((v: { version?: string; commit?: string }) =>
        setVersion(`${v.version ?? "?"} (${v.commit ?? "?"})`),
      )
      .catch(() => setVersion("unknown"));
  }

  return (
    <div className="gw-page">
      <h1>Account</h1>
      <p className="lede">Build information for this deployment.</p>

      <div className="gw-grid" style={{ gridTemplateColumns: "1fr 1fr", maxWidth: 720 }}>
        <div className="gw-card">
          <p className="gw-card__title">Build</p>
          <div className="mono" style={{ fontSize: 13 }}>{version ?? "…"}</div>
        </div>
      </div>
    </div>
  );
}
