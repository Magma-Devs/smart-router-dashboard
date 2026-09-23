"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";
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
  const { mutate } = useSWRConfig();

  // The repeat field is the only guard against a typo in the new password, and
  // a change signs every other device out — so an empty repeat never submits.
  const mismatch = repeat.length > 0 && next !== repeat;
  const confirmed = next.length > 0 && next === repeat;

  async function submit() {
    setBusy(true); setError(null); setDone(false);
    try {
      await apiPost("/api/account/password", { current, next });
      setCurrent(""); setNext(""); setRepeat(""); setDone(true);
      // Every other device was just signed out; the list below should say so
      // now, not at its next 30-second poll.
      void mutate("/api/account/sessions");
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
          disabled={busy || !current || !confirmed}
          onClick={() => void submit()}>
          {busy ? "Saving…" : "Update password"}
        </button>
      </div>
    </div>
  );
}
