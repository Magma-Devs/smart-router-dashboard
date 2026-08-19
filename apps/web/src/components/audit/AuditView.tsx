"use client";

import { useMemo, useState } from "react";
import { AUDIT_GROUPS, type AuditEventRecord } from "@sr/shared";
import { SideSheet } from "@/components/gateway/SideSheet";
import {
  AuditDetail,
  ChangeList,
  GroupTag,
  eventDateParts,
  targetLabel,
} from "@/components/audit/bits";
import {
  auditExportPath,
  EMPTY_FILTERS,
  hasAnyFilter,
  useAuditFeed,
  type AuditFilters,
} from "@/components/audit/useAuditFeed";
import { apiDownload } from "@/lib/api-client";

/**
 * The audit log — MAG-2770.
 *
 * Its own page rather than a tab on Team. The record is org-wide and the ticket
 * puts it in front of *every* role including read-only, whereas Team is the
 * people-management screen and is admin-gated. Filing a surface everyone may
 * read behind one only admins may open would have been a slow mistake to undo.
 *
 * Read-only everywhere, by construction: nothing on this page or in
 * `bits.tsx` writes, because the ticket's rule is that nobody removes or
 * alters a row through the product, admins included.
 */

const LEDE = "Every recorded action — who did what, and when. Read-only for everyone.";

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span className="gw-label">{label}</span>
      {children}
    </label>
  );
}

function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="gw-empty" style={{ minHeight: 280 }}>
      <h2>{title}</h2>
      <p style={{ fontSize: 13, color: "var(--text-3)", maxWidth: 460, margin: "0 0 14px" }}>
        {body}
      </p>
      {action}
    </div>
  );
}

