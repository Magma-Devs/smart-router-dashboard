"use client";

import { Fragment } from "react";
import type { AuditChangeRecord, AuditEventRecord } from "@sr/shared";
import { LocalTime } from "@/components/gateway/LocalTime";
import { splitInstants } from "@/lib/datetime";

/**
 * Pieces of one audit row.
 *
 * Everything here is display-only by construction — there is no edit affordance
 * anywhere in this directory, for anyone, because the ticket's rule is that
 * nobody alters a row through the product including an admin.
 */

/** A note as it was written, with any instant in it (an invitation's expiry)
 *  on the reader's clock like every other time on the page. The export keeps
 *  the note's own ISO UTC text. */
export function NoteText({ text }: { text: string }) {
  return (
    <>
      {splitInstants(text).map((part, i) =>
        i % 2 === 1 ? <LocalTime key={i} t={part} format="dateTime" /> : <Fragment key={i}>{part}</Fragment>,
      )}
    </>
  );
}

const GROUP_TONE: Record<string, string> = {
  access: "gw-tag--info",
  accounts: "gw-tag--info",
  setup: "gw-tag--brand",
  people: "gw-tag--ok",
  "2fa": "gw-tag--info",
  recovery: "gw-tag--warn",
  incidents: "gw-tag--warn",
  config: "gw-tag--warn",
  approval: "gw-tag--ok",
};

/** The group, coloured by what it is rather than by whether it is bad — none of
 *  these are failures, and tinting `config` red would read as an alarm. */
export function GroupTag({ group }: { group: string }) {
  return <span className={`gw-tag ${GROUP_TONE[group] ?? ""}`}>{group}</span>;
}

/** `eth-jsonrpc (ep_8143)` — the name it had at the time, plus the id that
 *  outlives any rename. */
export function targetLabel(event: AuditEventRecord): string | null {
  if (!event.target) return null;
  const { name, id } = event.target;
  return name ? `${name} (${id})` : id;
}

/** Redaction markers are muted so a reader can tell "we withheld this" from a
 *  value that merely looks like one. */
function isMarker(value: string): boolean {
  return /^\((none|new|deleted|changed(, ends .{1,16})?)\)$/.test(value);
}

function Value({ text }: { text: string }) {
  return (
    <span
      className="gw-mono"
      style={{ color: isMarker(text) ? "var(--text-4)" : "var(--text)", fontSize: 12 }}
    >
      {text}
    </span>
  );
}

/** The field changes, stacked under their event. */
export function ChangeList({ changes }: { changes: AuditChangeRecord[] }) {
  if (changes.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {changes.map((c, i) => (
        <div
          key={`${c.field}-${i}`}
          style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}
        >
          <span style={{ fontSize: 11, color: "var(--text-3)", minWidth: 92 }}>{c.field}</span>
          <Value text={c.from} />
          <span style={{ color: "var(--text-4)", fontSize: 11 }}>→</span>
          <Value text={c.to} />
        </div>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.07em",
          textTransform: "uppercase",
          color: "var(--text-3)",
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 13 }}>{children}</span>
    </div>
  );
}

const DASH = <span style={{ color: "var(--text-4)" }}>—</span>;

/** The full row, for the detail sheet. */
export function AuditDetail({ event }: { event: AuditEventRecord }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Field label="Time">
          {/* In full, with its zone: the sheet stands apart from the table and
              its header. The tooltip gives the instant in UTC. */}
          <LocalTime t={event.time} format="dateTime" className="gw-mono" style={{ fontSize: 12 }} />
        </Field>
        <Field label="Source">{event.source}</Field>
        <Field label="Actor">
          {event.actor.name}
          {event.actor.email ? (
            <span style={{ color: "var(--text-3)" }}> ({event.actor.email})</span>
          ) : null}
        </Field>
        <Field label="Action">
          <span className="gw-mono" style={{ fontSize: 12 }}>
            {event.action}
          </span>
        </Field>
        <Field label="Target">{targetLabel(event) ?? DASH}</Field>
        <Field label="Approval request">
          {event.request ? (
            <span className="gw-mono" style={{ fontSize: 12 }}>
              {event.request}
            </span>
          ) : (
            /* Not a gap: plenty of changes legitimately skip approval, and the
               ticket requires those to read the same minus this reference. */
            <span style={{ color: "var(--text-3)" }}>not required</span>
          )}
        </Field>
      </div>

      {event.note ? <Field label="Note"><NoteText text={event.note} /></Field> : null}

      {event.changes.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.07em",
              textTransform: "uppercase",
              color: "var(--text-3)",
            }}
          >
            Changed
          </span>
          <ChangeList changes={event.changes} />
        </div>
      ) : null}

      {event.context ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.07em",
              textTransform: "uppercase",
              color: "var(--text-3)",
            }}
          >
            Where from
          </span>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <Field label="IP address">{event.context.ip ?? DASH}</Field>
            <Field label="Client">{event.context.client ?? DASH}</Field>
            <Field label="Session">
              {event.context.session ? (
                <span className="gw-mono" style={{ fontSize: 11 }}>
                  {event.context.session}
                </span>
              ) : (
                DASH
              )}
            </Field>
          </div>
        </div>
      ) : (
        /* Said out loud rather than left blank: a config event has no address
           as a matter of shape, and an absent section reads as missing data. */
        <p style={{ fontSize: 12, color: "var(--text-3)", margin: 0 }}>
          No address or device is recorded for this kind of event — only sign-ins and account
          changes carry one.
        </p>
      )}

      <p style={{ fontSize: 11, color: "var(--text-4)", margin: 0 }}>Event {event.id}</p>
    </div>
  );
}
