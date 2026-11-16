"use client";

import { useRef, useState, type FormEvent } from "react";
import { signIn } from "next-auth/react";
import { TOTP_DIGITS } from "@sr/shared";
import { apiUrl } from "@/lib/api-client";
import { HOME_PATH } from "@/lib/home-path";
import { AuthHeader, AuthScreen } from "./auth-screen";
import { emailProblem, hasErrors } from "./field-checks";
import { Field, FormError } from "./form-fields";
import { enabledProviders, type ProviderFlags } from "./oauth-providers";

/** A lockout is not a wrong password: saying "invalid" to someone with the
 *  right one sends them to try again, which keeps them locked. 15 minutes is the
 *  api's window (`LOCKOUT_WINDOW_MS`), the longest a lock can last. */
export const LOCKED = "Too many failed attempts. Try again in 15 minutes, or reset your password.";

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
 * That first call is a **probe**: it asks which step comes next and opens
 * nothing. An account with no authenticator finishes through `signIn`, which
 * reaches the same api route a second time — so a probe that completed the
 * sign-in would leave a session nobody is holding.
 *
 * Nothing sensitive is held here. The challenge is single-use, dies in five
 * minutes, and is worthless without a code from the phone.
 */

type Stage =
  | { name: "credentials" }
  /** `challenge` is held here after a password; after Google or GitHub it is in
   *  the httpOnly handoff cookie and `handoff` names the provider instead. */
  | { name: "code"; challenge: string | null; handoff?: "google" | "github" };

/** What the first step checks before asking the api. Says nothing about the
 *  account: an empty field and a malformed address, nothing more. */
function credentialErrors(email: string, password: string) {
  return { email: emailProblem(email), password: password ? null : "Enter your password." };
}
const NO_ERRORS = { email: null, password: null };

interface SignInPhaseOne {
  twoFactorRequired?: boolean;
  challenge?: string;
}

export function LoginForm({
  providers,
  pendingCode,
  notice,
}: {
  providers: ProviderFlags;
  /** Back from a Google or GitHub sign-in whose account has an authenticator. */
  pendingCode?: { email: string; provider: "google" | "github" };
  /** Why the browser was sent here (`lib/sign-in-notice.ts`), shown above the
   *  form. Never a sign-in failure, which stays generic. */
  notice?: string | null;
}) {
  const [email, setEmail] = useState(pendingCode?.email ?? "");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<Stage>(
    pendingCode
      ? { name: "code", challenge: null, handoff: pendingCode.provider }
      : { name: "credentials" },
  );
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const providerBadges = enabledProviders(providers);

  /** One message for every way either step can fail. The ticket: "a wrong code
   *  gives a generic error with no hint about which factor failed" — so the
   *  wording cannot change between the two screens either. */
  const GENERIC = "Invalid email or password.";
  /** The per-network limit, not the account's lockout — and not a wrong
   *  password, which is what "invalid" would tell somebody who typed it right. */
  const THROTTLED = "Too many sign-in attempts from this network. Wait a minute and try again.";
  const UNAVAILABLE = "The dashboard could not check that just now. Try again in a moment.";

  /** Back to the password step, and off the `?step=code` URL, so a reload does
   *  not reopen a code screen whose challenge is gone. */
  function restart(message: string | null) {
    setStage({ name: "credentials" });
    setCode("");
    setPassword("");
    setSubmitted(false);
    setError(message);
    if (window.location.search) window.history.replaceState(null, "", "/login");
  }

  // Shown once a submit has been tried, then kept current as they type.
  const fieldErrors = submitted ? credentialErrors(email, password) : NO_ERRORS;

  async function submitCredentials(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (hasErrors(credentialErrors(email, password))) return;
    setBusy(true);
    setError(null);
    try {
      const base = await apiUrl();
      const res = await fetch(`${base}/auth/sign-in`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, probe: true }),
      });
      if (res.status === 423) {
        setError(LOCKED);
        setBusy(false);
        return;
      }
      if (!res.ok) {
        setError(res.status === 429 ? THROTTLED : res.status >= 500 ? UNAVAILABLE : GENERIC);
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
      window.location.href = HOME_PATH;
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

    const res = await signIn(
      "credentials",
      stage.handoff
        ? { handoff: "1", code, redirect: false }
        : { email, challenge: stage.challenge ?? "", code, redirect: false },
    );
    if (res?.error) {
      // Throttled before the code was looked at: the challenge is still good,
      // so stay here rather than send them back through their password.
      if (res.code === "rate_limited") {
        setError(THROTTLED);
        setBusy(false);
        return;
      }
      // Otherwise the challenge is spent whether or not the code was right — a
      // challenge that survived a wrong code would let someone try code after
      // code against one password check. So this goes back to the start.
      restart(res.code === "locked" ? LOCKED : GENERIC);
      setBusy(false);
      return;
    }
    window.location.href = HOME_PATH;
  }

  return (
    <AuthScreen>
      <div className="gw-card" style={{ width: "100%", maxWidth: 380, padding: 32 }}>
        <AuthHeader
          title="Smart Router Dashboard"
          subtitle={stage.name === "code" ? "Enter your authenticator code" : "Sign in to continue"}
        />

        {stage.name === "credentials" ? (
          <form noValidate onSubmit={submitCredentials} style={{ display: "grid", gap: 12 }}>
            {notice && (
              <p
                role="status"
                style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.6, margin: 0 }}
              >
                {notice}
              </p>
            )}
            <Field
              label="Email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              error={fieldErrors.email}
            />
            <Field
              label="Password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={fieldErrors.password}
            />

            <FormError message={error} />

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
          <form noValidate onSubmit={submitCode} style={{ display: "grid", gap: 12 }}>
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
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder="000000"
                style={{ letterSpacing: "0.35em", fontSize: 18, textAlign: "center" }}
              />
            </label>

            <FormError message={error} />

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
              onClick={() => restart(null)}
              style={{ fontSize: 12 }}
            >
              Back
            </button>
            <p style={{ fontSize: 11, color: "var(--text-4)", margin: 0, textAlign: "center" }}>
              Lost your phone? An administrator can reset your 2FA.
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
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                  }}
                  onClick={() => void signIn(p.id, { redirectTo: HOME_PATH })}
                >
                  {p.icon}
                  Continue with {p.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </AuthScreen>
  );
}
