import { describe, expect, it } from "vitest";
import {
  duration,
  isLabelName,
  joinLogQL,
  joinPromQL,
  labelList,
  labelName,
  logDuration,
  logLabelName,
  logLabelRegex,
  logLabelValue,
  logLineFilter,
  logLineRegex,
  logql,
  logStreamValue,
  metricName,
  metricNames,
  promql,
  promRegex,
  promString,
  QueryTextError,
  regex,
  regexAlt,
  regexLiteral,
  trustedLogQL,
  withStreamMatcher,
  type LogQL,
  type PromQL,
} from "../promql/query-text.js";

/**
 * Go's `strconv.Unquote` for the escapes `quoted` writes: what Prometheus and
 * Loki read a double-quoted literal back as. Anything else is a test failure.
 */
function unquote(lit: string): string {
  if (lit.startsWith("`")) {
    expect(lit.endsWith("`") && lit.length >= 2).toBe(true);
    const body = lit.slice(1, -1);
    expect(body).not.toContain("`");
    return body;
  }
  // One literal: opens and closes with a quote, every inner quote and backslash escaped, no raw line break.
  expect(lit).toMatch(/^"(?:[^"\\\n\r]|\\.)*"$/s);
  return lit.slice(1, -1).replace(/\\(x[0-9a-f]{2}|.)/g, (_, e: string) => {
    if (e.startsWith("x")) return String.fromCharCode(parseInt(e.slice(1), 16));
    const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };
    const out = simple[e];
    if (out === undefined) throw new Error(`unexpected escape \\${e}`);
    return out;
  });
}

/** Values that would end a literal, open a selector or start a pipeline if spliced as written. */
const HOSTILE = [
  'ETH1"}',
  'x"} or up{a="',
  "x` |= `y",
  "a\\",
  'a\\"b',
  "line\nbreak",
  "cr\rhere",
  "tab\there",
  "nul\x00and\x7fdel",
  "{}()[]|.*+?^$",
  "|= \"x\" |~ `y`",
  "# comment {",
  "ünïcödé 🚀",
  "",
];

describe("promString", () => {
  it("writes a plain value as a plain quoted string", () => {
    expect(promString("ETH1")).toBe('"ETH1"');
    expect(promString("eth-prod.router:8080")).toBe('"eth-prod.router:8080"');
  });

  it.each(HOSTILE)("keeps %j one literal that reads back as itself", (v) => {
    expect(unquote(promString(v))).toBe(v);
  });

  it("escapes quotes, backslashes and control characters", () => {
    expect(promString('a"b')).toBe('"a\\"b"');
    expect(promString("a\\b")).toBe('"a\\\\b"');
    expect(promString("a\nb")).toBe('"a\\nb"');
    expect(promString("a\x01b")).toBe('"a\\x01b"');
  });

  it("refuses a lone surrogate, which no escape writes", () => {
    expect(() => promString("a\uD800b")).toThrow(QueryTextError);
    expect(promString("🚀")).toBe('"🚀"');
  });
});

describe("regexLiteral + promRegex", () => {
  it("matches exactly the value, metacharacters and all", () => {
    for (const v of ["eth.prod", "a+b", "(x)|[y]", "^$", "a\\b", "{1,2}", "x?*"]) {
      const re = new RegExp(`^${unquote(promRegex(regexLiteral(v)))}$`);
      expect(re.test(v), v).toBe(true);
      expect(re.test(`${v}x`), v).toBe(false);
    }
    expect(new RegExp(`^${unquote(promRegex(regexLiteral("eth.prod")))}$`).test("ethXprod")).toBe(false);
  });

  it("escapes the pattern's backslashes again for the string", () => {
    expect(promRegex(regexLiteral("a.b"))).toBe('"a\\\\.b"');
    expect(promRegex(regex`.+-${regexLiteral("eth.a")}`)).toBe('".+-eth\\\\.a"');
  });

  it.each(HOSTILE)("keeps %j one literal", (v) => {
    expect(unquote(promRegex(regexLiteral(v)))).toBe(regexLiteral(v));
  });
});

describe("LogQL literals", () => {
  it("line filters keep a plain value in a raw string, as written", () => {
    expect(logLineFilter('"chain":"ETH1"')).toBe('`"chain":"ETH1"`');
    expect(logLineFilter("Choosing providers")).toBe("`Choosing providers`");
  });

  it("falls back to the quoted form when a raw string can't hold the value", () => {
    expect(logLineFilter("a`b")).toBe('"a`b"');
    expect(logLineFilter("a\nb")).toBe('"a\\nb"');
  });

  it.each(HOSTILE)("keeps %j one literal in every LogQL context", (v) => {
    expect(unquote(logLineFilter(v))).toBe(v);
    expect(unquote(logStreamValue(v))).toBe(v);
    expect(unquote(logLabelValue(v))).toBe(v);
    expect(unquote(logLineRegex(regexLiteral(v)))).toBe(regexLiteral(v));
    expect(unquote(logLabelRegex(regexLiteral(v)))).toBe(regexLiteral(v));
  });

  it("stream and label filter values are always double-quoted", () => {
    expect(logStreamValue("solana")).toBe('"solana"');
    expect(logLabelValue("subscription")).toBe('"subscription"');
  });

  it("regex filters match the literal as a line holds it", () => {
    const re = new RegExp(unquote(logLineRegex(regex`"GUID":"(${regexAlt(["1", "2.5"].map(regexLiteral))})"`)));
    expect(re.test('{"GUID":"2.5"}')).toBe(true);
    expect(re.test('{"GUID":"2x5"}')).toBe(false);
  });
});

