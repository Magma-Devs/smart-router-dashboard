/**
 * Query text the api sends to its stores - PromQL to Prometheus / Mimir, LogQL
 * to Loki - and the only ways to make it.
 *
 * The api builds every query itself, from validated parameters: no route
 * accepts query text. The type system holds that line. `PromQL` and `LogQL`
 * are branded strings; the store clients take nothing else, so a request
 * string handed to `query()` fails `pnpm typecheck`. A brand comes from:
 *
 *  - the `promql` / `logql` tagged templates, whose every interpolated part
 *    must already be query text (a builder's output, a catalog metric name)
 *    or a finite number. Fixed text is the code's own;
 *  - the escape helpers below, one per place a value sits in a query: each
 *    turns a value into a single literal, so nothing in it reads as syntax;
 *  - `trustedLogQL`, for the one piece of query text that is operator
 *    configuration (the router's Loki stream selector). Its callers are
 *    pinned by a test.
 *
 * Casting a string to a brand (`as PromQL`) is refused by lint outside this file.
 */

/** A PromQL expression or a piece of one, built here or by the builders. */
export type PromQL = string & { readonly __brand: "PromQL" };

/** A LogQL query or a piece of one, built here or by the api's LogQL builders. */
export type LogQL = string & { readonly __brand: "LogQL" };

/**
 * An RE2 pattern whose literal parts went through `regexLiteral`: the fixed
 * syntax is the code's, a value never is. Quoted for a query by `promRegex`,
 * `logLineRegex` or `logLabelRegex`.
 */
export type RegexSource = string & { readonly __brand: "RegexSource" };

/** A value that can't be made into the asked-for literal (a malformed name, a duration that isn't one). */
export class QueryTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryTextError";
  }
}

/* ── Tagged templates ───────────────────────────────────────────────────── */

/** A real template strings array: frozen, with its `raw` twin. Anything else is a string dressed up as one. */
function assertTemplate(strings: TemplateStringsArray): void {
  if (!Array.isArray(strings) || !Array.isArray(strings.raw) || !Object.isFrozen(strings)) {
    throw new QueryTextError("query text is built from a template literal");
  }
}

function joinTemplate(strings: TemplateStringsArray, parts: readonly (string | number)[]): string {
  assertTemplate(strings);
  let out = strings[0] ?? "";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (typeof part === "number" && !Number.isFinite(part)) throw new QueryTextError(`not a finite number: ${part}`);
    out += String(part) + (strings[i + 1] ?? "");
  }
  return out;
}

/** What a `promql` template interpolates: query text, or a finite number. */
export type PromQLPart = PromQL | number;

/**
 * PromQL from fixed text and parts that are already PromQL - a metric name
 * from the catalog, a builder's output, an escaped literal - or numbers.
 *
 * ```ts
 * promql`sum(rate(${ROUTER_METRICS.requestsTotal}${selector({ spec })}[5m]))`
 * ```
 */
export function promql(strings: TemplateStringsArray, ...parts: PromQLPart[]): PromQL {
  return joinTemplate(strings, parts) as PromQL;
}

/** What a `logql` template interpolates: query text, or a finite number. */
export type LogQLPart = LogQL | number;

/** LogQL from fixed text and parts that are already LogQL - a selector, an escaped literal - or numbers. */
export function logql(strings: TemplateStringsArray, ...parts: LogQLPart[]): LogQL {
  return joinTemplate(strings, parts) as LogQL;
}

/** An RE2 pattern from fixed syntax and parts that went through `regexLiteral` (or are patterns already). */
export function regex(strings: TemplateStringsArray, ...parts: RegexSource[]): RegexSource {
  return joinTemplate(strings, parts) as RegexSource;
}

/** PromQL pieces joined by a separator that is PromQL too (`promql\` or \``). */
export function joinPromQL(parts: readonly PromQL[], separator: PromQL): PromQL {
  return parts.join(separator) as PromQL;
}

/** LogQL pieces joined by a separator that is LogQL too. */
export function joinLogQL(parts: readonly LogQL[], separator: LogQL): LogQL {
  return parts.join(separator) as LogQL;
}

/** Patterns as one alternation, `a|b|c`: wrap it in a group where it sits next to more pattern. */
export function regexAlt(parts: readonly RegexSource[]): RegexSource {
  return parts.join("|") as RegexSource;
}

/* ── Literals: one helper per place a value sits in a query ─────────────── */

/** A lone UTF-16 surrogate: no escape writes one, so a value carrying one is refused. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * `value` as one double-quoted string literal, in the escapes Go's
 * `strconv.Unquote` reads back - the string syntax PromQL and LogQL share:
 * the quote and the backslash escaped, a line break or any other control
 * character written as an escape, never as itself.
 */