export function AuditView() {
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<AuditEventRecord | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const feed = useAuditFeed(filters);

  const filtered = useMemo(() => hasAnyFilter(filters), [filters]);
  const set = (patch: Partial<AuditFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const clear = () => setFilters(EMPTY_FILTERS);

  return (
    <div className="gw-page">
      <div className="gw-row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
        <div>
          <h1>Audit log</h1>
          <p className="lede">{LEDE}</p>
        </div>
        <div className="gw-row" style={{ gap: 8 }}>
          {/* Exports what the filters currently say, not just the rows already
              loaded — "Load more" is a reading convenience, and a file that
              stopped where someone happened to stop scrolling would be a
              quietly incomplete record. */}
          <button
            className="gw-btn"
            onClick={async () => {
              setExporting(true);
              setExportError(null);
              try {
                await apiDownload(auditExportPath(filters), "audit-log.csv");
              } catch (err) {
                setExportError(err instanceof Error ? err.message : "Export failed");
              } finally {
                setExporting(false);
              }
            }}
            disabled={exporting || feed.unavailable}
            title="Download every event matching these filters"
          >
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
          <button
            className="gw-btn"
            onClick={feed.refresh}
            disabled={feed.loading}
            title="Re-read the log from the top"
          >
            Refresh
          </button>
        </div>
      </div>

      {exportError ? (
        <div className="gw-card" style={{ marginBottom: 16, borderColor: "var(--err)" }}>
          <span style={{ fontSize: 13, color: "var(--err)" }}>Export failed: {exportError}</span>
        </div>
      ) : null}

      {/* Filters stay mounted even when the feed is empty — hiding them is how
          someone ends up staring at "no events" with a filter they can't see. */}
      <div className="gw-card" style={{ marginBottom: 16 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 12,
            alignItems: "end",
          }}
        >
          <FilterField label="Group">
            <select
              className="gw-input"
              value={filters.group}
              onChange={(e) => set({ group: e.target.value })}
            >
              <option value="">All groups</option>
              {AUDIT_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </FilterField>

          {/* Labelled as an address rather than "person": the API also accepts a
              user id, but a box that rejects "Dana" is a bad control. */}
          <FilterField label="Person (email)">
            <input
              className="gw-input"
              type="email"
              placeholder="dana@customer.com"
              value={filters.actor}
              onChange={(e) => set({ actor: e.target.value })}
            />
          </FilterField>

          <FilterField label="Object id">
            <input
              className="gw-input"
              placeholder="ep_8143"
              value={filters.targetId}
              onChange={(e) => set({ targetId: e.target.value })}
            />
          </FilterField>

          <FilterField label="From">
            <input
              className="gw-input"
              type="date"
              value={filters.from}
              onChange={(e) => set({ from: e.target.value })}
            />
          </FilterField>

          <FilterField label="To">
            <input
              className="gw-input"
              type="date"
              value={filters.to}
              onChange={(e) => set({ to: e.target.value })}
            />
          </FilterField>
        </div>

        {filtered ? (
          <div className="gw-row" style={{ justifyContent: "flex-end", marginTop: 12 }}>
            <button className="gw-btn gw-btn--ghost" onClick={clear}>
              Clear filters
            </button>
          </div>
        ) : null}
      </div>

      {feed.unavailable ? (
        <EmptyState
          title="No audit log on this deployment"
          body="The log is stored in Postgres and only exists when the dashboard runs with accounts enabled. Set AUTH_MODE=enabled to turn it on."
        />
      ) : feed.error ? (
        <EmptyState title="Could not load the audit log" body={feed.error} />
      ) : feed.loading ? (
        <div className="gw-card" style={{ color: "var(--text-3)", fontSize: 13 }}>
          Loading…
        </div>
      ) : feed.items.length === 0 ? (
        /* Two different nothings. Collapsing them would tell a reader with a
           narrow filter that nothing ever happened, which is the one thing an
           audit log must never imply. */
        filtered ? (
          <EmptyState
            title="No events match these filters"
            body="Nothing was recorded for this combination. Widen the range or clear the filters to see the whole log."
            action={
              <button className="gw-btn" onClick={clear}>
                Clear filters
              </button>
            }
          />
        ) : (
          <EmptyState
            title="Nothing recorded yet"
            body="Sign-ins, account changes and configuration changes appear here as they happen. The log starts empty on a new deployment."
          />
        )
      ) : (
        <>
          <div className="gw-card" style={{ padding: 0, overflow: "hidden" }}>
            <table className="gw-table">
              <thead>
                <tr>
                  <th style={{ width: 148 }}>Time (UTC)</th>
                  <th style={{ width: 190 }}>Actor</th>
                  <th>Action</th>
                  <th>Target</th>
                </tr>
              </thead>
              {feed.items.map((event) => {
                const { date, time } = eventDateParts(event.time);
                const open = () => setSelected(event);
                return (
                  // One <tbody> per event so the stacked changes belong to their
                  // row rather than floating as a sibling.
                  <tbody key={event.id}>
                    <tr
                      onClick={open}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          open();
                        }
                      }}
                      tabIndex={0}
                      style={{ cursor: "pointer" }}
                      title="Open the full record"
                    >
                      <td>
                        <div className="gw-mono" style={{ fontSize: 12 }}>
                          {date}
                        </div>
                        <div className="gw-mono" style={{ fontSize: 11, color: "var(--text-3)" }}>
                          {time}
                        </div>
                      </td>
                      <td>
                        <div style={{ fontWeight: 550 }}>{event.actor.name}</div>
                        {event.actor.email ? (
                          <div style={{ fontSize: 11, color: "var(--text-3)" }}>
                            {event.actor.email}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <div
                          className="gw-mono"
                          style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}
                        >
                          {event.action}
                          <GroupTag group={event.group} />
                        </div>
                        {event.note ? (
                          <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 2 }}>
                            {event.note}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {targetLabel(event) ? (
                          <span style={{ fontSize: 12 }}>{targetLabel(event)}</span>
                        ) : (
                          <span style={{ color: "var(--text-4)" }}>—</span>
                        )}
                        {event.request ? (
                          <div
                            className="gw-mono"
                            style={{ fontSize: 11, color: "var(--text-3)", marginTop: 2 }}
                          >
                            {event.request}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                    {event.changes.length > 0 ? (
                      <tr onClick={open} style={{ cursor: "pointer" }}>
                        <td />
                        <td colSpan={3} style={{ paddingTop: 0, paddingBottom: 12 }}>
                          <ChangeList changes={event.changes} />
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                );
              })}
            </table>
          </div>

          {/* "Load more" rather than page numbers: the API is cursor-based and
              cannot jump, so offering a page picker would promise something it
              can't do. */}
          <div className="gw-row" style={{ justifyContent: "center", marginTop: 16 }}>
            {feed.hasMore ? (
              <button className="gw-btn" onClick={feed.loadMore} disabled={feed.loadingMore}>
                {feed.loadingMore ? "Loading…" : "Load more"}
              </button>
            ) : (
              <span style={{ fontSize: 12, color: "var(--text-4)" }}>
                {feed.items.length} event{feed.items.length === 1 ? "" : "s"} — end of the log
              </span>
            )}
          </div>
        </>
      )}

      <SideSheet
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.action ?? ""}
        sub={selected ? `${selected.actor.name} · ${selected.group}` : undefined}
      >
        {selected ? <AuditDetail event={selected} /> : null}
      </SideSheet>
    </div>
  );
}
