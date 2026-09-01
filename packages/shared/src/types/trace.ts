/**
 * Relay Trace — the GUID-scoped log lookup and its AI explanation.
 *
 * There is deliberately no parsed event model here. The router's log lines go
 * to the model as they were written, and what comes back is the explanation.
 * The only structure we impose is on the ANSWER, so the page can lay it out.
 *
 * See `docs/RELAY-TRACE.md` for what the trail actually contains at each of
 * the router's log levels — it is thin at `info`, which is why
 * `notDetermined` below is a required field rather than a nicety.
 */

/** One log line as Loki returned it. */
export interface TraceLogLine {
  /** Unix milliseconds, from Loki's own timestamp for the entry. */
  tMs: number;
  /** The raw line, verbatim — this is what the model was given. */
  line: string;
  /** `level` where the collector parsed one out; null when it didn't. */
  level: string | null;
}

/** One step of the router's handling of the relay, as the model read it. */
export interface TraceStep {
  /** Human-readable clock time, or a relative offset — whatever the logs support. */
  at: string;
  what: string;
}

export type TraceSeverity = "info" | "warning" | "critical";

export interface TraceFinding {
  severity: TraceSeverity;
  title: string;
  detail: string;
}

/** The model's account of one relay. */
export interface TraceExplanation {
  /** One paragraph: what this relay was and how it went. */
  summary: string;
  timeline: TraceStep[];
  findings: TraceFinding[];
  /**
   * What the logs did not record. REQUIRED, and rendered on the page.
   *
   * At the router's default `info` level the provider selection is never
   * written down, so a model asked "which upstream served this?" will answer
   * anyway unless it has somewhere honest to put the gap. This is that place,
   * and the list is also the most useful output we get: it names what the
   * router should be logging.
   */
  notDetermined: string[];
}

/** Why an explanation is absent, when it is. */
export type TraceExplainSkip =
  | "disabled" /* TRACE_AI_ENABLED=false — the page still shows the lines. */
  | "no_lines" /* Nothing to explain. */
  | "failed"; /* The model call errored; `explainError` says how. */

/** `GET /api/trace/:guid`. */
export interface RelayTrace {
  guid: string;
  /** Lines carrying this GUID, oldest first. */
  lines: TraceLogLine[];
  /** How far back we had to look before we found them (Unix ms). */
  searched: { fromMs: number; toMs: number };
  /**
   * True when the trail was longer than TRACE_MAX_LINES and we sent the model
   * a prefix. Truncation must never be mistaken for a short relay.
   */
  truncated: boolean;
  /** Null when `explainSkipped` says why not. */
  explanation: TraceExplanation | null;
  explainSkipped: TraceExplainSkip | null;
  explainError: string | null;
  /** Model that answered, for the footer. Null when there was no call. */
  model: string | null;
}
