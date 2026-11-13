"use client";

import { useState } from "react";

/** A list's opening filter and the list it was chosen for. */
export interface Opening<T> {
  /** The list it was chosen for: its times, chain and router. */
  key: string;
  value: T;
}

/**
 * A list's opening filter after one more render. It is chosen once per list,
 * from the first read that answers - when the list opens, and again when its
 * times, chain or router change (`key`) - and kept through every later poll
 * and "Load older": re-chosen on each read, it flips under the reader as
 * requests arrive or age out of the window. `null` until the list's first
 * read answers.
 */
export function settleOpening<T>(prev: Opening<T> | null, key: string, answered: boolean, choose: () => T): Opening<T> | null {
  if (prev?.key === key) return prev;
  return answered ? { key, value: choose() } : null;
}

/** `settleOpening` held across renders: the opening value, `null` until the list's first read answers. */
export function useOpening<T>(key: string, answered: boolean, choose: () => T): T | null {
  const [opening, setOpening] = useState<Opening<T> | null>(null);
  const next = settleOpening(opening, key, answered, choose);
  if (next !== opening) setOpening(next);
  return next?.value ?? null;
}
