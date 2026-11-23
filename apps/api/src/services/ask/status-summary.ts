/** Text an incident title or detail keeps in the summary. */
const TEXT_LIMIT = 160;

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

/** A value with long strings shortened and nothing nested deeper than `depth`. */
function compact(value: unknown, depth = 2): unknown {
  if (typeof value === "string")
    return value.length > TEXT_LIMIT ? `${value.slice(0, TEXT_LIMIT - 1)}…` : value;
  if (Array.isArray(value)) return depth > 0 ? value.map((v) => compact(v, depth - 1)) : [];
  const object = record(value);
  if (!object) return value;
  if (depth <= 0) return {};
  return Object.fromEntries(Object.entries(object).map(([k, v]) => [k, compact(v, depth - 1)]));
}

/** Measured states that need no attention. */
const MEASURED_CLEAR = new Set(["up", "unconfigured", undefined]);

/** One chain's entry, or null when every provider is operational and its
 * measured state is clear: its own fields, and of its current providers only
 * those not operational, with a count of the rest. */
function chainEntry(entry: unknown): unknown {
  const chain = record(entry);
  if (!chain) return entry;
  const current = record(chain.current);
  const providers = Array.isArray(current?.providers) ? current.providers : null;
  if (!current || !providers) return compact(chain, 3);
  const attention = providers.filter((p) => record(p)?.status !== "operational");
  const measured = typeof current.measured === "string" ? current.measured : undefined;
  if (!attention.length && MEASURED_CLEAR.has(measured)) return null;
  return compact(
    {
      ...chain,
      current: {
        ...current,
        providers: attention,
        operationalProviders: providers.length - attention.length,
      },
    },
    4,
  );
}

function chainName(entry: unknown): string {
  const chain = record(entry);
  const name = chain?.requested_as ?? chain?.chain ?? chain?.slug;
  return typeof name === "string" ? name : "?";
}

/** The newest first, by the first time field an event carries. */
function eventTime(event: unknown): number {
  const e = record(event);
  for (const key of ["time", "at", "started_at", "starts_at", "timestamp", "created_at"]) {
    const v = e?.[key];
    if (typeof v === "number") return v;
    if (typeof v === "string" && Number.isFinite(Date.parse(v))) return Date.parse(v) / 1000;
  }
  return 0;
}

/**
 * A provider-status read (`status.chain_events`) made small enough to reach the
 * model whole: chains with every provider operational and a clear measured
 * state by name, every other chain with only its non-operational providers and
 * a count of the operational ones, long incident text shortened, and every event while
 * they fit in `budgetBytes`; then the newest that fit, with `eventsOmitted`
 * counting the rest. Null for a result that is not a status read's shape.
 */
export function summarizeChainEvents(
  data: unknown,
  budgetBytes: number,
): { summary: Json; omitted: number } | null {
  const outer = record(data);
  const status = outer && Array.isArray(outer.chains) ? outer : record(outer?.data);
  if (!status || !Array.isArray(status.chains) || !Array.isArray(status.events)) return null;
  const { chains, events, ...rest } = status;
  const entries = (chains as unknown[]).map((chain) => [chain, chainEntry(chain)] as const);
  const base: Json = {
    ...(compact(rest, 3) as Json),
    // Chains whose every provider is operational and whose measured state is up
    // or unconfigured, by name; the others in full.
    chainsAllOperational: entries.filter(([, entry]) => entry === null).map(([c]) => chainName(c)),
    chains: entries.filter(([, entry]) => entry !== null).map(([, entry]) => entry),
    eventCount: (events as unknown[]).length,
  };
  const ordered = [...(events as unknown[])]
    .map((event) => compact(event, 3))
    .sort((a, b) => eventTime(b) - eventTime(a));
  const fits = (kept: unknown[]) =>
    Buffer.byteLength(JSON.stringify({ ...base, events: kept, eventsOmitted: 0 })) <= budgetBytes;
  if (fits(ordered)) return { summary: { ...base, events: ordered }, omitted: 0 };
  let low = 0;
  let high = ordered.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(ordered.slice(0, mid))) low = mid;
    else high = mid - 1;
  }
  const omitted = ordered.length - low;
  return { summary: { ...base, events: ordered.slice(0, low), eventsOmitted: omitted }, omitted };
}

export const STATUS_SUMMARY_NOTE =
  "Provider status, summarized: chainsAllOperational names the chains whose every provider is operational and whose measured state is up or unconfigured; each chain in chains lists only its providers that are not operational, with operationalProviders counting the rest. Event text is shortened. eventsOmitted counts older events left out to fit; when it is above 0, say the event history is partial.";
