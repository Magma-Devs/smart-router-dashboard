import { BEHIND_CAVEAT_SECONDS, TIP_WINDOW_SECONDS, type TxOutcome } from "@sr/shared";
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

export type SummaryMeasure =
  "requests" | "transactions" | "errors" | "customers" | "providers" | "blocks";
export type TableRow = Record<string, string | number>;

/**
 * What one summary tells the model: rows and totals the server added up, so
 * the answer copies figures and never sums them. A count whose read failed is
 * named in `unavailable` and its column is left out of every row.
 */
export interface SummaryTable {
  rows: TableRow[];
  /** Rows past the cap; `totals` still add up every row. */
  omittedRows?: number;
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

/** The named labels a sample carries; one it does not carry is left out, never "". */
function pick(labels: Record<string, string>, names: string[]): TableRow {
  return Object.fromEntries(names.flatMap((name) => (labels[name] ? [[name, labels[name]]] : [])));
}

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

/** Rows one table holds at most; the largest come first. */
export const MAX_TABLE_ROWS = 40;

export function summaryTable(
  measure: SummaryMeasure,
  counts: { name: string; rows: CountRow[] | null }[],
  maxRows: number = MAX_TABLE_ROWS,
): SummaryTable {
  const unavailable = counts.filter((count) => count.rows === null).map((count) => count.name);
  const read = (name: string) => counts.find((count) => count.name === name)?.rows ?? null;
  if (measure === "blocks") return blockTable(read, unavailable, maxRows);
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
        add(by, chain, pick(labels, ["chain"]), TX_COLUMNS[result], value);
        add(by, chain, pick(labels, ["chain"]), "total", value);
      }
    }
    order = (a, b) => Number(b.total) - Number(a.total);
  } else if (measure === "errors") {
    const rows = read("errors");
    if (rows) {
      columns = ["lines"];
      for (const { labels, value } of rows) {
        const seed = pick(labels, ["chain", "level"]);
        add(by, `${labels.chain ?? ""}\u0000${labels.level ?? ""}`, seed, "lines", value);
      }
    }
    detail = read("error_messages")?.map(({ labels, value }) => ({
      ...pick(labels, ["chain", "level", "message"]),
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
        add(by, labels.customer ?? "", pick(labels, ["customer"]), column, value);
      }
    }
    detail = read("customer_methods")?.map(({ labels, value }) => ({
      ...pick(labels, ["customer", "method"]),
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
        add(by, labels.chain ?? "", pick(labels, ["chain"]), column, value);
      }
    }
    // Magma's serving probe is in the counts above; its share comes by chain,
    // and the customer's own is what is left.
    const probeRequests = read("probe_requests");
    const probeFailures = read("probe_failures");
    if (columns.includes("requests") && probeRequests && probeFailures) {
      columns.push("probeRequests", "probeFailures", "customerRequests", "customerFailures");
      const probe = (rows: CountRow[]) =>
        new Map(rows.map(({ labels, value }) => [labels.chain ?? "", value]));
      const sent = probe(probeRequests);
      const failed = probe(probeFailures);
      for (const [chain, row] of by) {
        row.probeRequests = Math.min(Number(row.requests ?? 0), sent.get(chain) ?? 0);
        row.probeFailures = Math.min(Number(row.failures ?? 0), failed.get(chain) ?? 0);
        row.customerRequests = Number(row.requests ?? 0) - Number(row.probeRequests);
        row.customerFailures = Number(row.failures ?? 0) - Number(row.probeFailures);
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
    rows: rows.slice(0, maxRows),
    ...(rows.length > maxRows ? { omittedRows: rows.length - maxRows } : {}),
    totals: totalsOf(rows, columns),
    ...(detail ? { detail: detail.slice(0, maxRows) } : {}),
    ...(unavailable.length ? { unavailable } : {}),
  };
}

/**
 * Each provider's distance from the best block among its router's providers on
 * the same chain and interface, the Upstreams roster's reading: in blocks, and
 * in seconds at the chain's pace. notMoving is a block that did not move over
 * the tip window while the chain made two blocks or more. Totals count
 * providers, never add up blocks.
 */
function blockTable(
  read: (name: string) => CountRow[] | null,
  unavailable: string[],
  maxRows: number,
): SummaryTable {
  const heights = read("block_heights") ?? [];
  const group = (l: Record<string, string>) =>
    `${l.router ?? ""}\u0000${l.spec ?? ""}\u0000${l.apiInterface ?? ""}`;
  const id = (l: Record<string, string>) => `${group(l)}\u0000${l.endpoint_id ?? ""}`;
  const index = (name: string, key: (l: Record<string, string>) => string) =>
    new Map((read(name) ?? []).map(({ labels, value }) => [key(labels), value]));
  const best = new Map<string, number>();
  for (const { labels, value } of heights)
    best.set(group(labels), Math.max(best.get(group(labels)) ?? 0, value));
  const pace = index("block_pace", group);
  const moves = index("block_moves", id);
  const stalled = index("head_stalled_urls", id);
  const paceKnown = read("block_pace") !== null;
  const movesKnown = read("block_moves") !== null;
  const rows: TableRow[] = heights.map(({ labels, value }) => {
    const perHour = pace.get(group(labels));
    const behind = (best.get(group(labels)) ?? value) - value;
    const moved = moves.get(id(labels));
    const row: TableRow = {
      ...pick(labels, ["router"]),
      chain: labels.spec ?? "",
      interface: labels.apiInterface ?? "",
      provider: labels.endpoint_id ?? "",
      latestBlock: value,
      blocksBehind: behind,
    };
    if (perHour !== undefined && perHour > 0)
      row.secondsBehind = Math.round((behind * 3600) / perHour);
    if (paceKnown && movesKnown)
      row.notMoving =
        moved === 0 && perHour !== undefined && (perHour * TIP_WINDOW_SECONDS) / 3600 >= 2
          ? "yes"
          : "no";
    const out = stalled.get(id(labels));
    if (out) row.headStalledUrls = out;
    return row;
  });
  const late = (row: TableRow) =>
    row.secondsBehind !== undefined
      ? Number(row.secondsBehind) >= BEHIND_CAVEAT_SECONDS
      : Number(row.blocksBehind) > 0;
  // A block that stopped first, then one far behind, then the rest.
  const rank = (row: TableRow) =>
    row.notMoving === "yes" || row.headStalledUrls ? 2 : late(row) ? 1 : 0;
  rows.sort(
    (a, b) =>
      rank(b) - rank(a) ||
      Number(b.secondsBehind ?? -1) - Number(a.secondsBehind ?? -1) ||
      Number(b.blocksBehind) - Number(a.blocksBehind) ||
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
  return {
    rows: rows.slice(0, maxRows),
    ...(rows.length > maxRows ? { omittedRows: rows.length - maxRows } : {}),
    totals: {
      providers: rows.length,
      atBestBlock: rows.filter((row) => Number(row.blocksBehind) === 0).length,
      [`behind${BEHIND_CAVEAT_SECONDS}sOrMore`]: rows.filter(late).length,
      ...(movesKnown && paceKnown
        ? { notMoving: rows.filter((row) => row.notMoving === "yes").length }
        : {}),
      headStalledUrls: rows.reduce((sum, row) => sum + Number(row.headStalledUrls ?? 0), 0),
    },
    ...(unavailable.length ? { unavailable } : {}),
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
