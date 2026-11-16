"use client";

import { Fragment } from "react";
import type { AuditChangeRecord, AuditEventRecord } from "@sr/shared";
import { LocalTime } from "@/components/gateway/LocalTime";
import { eventLabel, groupLabel } from "@/components/audit/event-labels";
import { APPROVALS_WRITTEN } from "@/components/audit/filter-groups";
import { fmtDateTimeUtc, isoUtc, splitInstants } from "@/lib/datetime";

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
  return <span className={`gw-tag ${GROUP_TONE[group] ?? ""}`}>{groupLabel(group)}</span>;
}

/** The detail sheet's heading: the event's name, then who and which group.
 *  Its code is in the sheet's Action field. */
export function auditSheetHeading(event: AuditEventRecord): { title: string; sub: string } {
  return {
    title: eventLabel(event.action),
    sub: `${event.actor.name} · ${groupLabel(event.group)}`,
  };
}

/** What the table shows for a target: the name it had at the time, or its
 *  kind when it was recorded without one. Its id is in the detail sheet. */
export function targetName(event: AuditEventRecord): string | null {
  if (!event.target) return null;
  return event.target.name || event.target.type;
}

/** The actor's address when it says more than their name. A failed sign-in
 *  records the typed address as both, and one copy is enough. */
export function actorEmail(actor: AuditEventRecord["actor"]): string | null {
  const { name, email } = actor;
  if (!email || email.trim().toLowerCase() === name.trim().toLowerCase()) return null;
  return email;
}

/**
 * What the detail sheet's Approval request field shows: the request a change
 * came from, "not required" for a config change that skipped approval, or no
 * field at all. Until approval events are written nothing is approved, so only
 * a row that names a request shows it.
 */
export function approvalField(
  event: AuditEventRecord,
  approvalsWritten: boolean = APPROVALS_WRITTEN,
): { request: string } | "not required" | null {
  if (event.request) return { request: event.request };
  return approvalsWritten && event.group === "config" ? "not required" : null;
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

const SUB = { display: "block", fontSize: 11, color: "var(--text-3)" } as const;

/** The full row, for the detail sheet. */
export function AuditDetail({ event }: { event: AuditEventRecord }) {
  const email = actorEmail(event.actor);
  const approval = approvalField(event);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Field label="Time">
          {/* In full, with its zone, and again in UTC: the zone the emails
              and the CSV use, so this row can be matched with either. */}
          <LocalTime t={event.time} format="dateTime" className="gw-mono" style={{ fontSize: 12 }} />
          <time dateTime={isoUtc(event.time)} className="gw-mono" style={{ ...SUB, fontSize: 12 }}>
            {fmtDateTimeUtc(event.time)}
          </time>
        </Field>
        <Field label="Source">{event.source}</Field>
        <Field label="Actor">
          {event.actor.name}
          {email ? <span style={{ color: "var(--text-3)" }}> ({email})</span> : null}
        </Field>
        <Field label="Action">
          <span className="gw-mono" style={{ fontSize: 12 }}>
            {event.action}
          </span>
        </Field>
        <Field label="Target">
          {event.target ? (
            <>
              {targetName(event)}
              <span className="gw-mono" style={SUB}>
                {event.target.type} · {event.target.id}
              </span>
            </>
          ) : (
            DASH
          )}
        </Field>
        {approval ? (
          <Field label="Approval request">
            {approval === "not required" ? (
              /* Not a gap: plenty of changes legitimately skip approval, and the
                 ticket requires those to read the same minus this reference. */
              <span style={{ color: "var(--text-3)" }}>not required</span>
            ) : (
              <span className="gw-mono" style={{ fontSize: 12 }}>
                {approval.request}
              </span>
            )}
          </Field>
        ) : null}
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
                <span
                  className="gw-mono"
                  style={{ fontSize: 12 }}
                  title="A reference to the sign-in. Every entry from the same sign-in shows the same one."
                >
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
          No address or device is recorded for this kind of event. Only sign-ins and account changes
          carry one.
        </p>
      )}

      <p style={{ fontSize: 11, color: "var(--text-4)", margin: 0 }}>Event {event.id}</p>
    </div>
  );
}
