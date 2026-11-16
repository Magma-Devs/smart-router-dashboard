"use client";

import { useId, type InputHTMLAttributes, type ReactNode } from "react";
import { PASSWORD_RULE } from "@sr/shared";
import type { NewPasswordErrors } from "./field-checks";

/**
 * One error style for the auth forms and the Change password card: red text
 * under what it is about. A field's error sits directly under that field. An
 * error no field owns (the server refused, or could not be reached) sits
 * directly above the submit button, next to the action that produced it.
 */
const errorStyle = { fontSize: 12, color: "var(--err)", lineHeight: 1.5 } as const;
const hintStyle = { fontSize: 11.5, color: "var(--text-3)", lineHeight: 1.5 } as const;
const labelStyle = { display: "grid", gap: 6, fontSize: 12, color: "var(--text-2)" } as const;

/** The error no field owns. Render it directly above the submit button. */
export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" style={errorStyle}>
      {message}
    </div>
  );
}

/** A visible label, the input, its error, then a hint that stays put. */
export function Field({
  label,
  error,
  hint,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & {
  label: ReactNode;
  error?: string | null;
  hint?: ReactNode;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ");
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <label style={labelStyle}>
        {label}
        <input
          className="gw-input"
          {...input}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
        />
      </label>
      {error && (
        <div id={errorId} role="alert" style={errorStyle}>
          {error}
        </div>
      )}
      {hint && (
        <div id={hintId} style={hintStyle}>
          {hint}
        </div>
      )}
    </div>
  );
}

/** A new password and its repeat, with the rule under the first. Join, Setup
 *  and Reset all set a password through this. */
export function NewPasswordFields({
  label = "Password",
  password,
  repeat,
  onPassword,
  onRepeat,
  errors,
  readOnly,
}: {
  label?: string;
  password: string;
  repeat: string;
  onPassword: (value: string) => void;
  onRepeat: (value: string) => void;
  errors: NewPasswordErrors;
  readOnly?: boolean;
}) {
  return (
    <>
      <Field
        label={label}
        type="password"
        autoComplete="new-password"
        readOnly={readOnly}
        value={password}
        onChange={(e) => onPassword(e.target.value)}
        error={errors.password}
        hint={PASSWORD_RULE}
      />
      <Field
        label="Repeat password"
        type="password"
        autoComplete="new-password"
        readOnly={readOnly}
        value={repeat}
        onChange={(e) => onRepeat(e.target.value)}
        error={errors.repeat}
      />
    </>
  );
}
