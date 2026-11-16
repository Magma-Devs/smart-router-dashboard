"use client";

import { useState, type FormEvent } from "react";
import { signIn } from "next-auth/react";
import { apiUrl } from "@/lib/api-client";
import { HOME_PATH } from "@/lib/home-path";
import { BusyButton } from "@/components/gateway/BusyButton";
import { AuthHeader, AuthScreen } from "./auth-screen";
import { emailProblem, hasErrors, newPasswordErrors } from "./field-checks";
import { Field, FormError, NewPasswordFields } from "./form-fields";

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
  // Two requests and then a page load sit behind one click; the label says
  // which of them is running, so a slow one never looks like nothing.
  const [busyLabel, setBusyLabel] = useState("Creating…");
  const [submitted, setSubmitted] = useState(false);

  // Every field's error once a submit has been tried; a mismatch shows sooner.
  const errorsFor = (tried: boolean) => ({
    token: tried && !token ? "Enter the setup token." : null,
    email: tried ? emailProblem(email) : null,
    ...newPasswordErrors(password, repeat, tried),
  });
  const fieldErrors = errorsFor(submitted);
  const mismatch = repeat.length > 0 && password !== repeat;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (hasErrors(errorsFor(true))) return;
    setBusyLabel("Creating…");
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
      //
      // `busy` stays set from here on: the next thing to happen is the browser
      // leaving this page, and an idle button in the meantime reads as a
      // request that was lost.
      setBusyLabel("Signing in…");
      const signedIn = await signIn("credentials", { email, password, redirect: false });
      if (signedIn?.error) {
        window.location.href = "/login";
        return;
      }
      window.location.href = HOME_PATH;
    } catch {
      setError("Could not reach the dashboard API.");
      setBusy(false);
    }
  }

  return (
    <AuthScreen>
      <div className="gw-card" style={{ width: "100%", maxWidth: 420, padding: 32 }}>
        <AuthHeader title="Set up this dashboard" subtitle="Create the first administrator" />

        <p
          style={{
            fontSize: 12.5,
            color: "var(--text-2)",
            marginTop: 0,
            marginBottom: 20,
            lineHeight: 1.6,
          }}
        >
          Nothing else opens until this is done. You&apos;ll need the setup token{" "}
          {mode === "onprem" ? "printed by the installer" : "we sent you"}. It proves you&apos;re
          the person who installed this, and it&apos;s only needed once.
        </p>

        <form noValidate onSubmit={onSubmit} style={{ display: "grid", gap: 12 }}>
          <Field
            label="Setup token"
            readOnly={busy}
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="From the installer output"
            error={fieldErrors.token}
          />
          <Field
            label={
              <span>
                Your name <span style={{ color: "var(--text-3)" }}>(optional)</span>
              </span>
            }
            readOnly={busy}
            type="text"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Dana Levi"
          />
          <Field
            label="Email"
            readOnly={busy}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@yourcompany.com"
            error={fieldErrors.email}
          />
          <NewPasswordFields
            password={password}
            repeat={repeat}
            onPassword={setPassword}
            onRepeat={setRepeat}
            errors={fieldErrors}
            readOnly={busy}
          />

          <FormError message={error} />

          <BusyButton
            className="gw-btn gw-btn--primary"
            type="submit"
            busy={busy}
            busyLabel={busyLabel}
            disabled={mismatch}
            style={{ justifyContent: "center", marginTop: 4 }}
          >
            Create administrator
          </BusyButton>
        </form>
      </div>
    </AuthScreen>
  );
}
