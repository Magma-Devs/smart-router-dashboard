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
export function ResetForm({ token, email }: { token: string; email: string }) {
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
          <img
            src="/magma-logo.png"
            width={32}
            height={32}
            alt="Magma"
            style={{ objectFit: "contain" }}
          />
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Choose a new password</div>
            {/* Which account this changes. Somebody with two of them cannot
                tell from the link alone, and finding out by resetting the
                wrong one is an expensive way to learn. */}
            <div style={{ fontSize: 12, color: "var(--text-3)" }}>{email}</div>
          </div>
        </div>

        {done ? (
          <>
            <p style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.6, margin: "0 0 8px" }}>
              Your password has been changed. You have been signed out everywhere else.
            </p>
            <p
              style={{
                fontSize: 12.5,
                color: "var(--text-3)",
                lineHeight: 1.6,
                margin: "0 0 20px",
              }}
            >
              That includes any device you don&apos;t recognise — which is the point, if this reset
              was because you thought somebody else had your account.
            </p>
            <a
              className="gw-btn gw-btn--primary"
              href="/login"
              style={{ justifyContent: "center", width: "100%" }}
            >
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
              />
            </label>
            {/* Before they type, not after they fail — MAG-2870 §3. A rule in a
                placeholder disappears at the moment it becomes relevant. */}
            <p
              style={{
                fontSize: 11.5,
                color: "var(--text-3)",
                margin: "-4px 0 0",
                lineHeight: 1.5,
              }}
            >
              At least 8 characters. Any characters, including spaces.
            </p>
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

            <p
              style={{ fontSize: 11.5, color: "var(--text-3)", margin: "2px 0 0", lineHeight: 1.5 }}
            >
              Setting this signs out every device on the account. Checked against known breached
              passwords.
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
              {busy ? "Saving…" : "Save password"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}

/**
 * A reset link that is used, expired, or was never issued.
 *
 * **One message for all three.** MAG-2870 is explicit — "the same message for
 * both cases. Telling someone a link was already used also tells an attacker it
 * was already used" — and the holder cannot act on the difference anyway.
 *
 * What differs is the way out, because the two deployment shapes have different
 * ones: managed has a self-service request, on-prem has an administrator.
 */
export function ResetDead({ managed }: { managed: boolean }) {
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
      <div
        className="gw-card"
        style={{ width: "100%", maxWidth: 400, padding: 32, textAlign: "center" }}
      >
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>This link has expired</div>
        <p style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.6, margin: "0 0 20px" }}>
          {managed
            ? "Request a new one and we'll email it to you."
            : "Ask an administrator to generate a new one — this deployment has no mail server, so they hand it over directly."}
        </p>
        {/* Managed sends people to the form that actually issues one. This used
            to point at /login for both, from before /forgot-password existed —
            so the button said "Request a new link" and went somewhere that
            issues nothing, and for anyone still signed in /login bounces to the
            dashboard, which is a worse landing still. */}
        <a
          className="gw-btn gw-btn--primary"
          href={managed ? "/forgot-password" : "/login"}
          style={{ justifyContent: "center", width: "100%" }}
        >
          {managed ? "Request a new link" : "Go to sign in"}
        </a>
      </div>
    </main>
  );
}
