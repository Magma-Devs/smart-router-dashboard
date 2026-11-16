"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { menuFocusAfter, type RowAction } from "./team-state";

/**
 * One "..." button per table row, opening that row's actions as a menu, so a
 * row is as wide at 1024 px as at full width and every action stays in reach.
 *
 * The ARIA menu pattern: Enter, Space or an arrow opens it on an item; arrows,
 * Home and End move; Escape closes it and returns focus to the button; Tab or
 * a click anywhere else closes it. It is portalled to <body>, so the table
 * card's clipping cannot cut it off, and a scroll or resize closes it.
 */
export function RowActions({ label, actions }: { label: string; actions: RowAction[] }) {
  const [open, setOpen] = useState<null | "first" | "last">(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();

  function show(focus: "first" | "last") {
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    setAnchor(r);
    setOpen(focus);
  }

  function close(returnFocus: boolean) {
    setOpen(null);
    if (returnFocus) trigger.current?.focus();
  }

  // Placed once it has a size, straight on the DOM, so it appears where it
  // belongs on its first paint: under the button, right edges aligned, or
  // above it when there is no room below.
  useLayoutEffect(() => {
    const el = menu.current;
    if (!open || !anchor || !el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.min(Math.max(anchor.right - w, 8), window.innerWidth - w - 8);
    const below = anchor.bottom + 4;
    const top =
      below + h > window.innerHeight - 8 && anchor.top - 4 - h >= 8 ? anchor.top - 4 - h : below;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.visibility = "visible";
    items.current[open === "last" ? actions.length - 1 : 0]?.focus();
  }, [open, anchor, actions.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menu.current?.contains(t) || trigger.current?.contains(t)) return;
      setOpen(null);
    };
    const onScroll = (e: Event) => {
      if (menu.current?.contains(e.target as Node)) return;
      setOpen(null);
    };
    const onResize = () => setOpen(null);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  if (actions.length === 0) return null;

  function onMenuKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      // Ours, not a dialog's: nothing else should close on this Escape.
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key === "Tab") {
      setOpen(null);
      return;
    }
    const current = items.current.findIndex((el) => el === document.activeElement);
    const next = menuFocusAfter(e.key, current, actions.length);
    if (next === null) return;
    e.preventDefault();
    items.current[next]?.focus();
  }

  function choose(action: RowAction) {
    if (action.disabled) return;
    // Focus goes back to the button first: the dialog an action opens returns
    // focus to whatever had it, and the menu item is about to be gone.
    close(true);
    action.onSelect();
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="gw-btn gw-btn--ghost"
        style={{ padding: "4px 8px" }}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={!!open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : show("first"))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            show(e.key === "ArrowUp" ? "last" : "first");
          }
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      {open &&
        anchor &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-label={label}
            onKeyDown={onMenuKey}
            style={{
              position: "fixed",
              left: 0,
              top: 0,
              visibility: "hidden",
              zIndex: 60,
              minWidth: 170,
              padding: 4,
              borderRadius: 10,
              background: "var(--surface-2)",
              border: "1px solid var(--line-2)",
              boxShadow: "0 12px 32px rgba(0,0,0,0.35)",
              display: "grid",
              gap: 2,
            }}
          >
            {actions.map((a, i) => (
              <button
                key={a.label}
                ref={(el) => {
                  items.current[i] = el;
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={a.disabled || undefined}
                title={a.hint}
                onClick={() => choose(a)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "7px 10px",
                  borderRadius: 7,
                  border: "none",
                  background: "transparent",
                  fontFamily: "inherit",
                  fontSize: 12.5,
                  cursor: a.disabled ? "not-allowed" : "pointer",
                  color: a.disabled ? "var(--text-4)" : a.danger ? "var(--err)" : "var(--text)",
                }}
                onMouseEnter={(e) => e.currentTarget.focus()}
                onFocus={(e) => (e.currentTarget.style.background = "var(--hover-2)")}
                onBlur={(e) => (e.currentTarget.style.background = "transparent")}
              >
                {a.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
