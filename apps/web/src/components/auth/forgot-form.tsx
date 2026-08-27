"use client";

import { useState, type FormEvent } from "react";
import { apiUrl } from "@/lib/api-client";

/**
 * Asking for a password-reset link — the managed half of MAG-2870's reset flow.
 *
 * **It always says the same thing.** Whether the address has an account, has no
 * account, or has one that signs in some other way, the answer is identical:
 * we have sent a link if there is anything to send it to. Telling somebody
 * their address is unknown turns this form into a way to ask who is a member,
 * which is the one question a public page must not answer.
 *
 * That is also why there is no "check your spam folder" flourish, no count of
 * attempts, and no difference in how long it takes to answer.
 */
export function ForgotForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const base = await apiUrl();
      const res = await fetch(`${base}/auth/password/forgot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.status === 404) {
        // On-prem the route does not exist, because there is nowhere to send
        // anything. Say so rather than claiming an email is on its way.
        setError(
          "This deployment has no mail server. Ask an administrator to generate a reset link for you.",
        );
        setBusy(false);
        return;
      }
      if (!res.ok) {
        setError("Could not send that. Please try again.");
        setBusy(false);
        return;
      }
      setSent(true);
    } catch {
      setError("Could not reach the dashboard API.");
      setBusy(false);
    }
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
      <div className="gw-card" style={{ width: "100%", maxWidth: 400, padding: 32 }}>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>
          {sent ? "Check your inbox" : "Reset your password"}
        </div>

        {sent ? (
          <>
            <p style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.6, margin: "0 0 8px" }}>
              If <strong style={{ color: "var(--text)" }}>{email}</strong> has an account, a link is
              on its way. It expires in an hour and works once.
            </p>
            <p
              style={{
                fontSize: 12.5,
                color: "var(--text-3)",
                lineHeight: 1.6,
                margin: "0 0 20px",
              }}
            >
              Nothing has changed yet — your current password still works until you use the link.
            </p>
            <a className="gw-btn" href="/login" style={{ justifyContent: "center", width: "100%" }}>
              Back to sign in
            </a>
          </>
        ) : (
          <form onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
            <p style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.6, margin: "0 0 4px" }}>
              Enter your address and we&apos;ll send you a link to choose a new password.
            </p>
            <label style={{ display: "grid", gap: 6, fontSize: 12, color: "var(--text-2)" }}>
              Email
              <input
                className="gw-input"
                type="email"
                autoComplete="email"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@yourcompany.com"
              />
            </label>

            {error && (
              <div
                role="alert"
                style={{
                  fontSize: 12,
                  color: "var(--err)",
                  background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.25)",
                  borderRadius: 7,
                  padding: "8px 10px",
                  lineHeight: 1.5,
                }}
              >
                {error}
              </div>
            )}

            <button
              className="gw-btn gw-btn--primary"
              type="submit"
              disabled={busy || !email}
              style={{ justifyContent: "center", marginTop: 4 }}
            >
              {busy ? "Sending…" : "Send reset link"}
            </button>
            <a
              href="/login"
              style={{
                fontSize: 12,
                color: "var(--text-3)",
                textAlign: "center",
                textDecoration: "none",
              }}
            >
              Back to sign in
            </a>
          </form>
        )}
      </div>
    </main>
  );
}