function quoted(value: string): string {
  if (LONE_SURROGATE.test(value)) throw new QueryTextError("a value with a lone surrogate can't be quoted");
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

/** No backtick, no control character: a value a LogQL raw string holds as written. */
function rawSafe(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === "`" || code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * `value` as one LogQL string literal: a backtick raw string, which reads
 * every character as itself, when the value can sit in one; else the
 * double-quoted form with escapes. Either way one literal.
 */
function logLiteral(value: string): string {
  if (LONE_SURROGATE.test(value)) throw new QueryTextError("a value with a lone surrogate can't be quoted");
  return rawSafe(value) ? `\`${value}\`` : quoted(value);
}

/** The characters RE2 reads as syntax outside a class. */
const RE_SYNTAX = /[.*+?^${}()|[\]\\]/g;

/** `value` as a pattern that matches exactly it: every RE2 metacharacter escaped. */
export function regexLiteral(value: string): RegexSource {
  return value.replace(RE_SYNTAX, "\\$&") as RegexSource;
}

/** PromQL string matcher value: `label=${promString(v)}` is `label="v"`, the value one escaped literal. */
export function promString(value: string): PromQL {
  return quoted(value) as PromQL;
}

/**
 * PromQL regex matcher value: `label=~${promRegex(src)}`. `src` is a pattern
 * whose values went through `regexLiteral`; this quotes it as a string,
 * escaping its backslashes again for the string.
 */
export function promRegex(source: RegexSource): PromQL {
  return quoted(source) as PromQL;
}

/** LogQL stream selector matcher value: `{label=${logStreamValue(v)}}`. */
export function logStreamValue(value: string): LogQL {
  return quoted(value) as LogQL;
}

/** LogQL line filter operand: `|= ${logLineFilter(v)}` / `!= …` matches `v` as written. */
export function logLineFilter(value: string): LogQL {
  return logLiteral(value) as LogQL;
}

/** LogQL regex line filter operand: `|~ ${logLineRegex(src)}` / `!~ …`. */
export function logLineRegex(source: RegexSource): LogQL {
  return logLiteral(source) as LogQL;
}

/** LogQL label filter value after a parser stage: `| json | label=${logLabelValue(v)}`. */
export function logLabelValue(value: string): LogQL {
  return quoted(value) as LogQL;
}

/** LogQL regex label filter value after a parser stage: `| label=~${logLabelRegex(src)}`. */
export function logLabelRegex(source: RegexSource): LogQL {
  return logLiteral(source) as LogQL;
}

/* ── Names and durations: validated, never escaped ──────────────────────── */

const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const DURATION = /^(?:\d+(?:ms|[smhdwy]))+$/;

/** Whether a label name is one Prometheus and Loki accept. */
export function isLabelName(name: string): boolean {
  return LABEL_NAME.test(name);
}

/** A label name in PromQL (`by (…)`, a matcher's left side); throws on one Prometheus would refuse. */
export function labelName(name: string): PromQL {
  if (!LABEL_NAME.test(name)) throw new QueryTextError(`not a label name: ${JSON.stringify(name)}`);
  return name as PromQL;
}

/** Label names as a `by (…)` list. */
export function labelList(names: readonly string[]): PromQL {
  return joinPromQL(names.map(labelName), ", " as PromQL);
}

/** A label name in LogQL (a stream matcher, `| json name="…"`, `by (…)`). */
export function logLabelName(name: string): LogQL {
  if (!LABEL_NAME.test(name)) throw new QueryTextError(`not a label name: ${JSON.stringify(name)}`);
  return name as LogQL;
}

/** A metric name as a PromQL selector; throws on one that isn't. */
export function metricName(name: string): PromQL {
  if (!METRIC_NAME.test(name)) throw new QueryTextError(`not a metric name: ${JSON.stringify(name)}`);
  return name as PromQL;
}

/**
 * A catalog of metric names, each typed as the PromQL selector it is, so a
 * builder interpolates it as is. Every name is checked once, here.
 */
export function metricNames<const T extends Record<string, string>>(names: T): { readonly [K in keyof T]: T[K] & PromQL } {
  for (const name of Object.values(names)) metricName(name);
  return names as { readonly [K in keyof T]: T[K] & PromQL };
}

/** A PromQL duration: whole seconds (`90` → `90s`), or a duration string (`5m`, `1h30m`). */
export function duration(value: number | string): PromQL {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new QueryTextError(`not a whole number of seconds: ${value}`);
    return `${value}s` as PromQL;
  }
  if (!DURATION.test(value)) throw new QueryTextError(`not a duration: ${JSON.stringify(value)}`);
  return value as PromQL;
}

/** A LogQL duration, as `duration` reads one. */
export function logDuration(value: number | string): LogQL {
  return duration(value) as string as LogQL;
}

/* ── Operator configuration ─────────────────────────────────────────────── */

/**
 * The router's Loki stream selector, `LOKI_ROUTER_SELECTOR`: LogQL the
 * operator writes into the deployment's environment, never a request's. It
 * must open with a `{…}` stream selector, which every query the api builds
 * starts from. The only way a configured string becomes LogQL: its callers
 * are pinned by a test.
 */
export function trustedLogQL(selector: string): LogQL {
  const text = selector.trim();
  if (!/^\{[^]*\}/.test(text)) throw new QueryTextError("a Loki router selector opens with a {…} stream selector");
  return text as LogQL;
}

/**
 * `selector` with one more stream matcher, `label="value"` added inside its
 * closing brace; null when the selector doesn't end in one (it carries a
 * pipeline) or the label isn't a label name.
 */
export function withStreamMatcher(selector: LogQL, label: string, value: string): LogQL | null {
  if (!LABEL_NAME.test(label) || !/\}\s*$/.test(selector)) return null;
  return selector.replace(/\}\s*$/, () => `, ${label}=${quoted(value)}}`) as LogQL;
}
