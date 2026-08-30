"use client";

import { useState, type FormEvent } from "react";
import { signIn } from "next-auth/react";

/**
 * Sign-in form: email and password against the api, via Auth.js Credentials.
 *
 * There is deliberately nothing else on it. Social sign-in buttons lived here
 * until the ticket's reasoning was applied — a personal Google/GitHub/Discord
 * account is outside the customer's IT control and survives the person leaving
 * the company. SSO comes as its own task.
 */
export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
          <img
            src="/magma-logo.png"
            width={32}
            height={32}
            alt="Magma"
            style={{ objectFit: "contain" }}
          />
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

          <button
            className="gw-btn gw-btn--primary"
            type="submit"
            disabled={busy}
            style={{ marginTop: 4 }}
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
          {/* Managed sends a link; on-prem's api answers 404 and the page says
              to ask an administrator. Shown in both shapes rather than hidden
              on-prem — somebody who cannot sign in needs a next step, and a
              missing link is not one. */}
          <a
            href="/forgot-password"
            style={{
              fontSize: 12,
              color: "var(--text-3)",
              textAlign: "center",
              textDecoration: "none",
              marginTop: 2,
            }}
          >
            Forgot your password?
          </a>
        </form>
      </div>
    </main>
  );
}
