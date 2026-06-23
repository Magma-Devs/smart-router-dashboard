"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiPost } from "@/lib/api-client";
import { MagmaLogo } from "@/components/gateway/icons";

interface LoginResponse {
  user: { username: string };
  token: string;
}

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiPost<LoginResponse>("/api/auth/login", { username, password });
      localStorage.setItem("sr:token", res.token);
      localStorage.setItem("sr:authEnabled", "true");
      router.replace("/overview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gw-login">
      <form className="gw-login__card" onSubmit={submit}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 24 }}>
          <MagmaLogo size={32} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Smart Router</div>
            <div className="sub" style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--text-3)" }}>
              by Magma Devs
            </div>
          </div>
        </div>
        <h1 style={{ fontSize: 18, margin: "0 0 4px" }}>Sign in</h1>
        <p className="muted" style={{ fontSize: 13, margin: "0 0 20px" }}>
          Access the Smart Router dashboard.
        </p>

        <label className="gw-label" htmlFor="u">Username</label>
        <input id="u" className="gw-input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />

        <div style={{ height: 14 }} />
        <label className="gw-label" htmlFor="p">Password</label>
        <input id="p" className="gw-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />

        {error && <div className="tag tag--err" style={{ marginTop: 14 }}>{error}</div>}

        <button className="gw-btn gw-btn--primary" type="submit" disabled={busy} style={{ width: "100%", justifyContent: "center", marginTop: 22 }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
