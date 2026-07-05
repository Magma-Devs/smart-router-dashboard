"use client";

import { useCallback, useMemo, useState } from "react";
import { Tip } from "./Tip";

/* SortArrow + ThCol ported verbatim from the design prototype
   (page-metrics.jsx). useSort reproduces the prototype's sort-state
   semantics: clicking the active column toggles asc/desc, clicking a
   new column sorts it desc. */

export type SortDir = "asc" | "desc";

export interface SortState<K extends string = string> {
  key: K | null;
  dir: SortDir;
}

export function SortArrow({ active, dir }: { active: boolean; dir: SortDir | null }) {
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", lineHeight: 0.7, marginLeft: 3, fontSize: 7, color: active ? "var(--brand)" : "var(--text-4)", opacity: active ? 1 : 0.55 }}>
      <span style={{ opacity: active && dir === "asc" ? 1 : (active ? 0.3 : 1) }}>▲</span>
      <span style={{ opacity: active && dir === "desc" ? 1 : (active ? 0.3 : 1) }}>▼</span>
    </span>
  );
}

export interface ThColProps<K extends string = string> {
  children?: React.ReactNode;
  align?: "left" | "right" | "center";
  tip?: string;
  sortKey?: K;
  sort?: SortState<K> | null;
  onSort?: (key: K) => void;
}

export function ThCol<K extends string = string>({ children, align, tip, sortKey, sort, onSort }: ThColProps<K>) {
  const sortable = !!sortKey && !!onSort;
  const active = sortable && !!sort && sort.key === sortKey;
  return (
    <th style={{ textAlign: align || "left" }}>
      <span onClick={sortKey && onSort ? () => onSort(sortKey) : undefined}
        style={{ display: "inline-flex", alignItems: "center", cursor: sortable ? "pointer" : "default", userSelect: "none" }}>
        {children}{tip && <Tip text={tip} />}
        {sortable && <SortArrow active={active} dir={active && sort ? sort.dir : null} />}
      </span>
    </th>
  );
}

/* Prototype comparison is plain `va < vb ? -1 : va > vb ? 1 : 0`; nulls
   (which real API rows can carry, unlike the mock's accessors) sort first
   ascending / last descending. */
function cmpValues(va: unknown, vb: unknown): number {
  if (va == null && vb == null) return 0;
  if (va == null) return -1;
  if (vb == null) return 1;
  const a = va as number | string;
  const b = vb as number | string;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function useSort<T>(
  rows: T[],
  initial: { key: keyof T & string; dir: SortDir },
): {
  sorted: T[];
  sort: { key: keyof T & string; dir: SortDir };
  onSort: (key: keyof T & string) => void;
} {
  const [sort, setSort] = useState<{ key: keyof T & string; dir: SortDir }>(initial);
  const onSort = useCallback((key: keyof T & string) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));
  }, []);
  const sorted = useMemo(() => {
    const arr = [...rows];
    arr.sort((a, b) => {
      const c = cmpValues(a[sort.key], b[sort.key]);
      return sort.dir === "asc" ? c : -c;
    });
    return arr;
  }, [rows, sort]);
  return { sorted, sort, onSort };
}