describe("names and durations", () => {
  it("accepts label and metric names and refuses anything else", () => {
    expect(labelName("spec")).toBe("spec");
    expect(logLabelName("service_name")).toBe("service_name");
    expect(isLabelName("_x1")).toBe(true);
    for (const bad of ["", "1a", "a b", 'a"', "a{", "a=b", "a-b", "a:b"]) {
      expect(() => labelName(bad), bad).toThrow(QueryTextError);
      expect(() => logLabelName(bad), bad).toThrow(QueryTextError);
      expect(isLabelName(bad), bad).toBe(false);
    }
    expect(metricName("spec_router:smartrouter_requests_total:rate2m15s")).toBe("spec_router:smartrouter_requests_total:rate2m15s");
    for (const bad of ["", "1x", "a{b}", 'a"', "a b", "up or vector(1)"]) expect(() => metricName(bad), bad).toThrow(QueryTextError);
  });

  it("labelList joins validated names", () => {
    expect(labelList(["spec", "router"])).toBe("spec, router");
    expect(() => labelList(["spec", "a)"])).toThrow(QueryTextError);
  });

  it("metricNames checks a whole catalog", () => {
    expect(metricNames({ a: "x_total" }).a).toBe("x_total");
    expect(() => metricNames({ a: "x_total", b: "x} or y" })).toThrow(QueryTextError);
  });

  it("duration takes whole seconds or a duration string, nothing else", () => {
    expect(duration(90)).toBe("90s");
    expect(duration(0)).toBe("0s");
    expect(duration("5m")).toBe("5m");
    expect(duration("1h30m")).toBe("1h30m");
    expect(duration("30d12h")).toBe("30d12h");
    expect(logDuration(60)).toBe("60s");
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => duration(bad), String(bad)).toThrow(QueryTextError);
    for (const bad of ["", "5", "5m)", "5m] or up[5m", "ETH1", "1 h"]) expect(() => duration(bad), bad).toThrow(QueryTextError);
  });
});

describe("tagged templates", () => {
  it("join fixed text, query text and numbers", () => {
    const sel = promql`{spec=${promString("ETH1")}}`;
    expect(promql`sum(rate(x${sel}[${duration(300)}])) * ${60}`).toBe('sum(rate(x{spec="ETH1"}[300s])) * 60');
    expect(logql`{a="b"} |= ${logLineFilter("x")} [${logDuration(60)}]`).toBe('{a="b"} |= `x` [60s]');
    expect(regex`(${regexAlt([regexLiteral("a.b"), regexLiteral("c")])})`).toBe("(a\\.b|c)");
  });

  it("refuse a non-finite number", () => {
    expect(() => promql`x * ${Number.NaN}`).toThrow(QueryTextError);
    expect(() => logql`x * ${Number.POSITIVE_INFINITY}`).toThrow(QueryTextError);
  });

  it("refuse a string array passed in place of a template", () => {
    const fake = ["up or ", ""] as unknown as TemplateStringsArray;
    expect(() => promql(fake, promql`x`)).toThrow(QueryTextError);
    expect(() => logql(fake, logql`x`)).toThrow(QueryTextError);
    expect(() => regex(fake, regexLiteral("x"))).toThrow(QueryTextError);
  });

  it("join lists with a separator that is query text too", () => {
    expect(joinPromQL([promql`a`, promql`b`], promql` or `)).toBe("a or b");
    expect(joinLogQL([logql`a`, logql`b`], logql` + `)).toBe("a + b");
  });
});

describe("stream selectors", () => {
  const SEL = trustedLogQL('{cluster="t1",component="router"}');

  it("trustedLogQL takes a selector, trimmed, and refuses anything that doesn't open with one", () => {
    expect(trustedLogQL('  {component="router"}  ')).toBe('{component="router"}');
    expect(trustedLogQL('{component="router"} |= "x"')).toBe('{component="router"} |= "x"');
    for (const bad of ["", "up", 'component="router"', "| json"]) expect(() => trustedLogQL(bad), bad).toThrow(QueryTextError);
  });

  it("withStreamMatcher adds one escaped matcher inside the closing brace", () => {
    expect(withStreamMatcher(SEL, "chain", "solana")).toBe('{cluster="t1",component="router", chain="solana"}');
    expect(withStreamMatcher(SEL, "chain", 'x"} |= "y')).toBe('{cluster="t1",component="router", chain="x\\"} |= \\"y"}');
    expect(withStreamMatcher(SEL, "chain", "$&")).toBe('{cluster="t1",component="router", chain="$&"}');
  });

  it("withStreamMatcher answers null for a selector with a pipeline or a bad label", () => {
    expect(withStreamMatcher(`${SEL} |= "x"` as LogQL, "chain", "solana")).toBeNull();
    expect(withStreamMatcher(SEL, "chain=~", "solana")).toBeNull();
  });
});

describe("brands", () => {
  it("are plain strings at run time", () => {
    const p: PromQL = promql`up`;
    const l: LogQL = logql`{a="b"}`;
    expect(typeof p).toBe("string");
    expect(typeof l).toBe("string");
  });
});
