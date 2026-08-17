"use client";

import { useState } from "react";
import { apiPost } from "@/lib/api-client";

/** Changing your own password signs out your *other* devices and keeps this
 *  one — being logged out of the window you just used is hostile; logging out
 *  the other devices is the security value. */
export function ChangePasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = repeat.length > 0 && next !== repeat;

  async function submit() {
    setBusy(true); setError(null); setDone(false);
    try {
      await apiPost("/api/account/password", { current, next });
      setCurrent(""); setNext(""); setRepeat(""); setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change your password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gw-card" style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Change password</div>
      <div style={{ display: "grid", gap: 9, maxWidth: 360 }}>
        <input className="gw-input" type="password" placeholder="Current password"
          autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <input className="gw-input" type="password" placeholder="New password"
          autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        <input className="gw-input" type="password" placeholder="Repeat new password"
          autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)}
          aria-invalid={mismatch} />
        <div style={{ fontSize: 11.5, color: "var(--text-3)", lineHeight: 1.5 }}>
          8 to 64 characters, checked against known breached passwords. Your other devices will be
          signed out; this one stays.
        </div>
        {(error ?? (mismatch ? "Those passwords don't match." : null)) && (
          <div role="alert" style={{ fontSize: 12, color: "var(--err)" }}>
            {error ?? "Those passwords don't match."}
          </div>
        )}
        {done && <div style={{ fontSize: 12, color: "var(--ok, var(--text-2))" }}>Password changed.</div>}
        <button className="gw-btn gw-btn--primary" style={{ alignSelf: "flex-start" }}
          disabled={busy || mismatch || !current || !next}
          onClick={() => void submit()}>
          {busy ? "Saving…" : "Update password"}
        </button>
      </div>
    </div>
  );
}
