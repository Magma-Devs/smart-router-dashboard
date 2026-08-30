"use client";

import { useState, type FormEvent } from "react";
import { signIn, signOut } from "next-auth/react";
import { apiUrl } from "@/lib/api-client";
import { ROLE_DESCRIPTIONS, ROLE_LABELS, type Role } from "@sr/shared";

/**
 * Accepting an invitation.
 *
 * The address is shown but **not editable**, and that is not a UI nicety: the
 * account is created with the invitation's address server-side, so there is no
 * field here that could disagree with it.
 */
export function InviteForm({ token, email, role }: { token: string; email: string; role: Role }) {
  const [name, setName] = useState("");
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
      const res = await fetch(`${base}/auth/invite/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password, name: name || undefined }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? "That didn't work. Please try again.");
        setBusy(false);
        return;
      }

      const signedIn = await signIn("credentials", { email, password, redirect: false });
      window.location.href = signedIn?.error ? "/login" : "/overview";
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
          <img
            src="/magma-logo.png"
            width={32}
            height={32}
            alt="Magma"
            style={{ objectFit: "contain" }}
          />
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Join this dashboard</div>
            <div style={{ fontSize: 12, color: "var(--text-3)" }}>Smart Router Dashboard</div>
          </div>
        </div>

        {/* The invitation, restated. Not editable — the account is created with
            this address server-side, so an editable field could only lie. */}
        <div
          style={{
            background: "var(--bg)",
            border: "1px solid var(--line)",
            borderRadius: 8,
            padding: "12px 14px",
            marginBottom: 18,
            display: "grid",
            gap: 8,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              alignItems: "baseline",
            }}
          >
            <span style={{ fontSize: 11, color: "var(--text-3)" }}>Invitation for</span>
            <span className="gw-mono" style={{ fontSize: 12.5, fontWeight: 600 }}>
              {email}
            </span>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              alignItems: "baseline",
            }}
          >
            <span style={{ fontSize: 11, color: "var(--text-3)" }}>Role</span>
            <span className="gw-tag gw-tag--info" style={{ fontSize: 11 }}>
              {ROLE_LABELS[role]}
            </span>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-3)", lineHeight: 1.5 }}>
            {ROLE_DESCRIPTIONS[role]}
          </div>
        </div>

        <form onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
          <label style={labelStyle}>
            <span>
              Your name <span style={{ color: "var(--text-3)" }}>(optional)</span>
            </span>
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
            Any characters, 8 to 64. Checked against known breached passwords — there are no other
            rules, and it never expires.
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
            {busy ? "Joining…" : "Accept invitation"}
          </button>
        </form>
      </div>
    </main>
  );
}

/** Shown for a link that has been used, revoked, or has run out of time. All
 *  three say the same thing on purpose — the person holding it can't act on the
 *  difference, and spelling it out would tell a stranger which of them a
 *  guessed token hit. */
export function InviteDead() {
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
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>
          This invitation link no longer works
        </div>
        <p style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.6, margin: "0 0 20px" }}>
          It may already have been used, or it may have expired. Ask an administrator to send you a
          new one.
        </p>
        <a className="gw-btn" href="/login" style={{ justifyContent: "center" }}>
          Go to sign in
        </a>
      </div>
    </main>
  );
}

/**
 * Someone already signed in, following an invitation link.
 *
 * The edge gate used to redirect this case to the dashboard. The rule behind it
 * is right — an invitation exists to create an account for somebody who hasn't
 * got one, and offering the form to a signed-in visitor offers them a second —
 * but a silent bounce reads as a broken link.
 *
 * The case that matters is not an admin testing their own link. It is somebody
 * who already has an account clicking an invitation meant for a second address:
 * they land on the dashboard, conclude nothing happened, and the invitation sits
 * pending with nobody able to explain why. Signing out returns here rather than
 * to the login page, so accepting is one click from this screen.
 */
export function InviteSignedIn({
  token,
  invitedEmail,
  signedInAs,
}: {
  token: string;
  invitedEmail: string;
  signedInAs: string;
}) {
  const sameAddress = signedInAs.toLowerCase() === invitedEmail.toLowerCase();
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
      <div className="gw-card" style={{ width: "100%", maxWidth: 430, padding: 32 }}>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 10 }}>
          You are already signed in
        </div>
        <p style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.65, margin: "0 0 8px" }}>
          This browser is signed in as{" "}
          <strong style={{ color: "var(--text)" }}>{signedInAs}</strong>, and this invitation is for{" "}
          <strong style={{ color: "var(--text)" }}>{invitedEmail}</strong>.
        </p>
        <p style={{ fontSize: 12.5, color: "var(--text-3)", lineHeight: 1.65, margin: "0 0 20px" }}>
          {sameAddress
            ? "That address already has an account, so there is nothing to accept — just sign in."
            : "Accepting it creates a separate account, so you need to sign out of this one first. You will come straight back here."}
        </p>
        <div style={{ display: "grid", gap: 8 }}>
          <SignOutAndReturn token={token} sameAddress={sameAddress} />
          <a
            className="gw-btn"
            href="/overview"
            style={{ justifyContent: "center", fontSize: 12.5 }}
          >
            Stay signed in as {signedInAs}
          </a>
        </div>
      </div>
    </main>
  );
}

function SignOutAndReturn({ token, sameAddress }: { token: string; sameAddress: boolean }) {
  return (
    <button
      className="gw-btn gw-btn--primary"
      style={{ justifyContent: "center" }}
      onClick={() => void signOut({ redirectTo: sameAddress ? "/login" : `/invite/${token}` })}
    >
      {sameAddress ? "Sign out and sign in as them" : "Sign out and accept"}
    </button>
  );
}
