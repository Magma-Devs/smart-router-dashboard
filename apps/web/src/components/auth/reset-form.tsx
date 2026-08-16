"use client";

import { useState, type FormEvent } from "react";
import { apiUrl } from "@/lib/api-client";

/**
 * Setting a new password from a reset link.
 *
 * On success this sends the person to `/login` rather than into the dashboard.
 * A reset link that signs you in is a reset link worth stealing — and proving
 * the new password works by using it is the point of the exercise.
 */
export function ResetForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

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
      const res = await fetch(`${base}/auth/password/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? "That didn't work. Please try again.");
        setBusy(false);
        return;
      }
      setDone(true);
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
      <div className="gw-card" style={{ width: "100%", maxWidth: 400, padding: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/magma-logo.png" width={32} height={32} alt="Magma" style={{ objectFit: "contain" }} />
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Choose a new password</div>
            <div style={{ fontSize: 12, color: "var(--text-3)" }}>Smart Router Dashboard</div>
          </div>
        </div>

        {done ? (
          <>
            <p style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.6, margin: "0 0 8px" }}>
              Your password has been changed.
            </p>
            <p style={{ fontSize: 12.5, color: "var(--text-3)", lineHeight: 1.6, margin: "0 0 20px" }}>
              Every device that was signed in to this account has been signed out, including any
              you don&apos;t recognise.
            </p>
            <a className="gw-btn gw-btn--primary" href="/login" style={{ justifyContent: "center", width: "100%" }}>
              Sign in
            </a>
          </>
        ) : (
          <form onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
            <label style={labelStyle}>
              New password
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
              Setting this signs out every device on the account. Any characters, 8 to 64, checked
              against known breached passwords.
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
              {busy ? "Saving…" : "Set new password"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
