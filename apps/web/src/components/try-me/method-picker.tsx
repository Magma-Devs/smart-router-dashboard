"use client";

/**
 * The Try-it drawer's Command picker.
 *
 * Replaces a native `<select>`, which had three problems that stacked into one
 * support ticket:
 *
 *  - it opens on a short list of runnable commands, and the "Show all" escape
 *    hatch sat BELOW it — covered by the OS-drawn popup at the exact moment
 *    someone is scanning and not finding their method;
 *  - twelve entries read as a complete list, because nothing said "of 54";
 *  - and there was no way to type a method name. A Cosmos LCD serves over a
 *    hundred paths.
 *
 * So: a combobox with a search field, the escape hatch as the last row INSIDE
 * the list, and honest section headings that say what each group is and how
 * many it holds. The short list itself is unchanged — it is a promise that
 * everything in it runs as-is, and showing all 54 by default would break it.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  groupByInternalPath,
  type AddonCommand,
  type CatalogInterface,
  type Tier,
} from "./chain-methods";
import { commandKey, friendlyName } from "./method-label";
import {
  partitionByRunnability,
  runnabilityOf,
  searchCommands,
  RUNNABILITY_HINT,
  RUNNABILITY_LABEL,
  RUNNABILITY_ORDER,
  type Runnability,
} from "./method-search";

/** One selectable command, carrying the catalog coordinates the drawer keys
 *  its selection by. `tier` travels with the row so a search can cross tiers:
 *  looking for `debug_traceTransaction` from the Regular tab finds it. */
export interface PickerRow {
  tier: Tier;
  index: number;
  cmd: AddonCommand;
}

interface MethodPickerProps {
  /** Every command the transport can offer, all tiers. */
  rows: PickerRow[];
  /** The tier whose commands show when nothing is being searched. */
  tier: Tier;
  /** The short list this tier opens on — runnable commands, curated names
   *  first. Already capped at HEAD_LIMIT by the caller. */
  head: PickerRow[];
  selected: PickerRow | null;
  iface: CatalogInterface;
  /** Expanded past the short list. Owned by the drawer so it survives the
   *  popup closing — testing ten methods should not cost ten clicks. */
  expanded: boolean;
  onExpandedChange: (next: boolean) => void;
  onSelect: (row: PickerRow) => void;
}

/** What the list renders, flattened so keyboard navigation has one array to
 *  walk. Headings are not navigable; the show-all row is — it is where the
 *  user's arrow keys already are when the short list runs out. */
type Block =
  | { kind: "heading"; id: string; label: string; count: string; title: string }
  | { kind: "path"; id: string; label: string }
  | { kind: "row"; id: string; row: PickerRow }
  | { kind: "show-all"; id: string; total: number };

const TRIGGER: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--line-2)",
  background: "var(--bg)",
  color: "var(--text)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  outline: "none",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: 8,
  textAlign: "left",
};

const POPUP: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 4px)",
  left: 0,
  right: 0,
  zIndex: 10,
  background: "var(--surface)",
  border: "1px solid var(--line-2)",
  borderRadius: 8,
  boxShadow: "0 12px 32px rgba(0,0,0,0.35)",
  overflow: "hidden",
};

const HEADING: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  color: "var(--text-3)",
  padding: "8px 10px 4px",
  display: "flex",
  gap: 6,
  alignItems: "baseline",
};

/** The dot each row carries, so a runnability is readable without opening the
 *  section it came from — which matters in search results, where the ranking
 *  decides the order and there are no sections. */
const DOT_COLOR: Record<Runnability, string> = {
  ready: "var(--ok)",
  "needs-input": "var(--warn)",
  unverified: "var(--text-4)",
};

function IconSearch() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </svg>
  );
}

function IconChevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, marginLeft: "auto", color: "var(--text-3)" }}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function MethodPicker({
  rows,
  tier,
  head,
  selected,
  iface,
  expanded,
  onExpandedChange,
  onSelect,
}: MethodPickerProps) {
  /**
   * Open, or one of two ways of being closed.
   *
   * `dismissed` is a close the user drove — Escape, or picking something — and
   * focus belongs back on the trigger afterwards. `closed` is a click that
   * landed somewhere else, where the user is already reaching for whatever
   * they clicked and pulling the caret back would fight them.
   *
   * One state rather than a boolean plus a flag, so the difference is carried
   * by the value the effect already watches: focus may only be moved from an
   * effect, and an effect that had to reset a flag afterwards would just be a
   * cascading render wearing a different hat.
   */
  const [phase, setPhase] = useState<"closed" | "open" | "dismissed">("closed");
  const open = phase === "open";
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;

  const searching = query.trim() !== "";
  /** Commands in the tier the drawer is on. A search widens to every tier —
   *  someone typing `debug_trace…` from the Regular tab means the method, not
   *  the tab, and the drawer switches tiers when they pick it. */
  const tierRows = useMemo(() => rows.filter((r) => r.tier === tier), [rows, tier]);
  const matches = useMemo(
    () => (searching ? searchCommands(rows, query, iface) : []),
    [searching, rows, query, iface],
  );

  /**
   * The rendered list.
   *
   * Searching: one ranked run, no sections — the ranking is the order, and
   * sections would fight it. Otherwise: the short list with the escape hatch
   * at the end, or, once expanded, the tier split three ways.
   */
  const blocks = useMemo<Block[]>(() => {
    const out: Block[] = [];
    const pushRows = (group: PickerRow[], keyPrefix: string) => {
      // A spec that splits one interface across internal paths (TON's REST
      // /v2 + /v3, AVAX's jsonrpc /C/rpc + /P) keeps those as sub-headings:
      // the same name appears twice and nothing else tells the two apart.
      // Every other chain has one group and this renders nothing.
      for (const [path, subset] of groupByInternalPath(
        group.map((row) => ({ cmd: row.cmd, row })),
      )) {
        if (path !== null) out.push({ kind: "path", id: `${keyPrefix}-p-${path}`, label: path });
        for (const entry of subset) {
          out.push({
            kind: "row",
            id: `${baseId}-${entry.row.tier}-${entry.row.index}`,
            row: entry.row,
          });
        }
      }
    };

    if (searching) {
      pushRows(matches, "q");
      return out;
    }

    if (!expanded && head.length > 0) {
      out.push({
        kind: "heading",
        id: `${baseId}-h-ready`,
        label: RUNNABILITY_LABEL.ready,
        count: `showing ${head.length} of ${tierRows.length}`,
        title: RUNNABILITY_HINT.ready,
      });
      pushRows(head, "head");
      if (tierRows.length > head.length) {
        out.push({ kind: "show-all", id: `${baseId}-showall`, total: tierRows.length });
      }
      return out;
    }

    const parts = partitionByRunnability(tierRows.map((row) => ({ cmd: row.cmd, row })));
    for (const kind of RUNNABILITY_ORDER) {
      const group = parts[kind];
      if (group.length === 0) continue;
      out.push({
        kind: "heading",
        id: `${baseId}-h-${kind}`,
        label: RUNNABILITY_LABEL[kind],
        count: String(group.length),
        title: RUNNABILITY_HINT[kind],
      });
      pushRows(
        group.map((entry) => entry.row),
        kind,
      );
    }
    return out;
  }, [searching, matches, expanded, head, tierRows, baseId]);

  /** Only these answer to the arrow keys. */
  const navigable = useMemo(
    () =>
      blocks.filter(
        (b): b is Extract<Block, { kind: "row" | "show-all" }> =>
          b.kind === "row" || b.kind === "show-all",
      ),
    [blocks],
  );
  /** id → position in `navigable`, so rendering a row does not re-scan the
   *  list to find its own index. A Cosmos LCD lists over a hundred paths. */
  const navAt = useMemo(
    () => new Map(navigable.map((b, i) => [b.id, i])),
    [navigable],
  );

  /** The highlight, clamped to what is actually on screen. Derived rather
   *  than corrected in an effect: a query that narrows the list from forty
   *  rows to two must not spend a render pointing past the end of it. */
  const activeAt = navigable.length === 0 ? -1 : Math.min(activeIndex, navigable.length - 1);

  const close = useCallback(() => {
    setPhase("dismissed");
    setQuery("");
  }, []);

  const openList = useCallback(() => {
    // Land on the current selection so arrowing starts from where the user
    // is. `navigable` does not depend on `open`, so it is already the list
    // that is about to be shown.
    const at = selected
      ? navigable.findIndex(
          (b) =>
            b.kind === "row" &&
            b.row.tier === selected.tier &&
            b.row.index === selected.index,
        )
      : -1;
    setActiveIndex(at >= 0 ? at : 0);
    setPhase("open");
  }, [navigable, selected]);

  /* Escape belongs to the list while the list is open. The drawer closes
     itself on Escape from a window-level listener, so an open picker would
     otherwise take the whole drawer down with it. Capture phase runs before
     any bubble-phase listener, which makes this independent of where the
     portal sits in the tree. A second Escape, with the list already shut,
     reaches the drawer and closes that — which is what it should do. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  /* Anywhere outside closes. The drawer itself is a portal and the panel
     scrolls, so a stray click has plenty of places to land. */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current?.contains(e.target as Node)) return;
      setPhase("closed");
      setQuery("");
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  /* The one place focus is moved — refs may only be read from an effect. */
  useEffect(() => {
    if (phase === "open") inputRef.current?.focus();
    else if (phase === "dismissed") triggerRef.current?.focus();
  }, [phase]);

  /* Keep the highlighted row in view while arrowing through a long list. */
  useEffect(() => {
    if (!open) return;
    const item = navigable[activeAt];
    if (!item) return;
    listRef.current
      ?.querySelector(`[data-id="${CSS.escape(item.id)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, activeAt, navigable]);

  const commit = useCallback(
    (block: Extract<Block, { kind: "row" | "show-all" }>) => {
      if (block.kind === "show-all") {
        // Stay open: expanding is a step toward picking, not the pick. The
        // list keeps focus on its own — see the mousedown guard below.
        onExpandedChange(true);
        return;
      }
      onSelect(block.row);
      close();
    },
    [onExpandedChange, onSelect, close],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (navigable.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((activeAt + step + navigable.length) % navigable.length);
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActiveIndex(e.key === "Home" ? 0 : Math.max(0, navigable.length - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = navigable[activeAt];
      if (item) commit(item);
      return;
    }
    if (e.key === "Tab") close();
  };

  const activeId = navigable[activeAt]?.id;
  const triggerLabel = selected
    ? (() => {
        const name = friendlyName(iface, selected.cmd);
        const id = commandKey(iface, selected.cmd);
        return name ? `${name} · ${id}` : id;
      })()
    : "Select a method";

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        onClick={() => (open ? close() : openList())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            openList();
          }
        }}
        style={TRIGGER}
      >
        {selected && (
          <span
            aria-hidden="true"
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              flexShrink: 0,
              background: DOT_COLOR[runnabilityOf(selected.cmd)],
            }}
          />
        )}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {triggerLabel}
        </span>
        <IconChevron />
      </button>

      {open && (
        <div style={POPUP}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "8px 10px",
              borderBottom: "1px solid var(--line)",
              color: "var(--text-3)",
            }}
          >
            <IconSearch />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onKeyDown}
              placeholder={`Search all ${rows.length} methods…`}
              spellCheck={false}
              autoComplete="off"
              type="text"
              aria-label="Search methods"
              aria-controls={listboxId}
              aria-activedescendant={activeId}
              style={{
                flex: 1,
                border: "none",
                outline: "none",
                background: "transparent",
                color: "var(--text)",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                padding: 0,
              }}
            />
          </div>

          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label="Methods"
            onMouseDown={(e) => e.preventDefault()}
            style={{ maxHeight: 300, overflowY: "auto", padding: "2px 0 6px" }}
          >
            {navigable.length === 0 ? (
              <div style={{ padding: "14px 12px", fontSize: 11.5, color: "var(--text-3)", lineHeight: 1.5 }}>
                No method matches <span className="gw-mono" style={{ color: "var(--text-2)" }}>{query.trim()}</span>.
                <br />
                It is not in this chain&apos;s catalog for this interface.
              </div>
            ) : (
              blocks.map((block) => {
                if (block.kind === "heading") {
                  return (
                    <div key={block.id} style={HEADING} title={block.title}>
                      <span>{block.label}</span>
                      <span style={{ fontWeight: 500, letterSpacing: 0, textTransform: "none", color: "var(--text-4)" }}>
                        {block.count}
                      </span>
                    </div>
                  );
                }
                if (block.kind === "path") {
                  return (
                    <div
                      key={block.id}
                      className="gw-mono"
                      style={{ fontSize: 10, color: "var(--text-4)", padding: "4px 10px 2px" }}
                    >
                      {block.label}
                    </div>
                  );
                }
                const at = navAt.get(block.id) ?? -1;
                const active = at === activeAt;
                if (block.kind === "show-all") {
                  return (
                    <div
                      key={block.id}
                      data-id={block.id}
                      role="option"
                      aria-selected={false}
                      onMouseEnter={() => setActiveIndex(at)}
                      onClick={() => commit(block)}
                      style={{
                        margin: "4px 6px 0",
                        padding: "7px 8px",
                        borderRadius: 6,
                        borderTop: "1px solid var(--line)",
                        fontSize: 11.5,
                        fontWeight: 600,
                        color: "var(--brand)",
                        cursor: "pointer",
                        background: active ? "var(--hover)" : "transparent",
                      }}
                    >
                      Show all {block.total} methods
                    </div>
                  );
                }
                const { row } = block;
                const isSelected =
                  selected !== null &&
                  row.tier === selected.tier &&
                  row.index === selected.index;
                const name = friendlyName(iface, row.cmd);
                const id = commandKey(iface, row.cmd);
                const kind = runnabilityOf(row.cmd);
                return (
                  <div
                    key={block.id}
                    data-id={block.id}
                    role="option"
                    aria-selected={isSelected}
                    onMouseEnter={() => setActiveIndex(at)}
                    onClick={() => commit(block)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      margin: "0 6px",
                      padding: "6px 8px",
                      borderRadius: 6,
                      cursor: "pointer",
                      background: active ? "var(--hover-2)" : "transparent",
                      color: isSelected ? "var(--text)" : "var(--text-2)",
                    }}
                  >
                    <span
                      aria-hidden="true"
                      title={RUNNABILITY_LABEL[kind]}
                      style={{ width: 6, height: 6, borderRadius: 3, flexShrink: 0, background: DOT_COLOR[kind] }}
                    />
                    <span
                      className="gw-mono"
                      style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    >
                      {name ? `${name} · ${id}` : id}
                    </span>
                    {/* A search reaches across tiers, so a result from another
                        one has to say which — picking it moves the drawer. */}
                    {searching && row.tier !== tier && (
                      <span className="gw-tag" style={{ fontSize: 9.5, marginLeft: "auto", textTransform: "capitalize" }}>
                        {row.tier}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
