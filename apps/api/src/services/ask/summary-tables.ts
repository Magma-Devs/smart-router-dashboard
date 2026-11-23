import type { TxOutcome } from "@sr/shared";
import { txResultOf } from "../transactions.js";

/** One sample of an instant vector: its labels and its value, rounded to a whole count. */
export interface CountRow {
  labels: Record<string, string>;
  value: number;
}

/** A count's samples, or null when the read returned no instant vector. */
export function countRows(data: unknown): CountRow[] | null {
  const payload = object(object(data)?.data);
  if (payload?.resultType !== "vector" || !Array.isArray(payload.result)) return null;
  const rows: CountRow[] = [];
  for (const entry of payload.result) {
    const metric = object(object(entry)?.metric) ?? {};
    const sample = object(entry)?.value;
    const value = Array.isArray(sample) ? Number(sample[1]) : Number.NaN;
    if (!Number.isFinite(value)) return null;
    const labels: Record<string, string> = {};
    for (const [key, label] of Object.entries(metric))
      if (typeof label === "string" && key !== "__name__") labels[key] = label;
    rows.push({ labels, value: Math.round(value) });
  }
  return rows;
}

export type SummaryMeasure = "requests" | "transactions" | "errors" | "customers" | "providers";
export type TableRow = Record<string, string | number>;

/**
 * What one summary tells the model: rows and totals the server added up, so
 * the answer copies figures and never sums them. A count whose read failed is
 * named in `unavailable` and its column is left out of every row.
 */
export interface SummaryTable {
  rows: TableRow[];
  totals: Record<string, number>;
  /** measure=errors: the most frequent messages. measure=customers: requests per customer and method. */
  detail?: TableRow[];
  unavailable?: string[];
}

const TX_COLUMNS: Record<TxOutcome, string> = {
  accepted: "accepted",
  rejected: "rejected",
  failed: "failedNeverSent",
  "failed-on-chain": "failedOnChain",
  unknown: "unknown",
};

/** Sums `value` into `row[column]`, creating both on first use. */
function add(
  rows: Map<string, TableRow>,
  key: string,
  seed: TableRow,
  column: string,
  value: number,
) {
  const row = rows.get(key) ?? { ...seed };
  row[column] = Number(row[column] ?? 0) + value;
  rows.set(key, row);
}

function totalsOf(rows: TableRow[], columns: string[]): Record<string, number> {
  return Object.fromEntries(
    columns.map((column) => [column, rows.reduce((sum, row) => sum + Number(row[column] ?? 0), 0)]),
  );
}

/** Rows that carry every available column, zero where a count had no sample for them. */
function fill(rows: TableRow[], columns: string[]): TableRow[] {
  return rows.map((row) => {
    const filled = { ...row };
    for (const column of columns) filled[column] ??= 0;
    return filled;
  });
}

export function summaryTable(
  measure: SummaryMeasure,
  counts: { name: string; rows: CountRow[] | null }[],
): SummaryTable {
  const unavailable = counts.filter((count) => count.rows === null).map((count) => count.name);
  const read = (name: string) => counts.find((count) => count.name === name)?.rows ?? null;
  const by = new Map<string, TableRow>();
  let columns: string[] = [];
  let detail: TableRow[] | undefined;
  let order: (a: TableRow, b: TableRow) => number = () => 0;

  if (measure === "transactions") {
    const rows = read("transactions");
    if (rows) {
      columns = [...Object.values(TX_COLUMNS), "total"];
      for (const { labels, value } of rows) {
        const result = txResultOf({
          outcome: labels.outcome ?? "",
          txRefused: labels.tx_refused === "true",
          apiInterface: labels.api_interface ?? "",
          ...(labels.tx_status ? { txStatus: labels.tx_status } : {}),
        });
        const chain = labels.chain ?? "";
        add(by, chain, { chain }, TX_COLUMNS[result], value);
        add(by, chain, { chain }, "total", value);
      }
    }
    order = (a, b) => Number(b.total) - Number(a.total);
  } else if (measure === "errors") {
    const rows = read("errors");
    if (rows) {
      columns = ["lines"];
      for (const { labels, value } of rows) {
        const chain = labels.chain ?? "";
        const level = labels.level ?? "";
        add(by, `${chain}\u0000${level}`, { chain, level }, "lines", value);
      }
    }
    detail = read("error_messages")?.map(({ labels, value }) => ({
      chain: labels.chain ?? "",
      level: labels.level ?? "",
      message: labels.message ?? "",
      lines: value,
    }));
    order = (a, b) => Number(b.lines) - Number(a.lines);
  } else if (measure === "customers") {
    for (const [name, column] of [
      ["customer_requests", "requests"],
      ["customer_failures", "failures"],
    ] as const) {
      const rows = read(name);
      if (!rows) continue;
      columns.push(column);
      for (const { labels, value } of rows) {
        const customer = labels.customer ?? "";
        add(by, customer, { customer }, column, value);
      }
    }
    detail = read("customer_methods")?.map(({ labels, value }) => ({
      customer: labels.customer ?? "",
      method: labels.method ?? "",
      requests: value,
    }));
    order = (a, b) => Number(b.requests ?? 0) - Number(a.requests ?? 0);
  } else if (measure === "providers") {
    const relays = read("provider_relays");
    const successes = read("provider_successes");
    const nodeErrors = read("provider_node_errors");
    const key = (labels: Record<string, string>): readonly [string, TableRow] =>
      [
        `${labels.spec ?? ""}\u0000${labels.provider_address ?? ""}`,
        { chain: labels.spec ?? "", provider: labels.provider_address ?? "" },
      ] as const;
    if (relays) {
      columns.push("relays");
      for (const { labels, value } of relays) add(by, ...key(labels), "relays", value);
    }
    if (relays && successes) {
      columns.push("failedRelays");
      const ok = new Map(successes.map(({ labels, value }) => [key(labels)[0], value]));
      for (const [id, row] of by)
        row.failedRelays = Math.max(0, Number(row.relays) - (ok.get(id) ?? 0));
    }
    if (nodeErrors) {
      columns.push("nodeErrorReplies");
      for (const { labels, value } of nodeErrors)
        add(by, ...key(labels), "nodeErrorReplies", value);
    }
    order = (a, b) =>
      Number(b.failedRelays ?? 0) +
        Number(b.nodeErrorReplies ?? 0) -
        (Number(a.failedRelays ?? 0) + Number(a.nodeErrorReplies ?? 0)) ||
      Number(b.relays ?? 0) - Number(a.relays ?? 0);
  } else {
    for (const [name, column] of [
      ["requests", "requests"],
      ["failures", "failures"],
    ] as const) {
      const rows = read(name);
      if (!rows) continue;
      columns.push(column);
      for (const { labels, value } of rows) {
        const chain = labels.chain ?? "";
        add(by, chain, { chain }, column, value);
      }
    }
    order = (a, b) =>
      Number(b.failures ?? 0) - Number(a.failures ?? 0) ||
      Number(b.requests ?? 0) - Number(a.requests ?? 0);
  }

  const rows = fill([...by.values()], columns).sort(
    (a, b) => order(a, b) || JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
  return {
    rows,
    totals: totalsOf(rows, columns),
    ...(detail ? { detail } : {}),
    ...(unavailable.length ? { unavailable } : {}),
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
