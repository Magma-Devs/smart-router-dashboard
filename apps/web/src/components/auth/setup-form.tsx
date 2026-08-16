"use client";

import { useState, type FormEvent } from "react";
import { signIn } from "next-auth/react";
import { apiUrl } from "@/lib/api-client";

/**
 * First-run: the screen that turns a fresh install into one with a named admin.
 *
 * The setup token is asked for because otherwise whoever reaches this URL first
 * between `helm install` and the operator sitting down becomes the admin — and
 * that gap can be overnight.
 */
export function SetupForm({ mode }: { mode: "managed" | "onprem" }) {
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mismatch = repeat.length > 0 && password !== repeat;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (password !== repeat) {
      setError("Those passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);

    try {
      const base = await apiUrl();
      const res = await fetch(`${base}/auth/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, email, password, name: name || undefined }),
      });

      if (!res.ok) {
        // The api's messages are written to be read by the person in front of
        // the screen — a wrong token, a breached password, an install someone
        // else already claimed — so show them rather than a generic failure.
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? "Setup failed. Please try again.");
        setBusy(false);
        return;
      }

      // The account exists now, so sign in the ordinary way. Deliberately not
      // reusing the session the api just opened: this page has no way to hand
      // it to Auth.js, and one sign-in path is easier to reason about than two.
      const signedIn = await signIn("credentials", { email, password, redirect: false });
      if (signedIn?.error) {
        window.location.href = "/login";
        return;
      }
      window.location.href = "/overview";
    } catch {
      setError("Could not reach the dashboard API.");
      setBusy(false);
    }
  }

  const labelStyle = { display: "grid", gap: 6, fontSize: 12, color: "var(--text-2)" } as const;

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
      <div className="gw-card" style={{ width: "100%", maxWidth: 420, padding: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/magma-logo.png" width={32} height={32} alt="Magma" style={{ objectFit: "contain" }} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Set up this dashboard</div>
            <div style={{ fontSize: 12, color: "var(--text-3)" }}>
              Create the first administrator
            </div>
          </div>
        </div>

        <p style={{ fontSize: 12.5, color: "var(--text-2)", marginTop: 0, marginBottom: 20, lineHeight: 1.6 }}>
          Nothing else opens until this is done. You&apos;ll need the setup token
          {mode === "onprem" ? " printed by the installer" : " we sent you"} — it proves
          you&apos;re the person who installed this, and it&apos;s only needed once.
        </p>

        <form onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
          <label style={labelStyle}>
            Setup token
            <input
              className="gw-input"
              type="password"
              autoComplete="off"
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="From the installer output"
            />
          </label>
          <label style={labelStyle}>
            Your name <span style={{ color: "var(--text-3)" }}>(optional)</span>
            <input
              className="gw-input"
              type="text"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Dana Levi"
            />
          </label>
          <label style={labelStyle}>
            Email
            <input
              className="gw-input"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@yourcompany.com"
            />
          </label>
          <label style={labelStyle}>
            Password
            <input
              className="gw-input"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
            />
          </label>
          <label style={labelStyle}>
            Repeat password
            <input
              className="gw-input"
              type="password"
              autoComplete="new-password"
              required
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              placeholder="••••••••"
              aria-invalid={mismatch}
            />
          </label>

          <p style={{ fontSize: 11.5, color: "var(--text-3)", margin: "2px 0 0", lineHeight: 1.5 }}>
            Any characters, 8 to 64. Checked against known breached passwords — there are no
            other rules, and it never expires.
          </p>

          {(error ?? (mismatch ? "Those passwords don't match." : null)) && (
            <div
              role="alert"
              style={{
                fontSize: 12,
                color: "var(--err)",
                background: "rgba(239,68,68,0.08)",
                border: "1px solid rgba(239,68,68,0.25)",
                borderRadius: 7,
                padding: "8px 10px",
              }}
            >
              {error ?? "Those passwords don't match."}
            </div>
          )}

          <button
            className="gw-btn gw-btn--primary"
            type="submit"
            disabled={busy || mismatch}
            style={{ justifyContent: "center", marginTop: 4 }}
          >
            {busy ? "Creating…" : "Create administrator"}
          </button>
        </form>
      </div>
    </main>
  );
}
