"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { TOTP_DIGITS } from "@sr/shared";
import { apiPost, ApiError } from "@/lib/api-client";
import { Spinner } from "@/components/gateway/BusyButton";
import { copyText } from "./copy-text";

/**
 * Setting up an authenticator: a QR, the same secret as text, and a code typed
 * back to prove it worked.
 *
 * The text secret is not a nicety. A desktop password manager cannot scan a
 * screen, and somebody administering a deployment from a laptop with no phone
 * camera in reach has no other way through — so it is shown beside the QR
 * rather than behind a "can't scan?" link.
 *
 * The QR arrives as SVG markup from the api and is injected as-is. It is our own
 * server's response to an authenticated call, generated from a URI the browser
 * never sees; there is no user input anywhere in it. Rendering it client-side
 * from the `otpauth://` URI would mean shipping the URI — and therefore the
 * secret — through one more place, for a QR library in the bundle.
 */

interface Offer {
  secret: string;
  qrSvg: string;
  issuer: string;
}

/** The secret in groups of four, as authenticator apps print it. */
export function keyGroups(secret: string): string[] {
  return secret.match(/.{1,4}/g) ?? [];
}

/** The secret typed by hand: a line breaks between two groups, never inside one. */
export function ManualKey({ secret }: { secret: string }) {
  return (
    <code
      className="gw-mono"
      style={{ display: "block", fontSize: 12, lineHeight: 1.7, color: "var(--text-2)" }}
    >
      {keyGroups(secret).map((group, i) => (
        <Fragment key={i}>
          {i > 0 && " "}
          <span style={{ whiteSpace: "nowrap" }}>{group}</span>
        </Fragment>
      ))}
    </code>
  );
}

export type CopyState = "idle" | "copied" | "failed";

/** "Copy key", then a tick and "Copied" once the key is on the clipboard, or a
 *  line saying it is not when the browser refused. */
export function CopyKeyButton({ state, onCopy }: { state: CopyState; onCopy: () => void }) {
  return (
    <div style={{ marginTop: 8 }}>
      <button
        type="button"
        className="gw-btn gw-btn--ghost"
        style={{ fontSize: 12 }}
        onClick={onCopy}
      >
        {state === "copied" ? (
          <>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--ok)"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Copied
          </>
        ) : (
          "Copy key"
        )}
      </button>
      <div aria-live="polite" style={{ fontSize: 12, color: "var(--text-3)", marginTop: 4 }}>
        {state === "failed" ? "Could not copy. Select the key and copy it by hand." : null}
      </div>
    </div>
  );
}

/** Where the QR goes: a spinner on the same white tile until it arrives. */
export function QrSlot({ qrSvg }: { qrSvg: string | undefined }) {
  // The SVG has no colours of its own that survive both themes, so it sits on
  // a fixed white tile. A QR must be dark-on-light to scan reliably.
  const tile: React.CSSProperties = {
    width: 180,
    height: 180,
    background: "#fff",
    padding: 8,
    borderRadius: 8,
    flexShrink: 0,
  };
  if (qrSvg === undefined) {
    return (
      <div
        role="status"
        aria-label="Loading the QR code"
        style={{
          ...tile,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#71717a",
        }}
      >
        <Spinner size={22} />
      </div>
    );
  }
  return (
    <div
      aria-label="Authenticator QR code"
      style={tile}
      dangerouslySetInnerHTML={{ __html: qrSvg }}
    />
  );
}

export function EnrolPanel({
  onEnrolled,
  heading = "Set up 2FA",
  intro,
}: {
  onEnrolled: () => void;
  heading?: string;
  intro?: string;
}) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copy, setCopy] = useState<CopyState>("idle");
  const copyReset = useRef<ReturnType<typeof setTimeout> | null>(null);
  const started = useRef(false);

  useEffect(
    () => () => {
      if (copyReset.current) clearTimeout(copyReset.current);
    },
    [],
  );

  useEffect(() => {
    // Once per mount. Each call mints a fresh secret and discards the previous
    // one, so a double-invoke in React's dev strict mode would leave the QR on
    // screen describing a secret the server has already replaced.
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        setOffer(await apiPost<Offer>("/api/account/2fa/begin", {}));
      } catch (err) {
        setError(
          err instanceof ApiError && err.statusCode === 503
            ? "2FA is not set up on this deployment. Ask whoever runs it to set TOTP_ENCRYPTION_KEY."
            : "Could not start setup. Reload and try again.",
        );
      }
    })();
  }, []);

  async function copyKey(secret: string) {
    const ok = await copyText(secret);
    setCopy(ok ? "copied" : "failed");
    if (copyReset.current) clearTimeout(copyReset.current);
    copyReset.current = setTimeout(() => setCopy("idle"), ok ? 2000 : 6000);
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/account/2fa/confirm", { code });
      onEnrolled();
    } catch {
      setError("That code is not right. Check your authenticator app and try again.");
      setCode("");
      setBusy(false);
    }
  }

  return (
    <div className="gw-card" style={{ padding: 28, maxWidth: 520 }}>
      <h2 style={{ margin: "0 0 6px", fontSize: 18 }}>{heading}</h2>
      <p style={{ margin: "0 0 20px", fontSize: 13, color: "var(--text-3)", lineHeight: 1.55 }}>
        {intro ??
          "Scan this with Google Authenticator, 1Password, Authy or any authenticator app, then enter the code it shows."}
      </p>

      {error && !offer ? (
        <div role="alert" style={{ fontSize: 13, color: "var(--err)" }}>
          {error}
        </div>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              gap: 20,
              alignItems: "flex-start",
              flexWrap: "wrap",
              marginBottom: 20,
            }}
          >
            <QrSlot qrSvg={offer?.qrSvg} />
            <div style={{ minWidth: 200, flex: 1 }}>
              <div style={{ fontSize: 12, color: "var(--text-3)", marginBottom: 6 }}>
                Can&rsquo;t scan? Enter this key by hand:
              </div>
              {offer ? (
                <>
                  <ManualKey secret={offer.secret} />
                  <CopyKeyButton state={copy} onCopy={() => void copyKey(offer.secret)} />
                </>
              ) : (
                <div style={{ fontSize: 12, color: "var(--text-3)" }}>
                  Preparing your key&hellip;
                </div>
              )}
            </div>
          </div>

          {offer && (
            <form onSubmit={confirm} style={{ display: "grid", gap: 12, maxWidth: 260 }}>
              <label style={{ display: "grid", gap: 6, fontSize: 12, color: "var(--text-2)" }}>
                Code from the app
                <input
                  className="gw-input gw-mono"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]*"
                  maxLength={TOTP_DIGITS}
                  required
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="000000"
                  style={{ letterSpacing: "0.35em", fontSize: 18, textAlign: "center" }}
                />
              </label>
              {error && (
                <div role="alert" style={{ fontSize: 12, color: "var(--err)" }}>
                  {error}
                </div>
              )}
              <button
                className="gw-btn gw-btn--primary"
                type="submit"
                disabled={busy || code.length !== TOTP_DIGITS}
              >
                {busy ? "Checking…" : "Turn on 2FA"}
              </button>
            </form>
          )}
        </>
      )}
    </div>
  );
}
