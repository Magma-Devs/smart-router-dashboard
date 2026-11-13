"use client";

import { useMemo, useState } from "react";
import { AUDIT_GROUPS, type AuditEventRecord } from "@sr/shared";
import { SideSheet } from "@/components/gateway/SideSheet";
import {
  AuditDetail,
  ChangeList,
  GroupTag,
  NoteText,
  targetLabel,
} from "@/components/audit/bits";
import { LocalTime, ZoneLabel } from "@/components/gateway/LocalTime";
import {
  auditExportPath,
  EMPTY_FILTERS,
  hasAnyFilter,
  useAuditFeed,
  type AuditFeed,
  type AuditFilters,
} from "@/components/audit/useAuditFeed";
import {
  AUDIT_PAGE_SIZES,
  auditPositionLabel,
  newerPage,
  newestPage,
  olderPage,
  useAuditLocation,
  withFilters,
  withPageSize,
  type AuditLocation,
} from "@/components/audit/audit-location";
import { useFilterTyping, type TextFilter } from "@/components/audit/filter-typing";
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

/** "7 new entries since this page was the newest", "100+ new entries …". */
function arrivedLine({ count, more }: { count: number; more: boolean }): string {
  const entries = count === 1 && !more ? "entry" : "entries";
  return `${count}${more ? "+" : ""} new ${entries} since this page was the newest`;
}

/**
 * Where the reader is and the way to the next page either side — above the
 * table and again below it, so a hundred rows down is not a scroll back up.
 *
 * Older and Newer read from the rows on screen, so they wait while a page is
 * on its way: those positions belong to the page being replaced.
 */
function Pager({
  feed,
  location,
  move,
  sizes,
}: {
  feed: AuditFeed;
  location: AuditLocation;
  move: (next: AuditLocation) => void;
  sizes?: boolean;
}) {
  const page = feed.page;
  if (!page) return null;
  const busy = feed.loading;
  const label = auditPositionLabel(location, {
    count: page.items.length,
    atNewest: page.atNewest,
    hasOlder: page.hasOlder,
  });
  const end = !page.atNewest && !page.hasOlder;
  return (
    <div
      className="gw-row"
      style={{ justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}
    >
      <span style={{ fontSize: 13, fontWeight: 600 }} aria-live="polite">
        {label}
        {end ? (
          <span style={{ fontWeight: 400, color: "var(--text-3)" }}> · end of the log</span>
        ) : null}
      </span>
      <div className="gw-row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {sizes ? (
          <div className="gw-segctl" role="group" aria-label="Rows per page">
            {AUDIT_PAGE_SIZES.map((size) => (
              <button
                key={size}
                className={size === location.size ? "on" : ""}
                aria-pressed={size === location.size}
                onClick={() => move(withPageSize(location, size))}
                title={`${size} rows per page`}
              >
                {size}
              </button>
            ))}
          </div>
        ) : null}
        <button
          className="gw-btn"
          onClick={() => move(newestPage(location))}
          disabled={busy || page.atNewest}
        >
          Newest
        </button>
        <button
          className="gw-btn"
          onClick={() => {
            // Page 1 with entries above it: those are what Newer would show,
            // and the newest page shows them whole.
            if (page.arrived || !page.startCursor) move(newestPage(location));
            else move(newerPage(location, page.startCursor));
          }}
          disabled={busy || !page.hasNewer}
        >
          ← Newer
        </button>
        <button
          className="gw-btn"
          onClick={() => page.endCursor && move(olderPage(location, page.endCursor))}
          disabled={busy || !page.hasOlder || !page.endCursor}
        >
          Older →
        </button>
      </div>
    </div>
  );
}

