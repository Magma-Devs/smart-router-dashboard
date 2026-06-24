"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function AccountPage() {
  const router = useRouter();
  const [version, setVersion] = useState<string | null>(null);

  async function signOut() {
    localStorage.removeItem("sr:token");
    router.replace("/login");
  }

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
      <p className="lede">Session and build information.</p>

      <div className="gw-grid" style={{ gridTemplateColumns: "1fr 1fr", maxWidth: 720 }}>
        <div className="gw-card">
          <p className="gw-card__title">Session</p>
          <button className="gw-btn" onClick={signOut} style={{ marginTop: 8 }}>
            Sign out
          </button>
        </div>
        <div className="gw-card">
          <p className="gw-card__title">Build</p>
          <div className="mono" style={{ fontSize: 13 }}>{version ?? "…"}</div>
        </div>
      </div>
    </div>
  );
}
