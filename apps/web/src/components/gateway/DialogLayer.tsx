"use client";

import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { TABBABLE, isTopLayer, lockScroll, pushLayer, wrapFocus } from "@/lib/dialog-layer";

/**
 * Every modal surface renders through here: `Modal`, `SideSheet`, the
 * endpoint detail sheet. The Try-it drawer draws its own backdrop and panel
 * and calls `useDialogLayer` for the same behaviour.
 *
 * The layer is portaled to <body>. The page content sits in the Shell's
 * `.fade-in` wrapper, whose entry animation leaves `transform` at an identity
 * matrix rather than `none`. Any transform makes an element the containing
 * block of its `position: fixed` descendants and a stacking context, so a
 * backdrop rendered inside the page covers only the page's own box: not the
 * top bar, not the sidebar, and not the viewport below short content. At
 * <body> the backdrop's `inset: 0` is the viewport.
 */
export interface DialogLayerProps {
  /** The full-viewport backdrop: `gw-modal-bg`, `gw-sheet-bg`, … */
  backdropClassName: string;
  /** The dialog panel itself: `gw-modal`, `gw-sheet`, … */
  panelClassName: string;
  panelStyle?: CSSProperties;
  onDismiss: () => void;
  /** False: a click on the backdrop and Escape leave it open. The panel's
   *  own close button is the way out. */
  dismissible?: boolean;
  /** The id of the element holding the dialog's title. */
  labelledBy?: string;
  children: ReactNode;
}

const subscribeNever = () => () => {};

export function DialogLayer({
  backdropClassName,
  panelClassName,
  panelStyle,
  onDismiss,
  dismissible = true,
  labelledBy,
  children,
}: DialogLayerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // False on the server and while hydrating: there is no <body> to portal to.
  const onClient = useSyncExternalStore(subscribeNever, () => true, () => false);
  useDialogLayer(panelRef, { active: onClient, onEscape: dismissible ? onDismiss : null });
  if (!onClient) return null;
  return createPortal(
    <div className={backdropClassName} onClick={dismissible ? onDismiss : undefined}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={panelClassName}
        style={panelStyle}
        // React events bubble through the component tree, not the DOM, so a
        // click in the panel would otherwise reach the backdrop and whatever
        // row or card rendered the dialog.
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

function tabbablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.getClientRects().length > 0);
}

/**
 * A modal layer's behaviour, for the panel `panelRef` points at, while
 * `active`:
 * - the page behind does not scroll;
 * - focus moves into the panel (unless a control in it already took it) and
 *   Tab cycles inside it; focus that lands outside is brought back;
 * - Escape calls `onEscape` (null: Escape does nothing);
 * - on close, focus goes back to what had it when the layer opened.
 *
 * With layers open over each other, Escape and the trap belong to the top one.
 */
export function useDialogLayer(
  panelRef: RefObject<HTMLElement | null>,
  { active = true, onEscape }: { active?: boolean; onEscape?: (() => void) | null },
): void {
  // Read in the first render, before a control in the dialog can take focus
  // with autoFocus: this is the button that opened it.
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document === "undefined" || !(document.activeElement instanceof HTMLElement)
      ? null
      : document.activeElement,
  );
  // The newest handler, without re-running the effect (and re-locking, and
  // re-focusing) every time the caller renders a new closure.
  const escape = useEffectEvent((e: KeyboardEvent) => {
    if (!onEscape) return;
    e.preventDefault();
    onEscape();
  });

  useEffect(() => {
    if (!active) return;
    const layer = pushLayer();
    const release = lockScroll(document.body.style, window.innerWidth - document.documentElement.clientWidth);
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });

    const onKeyDown = (e: KeyboardEvent) => {
      const p = panelRef.current;
      if (!p || !isTopLayer(layer.id)) return;
      if (e.key === "Escape") {
        // A control inside that handles Escape itself (an open list) says so.
        if (!e.defaultPrevented && !e.isComposing) escape(e);
        return;
      }
      if (e.key !== "Tab") return;
      const focused = document.activeElement instanceof HTMLElement && p.contains(document.activeElement)
        ? document.activeElement
        : null;
      const next = wrapFocus(tabbablesIn(p), focused, e.shiftKey, p);
      if (next) {
        e.preventDefault();
        next.focus();
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      const p = panelRef.current;
      if (!p || !isTopLayer(layer.id) || !(e.target instanceof Node) || p.contains(e.target)) return;
      (tabbablesIn(p)[0] ?? p).focus({ preventScroll: true });
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
      layer.remove();
      release();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [active, opener, panelRef]);
}
