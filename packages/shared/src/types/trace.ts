/**
 * Relay Investigator — the GUID-scoped log lookup and its AI explanation.
 *
 * There is deliberately no parsed event model here. The router's log lines go
 * to the model as they were written, and what comes back is the explanation.
 * The only structure we impose is on the ANSWER, so the page can lay it out.
 *
 * See `docs/trace-ai-page/RELAY-TRACE.md` for what the trail actually contains at each of
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

/**
 * `GET /api/trace/:guid` — the relay's log trail. Cheap, deterministic, and
 * makes NO model call.
 *
 * Explaining is a separate POST behind an explicit button. Splitting them is
 * what makes the cost a decision the user takes rather than a side effect of
 * opening a URL — a trace is meant to be pasted to whoever is on call, and a
 * link that bills the operator once per reader is not a link you can share.
 */
export interface RelayTrace {
  guid: string;
  /** Lines carrying this GUID, oldest first. */
  lines: TraceLogLine[];
  /** How far back we had to look before we found them (Unix ms). */
  searched: { fromMs: number; toMs: number };
  /**
   * True when the trail was longer than TRACE_MAX_LINES. Truncation must never
   * be mistaken for a short relay.
   */
  truncated: boolean;
  /**
   * Whether `POST /api/trace/:guid/explain` will answer on this deployment
   * (`TRACE_AI_ENABLED` + a key). The page shows the Ask-AI button only when
   * true, and says why when not — rather than offering a button that 404s.
   */
  aiAvailable: boolean;
  /** Model that would answer, for the button's footnote. Null when unavailable. */
  model: string | null;
}

/** Model providers the explanation can be asked of. */
export type TraceAiProviderId = "anthropic" | "gemini";

/**
 * Per-person model settings, held in the BROWSER and sent with each ask.
 *
 * The key never reaches the server's disk: it is used for that one call and
 * dropped. That is what makes "bring your own key" real — each person spends
 * their own budget, and a deployment holds no secret that everyone who can
 * reach it could spend. The tradeoff is stated on the settings page: anything
 * that can run script in this origin can read `localStorage`.
 */
export interface TraceAiSettings {
  provider: TraceAiProviderId;
  /** Empty means "the provider's default", resolved server-side. */
  model: string;
  apiKey: string;
}

/** Body of `POST /api/trace/:guid/explain`. All optional — omitted means
 *  "use whatever the deployment is configured with". */
export interface TraceExplainRequest {
  provider?: TraceAiProviderId;
  model?: string;
  /** Used for this one call and never persisted or echoed back. */
  apiKey?: string;
}

/** `POST /api/trace/:guid/explain` — the answer, and what produced it. */
export interface TraceExplainResult {
  guid: string;
  explanation: TraceExplanation;
  model: string;
  /** Which provider answered — the caller's or the deployment's. */
  provider: TraceAiProviderId;
  /** True when the caller supplied the key, false when the deployment did. */
  usedCallerKey: boolean;
  /** Lines the model was given — may be fewer than the trail when truncated. */
  linesConsidered: number;
}

/** One model the configured provider will accept, for the settings picker. */
export interface TraceModelOption {
  /** What goes in `TraceAiSettings.model` and on the wire. */
  id: string;
  /** The provider's own display name, when it gives one. */
  label: string;
}

/** Body of `POST /api/trace/models`. */
export interface TraceModelsRequest {
  provider?: TraceAiProviderId;
  /** Same bring-your-own-key rule as the explain route: used for this one
   *  call, never persisted. */
  apiKey?: string;
}

/** `POST /api/trace/models` — what this provider will answer to, asked of the
 *  provider itself rather than hardcoded, because model lists change. */
export interface TraceModelsResponse {
  provider: TraceAiProviderId;
  models: TraceModelOption[];
  /** The id the api would use if the caller leaves the model blank. */
  defaultModel: string;
}
