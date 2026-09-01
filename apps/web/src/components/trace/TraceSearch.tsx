"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { isValidGuid } from "@sr/shared";

/**
 * The GUID box. Navigates to /trace/<guid> rather than fetching in place, so
 * every trace is a URL you can paste to whoever is on call — which is most of
 * why this surface is its own route instead of a tab.
 */
export function TraceSearch({ initial = "", autoFocus = false }: { initial?: string; autoFocus?: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const trimmed = value.trim();
  // Only complain once they've typed something — an empty box isn't an error.
  const invalid = trimmed !== "" && !isValidGuid(trimmed);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (trimmed === "" || invalid) return;
    router.push(`/trace/${trimmed}`);
  }

  return (
    <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          className="gw-input gw-mono"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="8471029384710293"
          aria-label="Relay GUID"
          autoFocus={autoFocus}
          spellCheck={false}
          style={{ flex: "1 1 320px", minWidth: 0 }}
        />
        <button className="gw-btn gw-btn--primary" type="submit" disabled={trimmed === "" || invalid}>
          {/* This navigates — it does not call the model. The Ask AI button on
              the trace page is what spends anything, and naming this one
              "Explain" implied an action it never performed. */}
          Look up
        </button>
      </div>
      {invalid && (
        <div style={{ fontSize: 12, color: "var(--err)" }}>
          A relay GUID is a plain number of up to 20 digits — the router returns one in the{" "}
          <code className="gw-mono">Lava-Guid</code> response header.
        </div>
      )}
    </form>
  );
}
