"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";
import { PASSWORD_RULE } from "@sr/shared";
import { apiPost } from "@/lib/api-client";
import { BusyButton } from "@/components/gateway/BusyButton";
import { hasErrors, newPasswordErrors } from "@/components/auth/field-checks";
import { Field, FormError } from "@/components/auth/form-fields";

/** Changing your own password signs out your *other* devices and keeps this
 *  one — being logged out of the window you just used is hostile; logging out
 *  the other devices is the security value. */
export function ChangePasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [done, setDone] = useState(false);
  const { mutate } = useSWRConfig();

  // The repeat field is the only guard against a typo in the new password, and
  // a change signs every other device out — so an empty repeat never submits.
  const fieldErrors = newPasswordErrors(next, repeat, submitted);
  const confirmed = next.length > 0 && next === repeat;

  async function submit() {
    setSubmitted(true);
    if (hasErrors(newPasswordErrors(next, repeat, true))) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await apiPost("/api/account/password", { current, next });
      setCurrent("");
      setNext("");
      setRepeat("");
      setSubmitted(false);
      setDone(true);
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
        <Field
          label="Current password"
          type="password"
          readOnly={busy}
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <Field
          label="New password"
          type="password"
          readOnly={busy}
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          error={fieldErrors.password}
          hint={PASSWORD_RULE}
        />
        <Field
          label="Repeat new password"
          type="password"
          readOnly={busy}
          autoComplete="new-password"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          error={fieldErrors.repeat}
        />
        <div style={{ fontSize: 11.5, color: "var(--text-3)", lineHeight: 1.5 }}>
          Your other devices will be signed out; this one stays.
        </div>
        <FormError message={error} />
        {done && (
          <div style={{ fontSize: 12, color: "var(--ok, var(--text-2))" }}>Password changed.</div>
        )}
        <BusyButton
          className="gw-btn gw-btn--primary"
          style={{ alignSelf: "flex-start" }}
          busy={busy}
          busyLabel="Saving…"
          disabled={!current || !confirmed}
          onClick={() => void submit()}
        >
          Update password
        </BusyButton>
      </div>
    </div>
  );
}
