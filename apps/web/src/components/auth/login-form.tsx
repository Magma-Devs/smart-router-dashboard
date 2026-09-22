"use client";

import { useState, type FormEvent } from "react";
import { signIn } from "next-auth/react";
import { enabledProviders, type ProviderFlags } from "./oauth-providers";


/**
 * Sign-in form: email + password against the api (via Auth.js
 * Credentials), plus one badge per configured OAuth provider.
 */
export function LoginForm({ providers }: { providers: ProviderFlags }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const providerBadges = enabledProviders(providers);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // redirect:false so a bad password stays on the page with an inline
    // error instead of bouncing through /login?error=…
    const res = await signIn("credentials", { email, password, redirect: false });
    if (res?.error) {
      setError("Invalid email or password.");
      setBusy(false);
      return;
    }
    window.location.href = "/overview";
  }

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
        padding: 24,
      }}
    >
      <div className="gw-card" style={{ width: "100%", maxWidth: 380, padding: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/magma-logo.png" width={32} height={32} alt="Magma" style={{ objectFit: "contain" }} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Smart Router Dashboard</div>
            <div style={{ fontSize: 12, color: "var(--text-3)" }}>Sign in to continue</div>
          </div>
        </div>

        <form onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
          <label style={{ display: "grid", gap: 6, fontSize: 12, color: "var(--text-2)" }}>
            Email
            <input
              className="gw-input"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 12, color: "var(--text-2)" }}>
            Password
            <input
              className="gw-input"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </label>

          {error && (
            <div role="alert" style={{ fontSize: 12, color: "var(--danger, #f43)", marginTop: -4 }}>
              {error}
            </div>
          )}

          <button className="gw-btn gw-btn--primary" type="submit" disabled={busy} style={{ marginTop: 4 }}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        {providerBadges.length > 0 && (
          <>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                margin: "20px 0",
                color: "var(--text-3)",
                fontSize: 11,
              }}
            >
              <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
              or continue with
              <span style={{ flex: 1, height: 1, background: "var(--line)" }} />
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {providerBadges.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="gw-btn gw-btn--ghost"
                  style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}
                  onClick={() => void signIn(p.id, { redirectTo: "/overview" })}
                >
                  {p.icon}
                  Continue with {p.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
