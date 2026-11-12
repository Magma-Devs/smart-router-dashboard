/**
 * The parts of a modal layer that hold no React: which layer is on top, the
 * page's scroll lock, and where Tab goes at the edges of a dialog.
 *
 * `useDialogLayer` (components/gateway/DialogLayer.tsx) is the only caller.
 * They live here, free of the DOM where they can be, so they can be tested
 * without one.
 */

/* ── Layer stack ─────────────────────────────────────────────────────────────
 * Layers open on top of each other (a confirmation over a sheet). Escape and
 * the focus trap belong to the top one only: Escape closes one layer at a
 * time, and the layer underneath must not pull focus back out of the one
 * above it. */

const layers: symbol[] = [];

/** Puts a layer on top. Returns the function that takes it off again. */
export function pushLayer(): { id: symbol; remove: () => void } {
  const id = Symbol("dialog-layer");
  layers.push(id);
  return {
    id,
    remove: () => {
      const i = layers.lastIndexOf(id);
      if (i >= 0) layers.splice(i, 1);
    },
  };
}

export function isTopLayer(id: symbol): boolean {
  return layers.length > 0 && layers[layers.length - 1] === id;
}

/* ── Scroll lock ─────────────────────────────────────────────────────────────
 * While any layer is open the page behind it does not scroll. The lock is
 * counted, so two layers open at once release it only when the last one
 * closes, and the inline values are put back as they were before the first.
 *
 * `overflow: hidden` on <body> takes the page's scrollbar away; on a system
 * that draws one, the content would widen by its width and jump sideways. The
 * same width goes on as right padding, so the page under the backdrop stays
 * where it was. */

export interface LockableStyle {
  overflow: string;
  paddingRight: string;
}

let lockCount = 0;
let saved: LockableStyle | null = null;

/** `scrollbarPx` is the page scrollbar's width, 0 where the system overlays it. */
export function lockScroll(style: LockableStyle, scrollbarPx: number): () => void {
  if (lockCount === 0) {
    saved = { overflow: style.overflow, paddingRight: style.paddingRight };
    style.overflow = "hidden";
    if (scrollbarPx > 0) style.paddingRight = `${scrollbarPx}px`;
  }
  lockCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lockCount -= 1;
    if (lockCount === 0 && saved) {
      style.overflow = saved.overflow;
      style.paddingRight = saved.paddingRight;
      saved = null;
    }
  };
}

/* ── Focus trap ──────────────────────────────────────────────────────────────
 * Tab and Shift+Tab cycle through the dialog's own controls and never reach
 * the page behind it. */

/** What a keyboard user can Tab to. Visibility is checked by the caller. */
export const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), ' +
  '[contenteditable="true"]';

/**
 * Where Tab should go instead of where the browser would send it, or null to
 * let the browser move focus itself (somewhere inside the dialog).
 *
 * - No tabbable control: focus stays on the dialog.
 * - Focus on none of them (the dialog itself, or lost): Tab to the first,
 *   Shift+Tab to the last.
 * - At the last going forward, or the first going back: wrap round.
 */
export function wrapFocus<T>(tabbables: readonly T[], current: T | null, backwards: boolean, dialog: T): T | null {
  if (tabbables.length === 0) return dialog;
  const first = tabbables[0] as T;
  const last = tabbables[tabbables.length - 1] as T;
  const at = current === null ? -1 : tabbables.indexOf(current);
  if (at === -1) return backwards ? last : first;
  if (!backwards && at === tabbables.length - 1) return first;
  if (backwards && at === 0) return last;
  return null;
}
