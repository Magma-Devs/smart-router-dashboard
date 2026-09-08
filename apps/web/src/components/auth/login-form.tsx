"use client";

import { useRef, useState, type FormEvent } from "react";
import { signIn } from "next-auth/react";
import { TOTP_DIGITS } from "@sr/shared";
import { apiUrl } from "@/lib/api-client";
import { enabledProviders, type ProviderFlags } from "./oauth-providers";

/**
 * Sign-in: email and password, then — for an account with an authenticator —
 * a six-digit code.
 *
 * Below the form, one button per OAuth provider this deployment configures
 * (Google, GitHub) — shown on the first step only.
 *
 * **Why the first step talks to the api directly** rather than through Auth.js.
 * A verified password opens no session, so there is nothing for Auth.js to mint
 * a token from — it has no notion of a partial sign-in, and inventing one (a
 * token marked "half") is precisely the shape the api refuses on purpose. So
 * the password step is a plain call that returns a challenge, and Auth.js is
 * handed the finished thing: `signIn` runs once, on the second step, against a
 * response that already carries a session id.
 *
 * Nothing sensitive is held here. The challenge is single-use, dies in five
 * minutes, and is worthless without a code from the phone.
 */

type Stage =
  | { name: "credentials" }
  | { name: "code"; challenge: string };

interface SignInPhaseOne {
  twoFactorRequired?: boolean;
  challenge?: string;
  sessionId?: string;
}

export function LoginForm({ providers }: { providers: ProviderFlags }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<Stage>({ name: "credentials" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const providerBadges = enabledProviders(providers);

  /** One message for every way either step can fail. The ticket: "a wrong code
   *  gives a generic error with no hint about which factor failed" — so the
   *  wording cannot change between the two screens either. */
  const GENERIC = "Invalid email or password.";
  /** A lockout is not a wrong password: saying "invalid" to someone with the
   *  right one sends them to try again, which keeps them locked. */
  const LOCKED =
    "Too many failed attempts on this account. It unlocks within 15 minutes — or ask an administrator for a reset link.";

  async function submitCredentials(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const base = await apiUrl();
      const res = await fetch(`${base}/auth/sign-in`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.status === 423) {
        setError(LOCKED);
        setBusy(false);
        return;
      }
      if (!res.ok) {
        setError(GENERIC);
        setBusy(false);
        return;
      }
      const body = (await res.json()) as SignInPhaseOne;

      if (body.twoFactorRequired && body.challenge) {
        setStage({ name: "code", challenge: body.challenge });
        setBusy(false);
        // The phone is already in hand; land the caret where they will type.
        setTimeout(() => codeRef.current?.focus(), 0);
        return;
      }

      // No authenticator on this account — the api opened a session, so hand
      // the same credentials to Auth.js, which mints the token from it.
      const res2 = await signIn("credentials", { email, password, redirect: false });
      if (res2?.error) {
        setError(GENERIC);
        setBusy(false);
        return;
      }
      window.location.href = "/overview";
    } catch {
      setError("Could not reach the dashboard API.");
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (stage.name !== "code") return;
    setBusy(true);
    setError(null);

    const res = await signIn("credentials", {
      email,
      challenge: stage.challenge,
      code,
      redirect: false,
    });
    if (res?.error) {
      // The challenge is spent whether or not the code was right — a challenge
      // that survived a wrong code would let someone try code after code
      // against one password check. So this goes back to the start, and says so.
      setStage({ name: "credentials" });
      setCode("");
      setPassword("");
      setError(res.code === "locked" ? LOCKED : GENERIC);
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
            <div style={{ fontSize: 12, color: "var(--text-3)" }}>
              {stage.name === "code" ? "Enter your authenticator code" : "Sign in to continue"}
            </div>
          </div>
        </div>

        {stage.name === "credentials" ? (
          <form onSubmit={submitCredentials} style={{ display: "grid", gap: 12 }}>
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
              <div
                role="alert"
                style={{ fontSize: 12, color: "var(--danger, #f43)", marginTop: -4 }}
              >
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
        ) : (
          <form onSubmit={submitCode} style={{ display: "grid", gap: 12 }}>
            <p style={{ fontSize: 12, color: "var(--text-3)", margin: 0 }}>
              Open your authenticator app and enter the {TOTP_DIGITS}-digit code for{" "}
              <strong style={{ color: "var(--text-2)" }}>{email}</strong>.
            </p>
            <label style={{ display: "grid", gap: 6, fontSize: 12, color: "var(--text-2)" }}>
              Authenticator code
              <input
                ref={codeRef}
                className="gw-input gw-mono"
                inputMode="numeric"
                // The browser and password managers know this field; naming it
                // properly is what makes autofill from a phone or 1Password work.
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={TOTP_DIGITS}
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder="000000"
                style={{ letterSpacing: "0.35em", fontSize: 18, textAlign: "center" }}
              />
            </label>

            {error && (
              <div
                role="alert"
                style={{ fontSize: 12, color: "var(--danger, #f43)", marginTop: -4 }}
              >
                {error}
              </div>
            )}

            <button
              className="gw-btn gw-btn--primary"
              type="submit"
              disabled={busy || code.length !== TOTP_DIGITS}
            >
              {busy ? "Checking…" : "Verify"}
            </button>
            <button
              type="button"
              className="gw-btn gw-btn--ghost"
              onClick={() => {
                setStage({ name: "credentials" });
                setCode("");
                setPassword("");
                setError(null);
              }}
              style={{ fontSize: 12 }}
            >
              Back
            </button>
            <p style={{ fontSize: 11, color: "var(--text-4)", margin: 0, textAlign: "center" }}>
              Lost your phone? An administrator can reset your two-factor setup.
            </p>
          </form>
        )}

        {stage.name === "credentials" && providerBadges.length > 0 && (
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