export function AuditView() {
  const [selected, setSelected] = useState<AuditEventRecord | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const { location, go } = useAuditLocation();
  const { filters } = location;
  const feed = useAuditFeed(location);
  // Person and Object id reach the URL after a pause in typing, and Person
  // only once the api would take it — see `filter-typing.ts`.
  const { typing, drafts } = useFilterTyping(go);

  const filtered = useMemo(() => hasAnyFilter(filters), [filters]);
  // A filter change starts again at the newest page: the cursor on screen
  // belongs to the old filter set, and the api refuses it under a new one.
  const set = (patch: Partial<AuditFilters>) => {
    typing.endRun();
    go(withFilters(location, { ...filters, ...patch }), "push");
  };
  const clear = () => {
    typing.reset();
    go(withFilters(location, EMPTY_FILTERS), "push");
  };
  const move = (next: AuditLocation) => {
    typing.reset();
    go(next, "push");
  };
  /** A typed box's props: it shows its draft while there is one. */
  const typed = (field: TextFilter) => ({
    value: drafts[field] ?? filters[field],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => typing.type(field, e.target.value),
    onBlur: () => typing.finish(field),
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") typing.finish(field);
    },
  });
  const atNewest = feed.page?.atNewest ?? location.position.kind === "newest";

  return (
    <div className="gw-page">
      <div className="gw-row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ margin: 0 }}>Audit log</h1>
        <div className="gw-row" style={{ gap: 8 }}>
          {/* Exports what the filters currently say, not just the page on
              screen — paging is a reading convenience, and a file that
              stopped where someone happened to stop reading would be a
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
            title="Re-read this page"
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
              {...typed("actor")}
            />
          </FilterField>

          <FilterField label="Object id">
            <input className="gw-input" placeholder="ep_8143" {...typed("targetId")} />
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
        location.position.kind === "newest" ? (
          <EmptyState title="Could not load the audit log" body={feed.error} />
        ) : (
          <EmptyState
            title="Could not open this page of the log"
            body={
              feed.badPosition
                ? "The link points at a place in the log that these filters can't reach — it was edited, or its filters were changed after it was made."
                : feed.error
            }
            action={
              <button className="gw-btn" onClick={() => move(newestPage(location))}>
                Go to the newest entries
              </button>
            }
          />
        )
      ) : !feed.page || (feed.loading && feed.items.length === 0) ? (
        <div className="gw-card" style={{ color: "var(--text-3)", fontSize: 13 }}>
          Loading…
        </div>
      ) : feed.items.length === 0 && !atNewest ? (
        <EmptyState
          title="Nothing on this page"
          body="No entries lie past this point with these filters."
          action={
            <button className="gw-btn" onClick={() => move(newestPage(location))}>
              Go to the newest entries
            </button>
          }
        />
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
          {feed.page.arrived ? (
            <div
              className="gw-card"
              style={{
                marginBottom: 12,
                padding: "10px 14px",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <span style={{ fontSize: 13 }}>{arrivedLine(feed.page.arrived)}</span>
              <button
                className="gw-btn gw-btn--primary"
                onClick={() => move(newestPage(location))}
                disabled={feed.loading}
              >
                Show
              </button>
            </div>
          ) : null}

          <div style={{ marginBottom: 12 }}>
            <Pager feed={feed} location={location} move={move} sizes />
          </div>

          <div
            className="gw-card"
            style={{
              padding: 0,
              overflow: "hidden",
              opacity: feed.loading ? 0.55 : 1,
              transition: "opacity 0.15s",
            }}
            aria-busy={feed.loading}
          >
            <table className="gw-table">
              <thead>
                <tr>
                  {/* The reader's own clock, named; each time's tooltip gives it in UTC. */}
                  <th style={{ width: 148 }}>Time <ZoneLabel /></th>
                  <th style={{ width: 190 }}>Actor</th>
                  <th>Action</th>
                  <th>Target</th>
                </tr>
              </thead>
              {feed.items.map((event) => {
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
                          <LocalTime t={event.time} format="date" />
                        </div>
                        <div className="gw-mono" style={{ fontSize: 11, color: "var(--text-3)" }}>
                          <LocalTime t={event.time} format="timeSec" />
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
                            <NoteText text={event.note} />
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

          {/* Newer and Older rather than page numbers to pick: a page is the
              rows next to a row, not an offset, so there is no page 7 to jump
              to — and no offset for a new entry at the head to shift. */}
          <div style={{ marginTop: 12 }}>
            <Pager feed={feed} location={location} move={move} />
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
