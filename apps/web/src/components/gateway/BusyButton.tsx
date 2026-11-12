"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * A small ring with a turning arc, drawn in the text colour around it, so it
 * reads on a primary button (white) and on a ghost one (the muted text) alike.
 */
export function Spinner({ size = 13 }: { size?: number }) {
  return (
    <svg
      className="gw-spin"
      width={size}
      height={size}
      viewBox="0 0 13 13"
      aria-hidden="true"
      style={{ display: "block", flexShrink: 0 }}
    >
      <circle cx="6.5" cy="6.5" r="5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.8" />
      <path d="M6.5 1.5 A5 5 0 0 1 11.5 6.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * A button that shows its request is running: a spinner and `busyLabel` in
 * place of its label, disabled so a second click cannot send it twice, and
 * `aria-busy` so a screen reader says it is working rather than unavailable.
 *
 * The caller owns `busy` and decides when it ends. A form that navigates on
 * success keeps it set until the browser leaves the page, so the button does
 * not fall back to idle in the gap between the answer and the next page.
 */
export function BusyButton({
  busy,
  busyLabel,
  disabled,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  busy: boolean;
  busyLabel: string;
  children: ReactNode;
}) {
  return (
    <button {...rest} disabled={busy || disabled} aria-busy={busy || undefined}>
      {busy ? (
        <>
          <Spinner /> {busyLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}
