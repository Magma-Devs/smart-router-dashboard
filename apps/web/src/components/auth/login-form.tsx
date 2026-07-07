"use client";

import { useState, type FormEvent } from "react";
import { signIn } from "next-auth/react";

interface ProviderFlags {
  google: boolean;
  github: boolean;
  discord: boolean;
}

/** Provider badges — shown only for providers whose id/secret pair is set. */
const PROVIDER_META: Array<{ id: keyof ProviderFlags; label: string; icon: React.ReactNode }> = [
  {
    id: "google",
    label: "Google",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
        <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.67-.22-2.46H12v4.65h6.45a5.52 5.52 0 0 1-2.39 3.62v3h3.87c2.26-2.09 3.57-5.16 3.57-8.81Z" />
        <path fill="#34A853" d="M12 24c3.24 0 5.95-1.07 7.93-2.91l-3.87-3c-1.07.72-2.44 1.14-4.06 1.14-3.13 0-5.78-2.11-6.73-4.96H1.29v3.1A12 12 0 0 0 12 24Z" />
        <path fill="#FBBC05" d="M5.27 14.27a7.2 7.2 0 0 1 0-4.54v-3.1H1.29a12 12 0 0 0 0 10.74l3.98-3.1Z" />
        <path fill="#EA4335" d="M12 4.77c1.76 0 3.35.61 4.6 1.8l3.44-3.44A11.96 11.96 0 0 0 12 0 12 12 0 0 0 1.29 6.63l3.98 3.1C6.22 6.88 8.87 4.77 12 4.77Z" />
      </svg>
    ),
  },
  {
    id: "github",
    label: "GitHub",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.92c.58.1.79-.25.79-.56v-2.17c-3.2.7-3.87-1.37-3.87-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.75 2.69 1.25 3.34.95.1-.74.4-1.25.72-1.53-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.45.11-3.03 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.58.24 2.74.12 3.03.74.8 1.18 1.83 1.18 3.09 0 4.41-2.69 5.38-5.25 5.66.41.36.77 1.05.77 2.13v3.16c0 .31.2.67.8.55A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5Z" />
      </svg>
    ),
  },
  {
    id: "discord",
    label: "Discord",
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="#5865F2" aria-hidden>
        <path d="M20.32 4.37a19.8 19.8 0 0 0-4.89-1.52.07.07 0 0 0-.08.04c-.21.38-.44.87-.6 1.25a18.3 18.3 0 0 0-5.5 0 12 12 0 0 0-.61-1.25.07.07 0 0 0-.08-.04c-1.71.3-3.35.81-4.88 1.52a.06.06 0 0 0-.03.02C.53 9.05-.32 13.58.1 18.06c0 .02.01.04.03.05a19.9 19.9 0 0 0 6 3.03.08.08 0 0 0 .08-.03c.46-.63.87-1.3 1.22-2a.08.08 0 0 0-.04-.11 13 13 0 0 1-1.87-.89.08.08 0 0 1-.01-.13l.37-.29a.07.07 0 0 1 .08-.01c3.93 1.8 8.18 1.8 12.06 0a.07.07 0 0 1 .08 0l.37.3a.08.08 0 0 1-.01.13c-.6.35-1.22.64-1.87.88a.08.08 0 0 0-.04.12c.36.7.77 1.36 1.22 1.99a.08.08 0 0 0 .08.03 19.8 19.8 0 0 0 6.02-3.03.08.08 0 0 0 .03-.05c.5-5.18-.84-9.68-3.55-13.66a.06.06 0 0 0-.03-.03ZM8.02 15.33c-1.18 0-2.16-1.08-2.16-2.42 0-1.33.96-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.34-.96 2.42-2.16 2.42Zm7.97 0c-1.18 0-2.15-1.08-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.34-.95 2.42-2.16 2.42Z" />
      </svg>
    ),
  },
];

/**
 * Sign-in form: email + password against the api (via Auth.js
 * Credentials), plus one badge per configured OAuth provider.
 */
export function LoginForm({ providers }: { providers: ProviderFlags }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const enabledProviders = PROVIDER_META.filter((p) => providers[p.id]);

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
          <img src="/magma-logo.png" width={32} height={32} alt="Magma" style={{ objectFit: "contain" }} />
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

          <button className="gw-btn gw-btn--primary" type="submit" disabled={busy} style={{ marginTop: 4 }}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        {enabledProviders.length > 0 && (
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
              {enabledProviders.map((p) => (
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
