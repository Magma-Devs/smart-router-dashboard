/** A deliberately limited query dialect, not a PromQL/LogQL parser. Only
 * literal range selectors are admitted. Subqueries, duration expressions and
 * time relocation require a separately audited execution policy. The source
 * must still enforce cardinality, sample, memory and query-time limits.
 * https://prometheus.io/docs/prometheus/latest/querying/basics/ */
export function hasBoundedAskQuery(value: string): boolean {
  const code = [...value];
  let quote = "";
  let comment = false;
  for (let i = 0; i < code.length; i++) {
    const char = code[i]!;
    if (comment) {
      if (char === "\n") comment = false;
      code[i] = " ";
    } else if (quote) {
      code[i] = " ";
      if (char === "\\" && quote !== "`") code[++i] = " ";
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
      code[i] = " ";
    } else if (char === "#") {
      comment = true;
      code[i] = " ";
    }
  }
  if (quote) return false;
  const syntax = code.join("");
  if (syntax.includes("@") || /\boffset\b/.test(syntax)) return false;
  const unitSeconds: Record<string, number> = {
    ms: 0.001,
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
    w: 604800,
    y: 31536000,
  };
  let lookback = 0;
  let selectors = 0;
  // Split instead of searching only well-formed selectors: malformed/nested
  // brackets must not hide an unbounded expression from this guard.
  const parts = syntax.split(/(\[|\])/);
  for (let i = 1; i < parts.length; i += 4) {
    if (parts[i] !== "[" || parts[i + 2] !== "]" || ++selectors > 32) return false;
    const literal = parts[i + 1]!.trim();
    let seconds: number;
    if (/^(?:\d+(?:ms|[smhdwy]))+$/.test(literal)) {
      seconds = [...literal.matchAll(/(\d+)(ms|[smhdwy])/g)].reduce(
        (sum, match) => sum + Number(match[1]) * unitSeconds[match[2]!]!,
        0,
      );
    } else if (/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(literal)) {
      seconds = Number(literal);
    } else return false;
    lookback += seconds;
    if (!Number.isFinite(lookback) || seconds <= 0 || lookback > 86400) return false;
  }
  return true;
}
