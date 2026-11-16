"use client";

import { useState, type FormEvent } from "react";
import { apiUrl } from "@/lib/api-client";
import { BusyButton } from "@/components/gateway/BusyButton";
import { AuthHeader, AuthScreen } from "./auth-screen";
import { hasErrors, newPasswordErrors } from "./field-checks";
import { FormError, NewPasswordFields } from "./form-fields";

/**
 * Setting a new password from a reset link.
 *
 * On success this sends the person to `/login` rather than into the dashboard.
 * A reset link that signs you in is a reset link worth stealing — and proving
 * the new password works by using it is the point of the exercise.
 */
export function ResetForm({
  token,
  email,
  managed,
}: {
  token: string;
  email: string | null;
  managed: boolean;
}) {
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<"done" | "dead" | null>(null);

  const fieldErrors = newPasswordErrors(password, repeat, submitted);
  const mismatch = repeat.length > 0 && password !== repeat;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (hasErrors(newPasswordErrors(password, repeat, true))) return;
    setBusy(true);
    setError(null);
    try {
      const base = await apiUrl();
      const res = await fetch(`${base}/auth/password/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      // The api's one answer for every dead link. The preview can go
      // unanswered and leave the form up, so the dead page can still land here.
      if (res.status === 410) {
        setOutcome("dead");
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? "That didn't work. Please try again.");
        setBusy(false);
        return;
      }
      setOutcome("done");
    } catch {
      setError("Could not reach the dashboard API.");
      setBusy(false);
    }
  }

  if (outcome === "done") return <ResetDone email={email} />;
  if (outcome === "dead") return <ResetDead managed={managed} />;

  return (
    <AuthScreen>
      <div className="gw-card" style={{ width: "100%", maxWidth: 400, padding: 32 }}>
        {/* Which account this changes. Somebody with two of them cannot tell
            from the link alone, and finding out by resetting the wrong one is
            an expensive way to learn. */}
        <AuthHeader title="Choose a new password" subtitle={email} />

        <form noValidate onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
          {/* The rule shows under the field before they type, not after they
              fail — MAG-2870 §3. */}
          <NewPasswordFields
            label="New password"
            password={password}
            repeat={repeat}
            onPassword={setPassword}
            onRepeat={setRepeat}
            errors={fieldErrors}
            readOnly={busy}
          />

          <p style={{ fontSize: 11.5, color: "var(--text-3)", margin: 0, lineHeight: 1.5 }}>
            Setting this signs out every device on the account.
          </p>

          <FormError message={error} />

          <BusyButton
            className="gw-btn gw-btn--primary"
            type="submit"
            busy={busy}
            busyLabel="Saving…"
            disabled={mismatch}
            style={{ justifyContent: "center", marginTop: 4 }}
          >
            Save password
          </BusyButton>
        </form>
      </div>
    </AuthScreen>
  );
}

/** The password is set and every session is gone; the way on is signing in. */
export function ResetDone({ email }: { email: string | null }) {
  return (
    <AuthScreen>
      <div className="gw-card" style={{ width: "100%", maxWidth: 400, padding: 32 }}>
        <AuthHeader title="Password changed" subtitle={email} />
        <p style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.6, margin: "0 0 20px" }}>
          Your password has been changed. You have been signed out everywhere else.
        </p>
        <a
          className="gw-btn gw-btn--primary"
          href="/login"
          style={{ justifyContent: "center", width: "100%" }}
        >
          Sign in
        </a>
      </div>
    </AuthScreen>
  );
}

/**
 * A reset link that is used, replaced by a newer one, expired, or was never
 * issued.
 *
 * **One message for all of them.** MAG-2870 is explicit — "the same message for
 * both cases. Telling someone a link was already used also tells an attacker it
 * was already used" — and the holder cannot act on the difference anyway.
 *
 * What differs is the way out, because the two deployment shapes have different
 * ones: managed has a self-service request, on-prem has an administrator.
 */
export function ResetDead({ managed }: { managed: boolean }) {
  return (
    <AuthScreen>
      <div
        className="gw-card"
        style={{ width: "100%", maxWidth: 400, padding: 32, textAlign: "center" }}
      >
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>
          This link no longer works
        </div>
        <p style={{ fontSize: 13, color: "var(--text-2)", lineHeight: 1.6, margin: "0 0 20px" }}>
          It may have been used, replaced or expired.{" "}
          {managed
            ? "Request a new one and we'll email it to you."
            : "Ask an administrator to generate a new one. This deployment has no mail server, so they hand it over directly."}
        </p>
        {/* Managed goes to the form that issues a link; on-prem has nowhere to
            request one, so it goes to sign in. */}
        <a
          className="gw-btn gw-btn--primary"
          href={managed ? "/forgot-password" : "/login"}
          style={{ justifyContent: "center", width: "100%" }}
        >
          {managed ? "Request a new link" : "Go to sign in"}
        </a>
      </div>
    </AuthScreen>
  );
}
