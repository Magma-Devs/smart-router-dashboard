/**
 * Every /api/metrics/* fetch must carry the router scope.
 *
 * 18bec12 added `?router=` and swept the call sites by hand; three were
 * missed (HeroPanel, MetricsTabSectionC's methods table, UpstreamMetricsTab's
 * detail fetch), so those panels kept reading every router while the panels
 * beside them read one — the Metrics · Overview tile disagreeing with the
 * Routers table under it was MAG-2710.
 *
 * A per-component assertion would not have caught that: the bug is a MISSING
 * call site, and there is no component to write a test against until someone
 * notices. So this walks the source instead and holds the invariant for every
 * fetch that exists now or is added later.
 *
 * The web app has no jsdom/testing-library, so a render test is not an option
 * here anyway — matching the repo's existing pure-logic web tests.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SRC = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Endpoints that must NOT be scoped, with the reason.
 * `routers` enumerates the routers you can pick between — scoping it to the
 * current selection would make every other router unreachable.
 */
const UNSCOPED_BY_DESIGN = new Set(["/api/metrics/routers"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== "node_modules" && entry !== "__tests__") walk(p, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * A match inside a COMMENT is prose, not a fetch. House style quotes these
 * paths in backticks (`/api/metrics/specs`), which is indistinguishable from a
 * template literal by the rule below — so the line's own prefix decides: text
 * before the match containing `//`, or a line opening with `*` / `/*`, is a
 * comment. A real call can still carry a trailing `//` comment, because that
 * text comes after the match.
 */
function inComment(src: string, index: number): boolean {
  const lineStart = src.lastIndexOf("\n", index) + 1;
  const before = src.slice(lineStart, index);
  return before.includes("//") || /^\s*(\*|\/\*)/.test(before);
}

/**
 * URL literals only — a leading backtick or quote is what separates real URL
 * construction from the many doc-comment mentions of these paths.
 *
 * The closing delimiter is found by scanning rather than by regex: these URLs
 * nest quotes inside their interpolations (HeroPanel's `${spec ? `&spec=…` :
 * ""}`), so a non-greedy [^"`]* stops early and reports a scoped URL as
 * unscoped. Track `${…}` depth and take the delimiter that closes at depth 0.
 */
function metricsUrlLiterals(src: string): { literal: string; scoped: boolean }[] {
  const out: { literal: string; scoped: boolean }[] = [];
  const re = /(withScope\(\s*)?(["`])\/api\/metrics\//g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (inComment(src, m.index)) {
      re.lastIndex = m.index + m[0].length;
      continue;
    }
    const withScope = Boolean(m[1]);
    const quote = m[2]!;
    const start = m.index + (m[1]?.length ?? 0) + 1;
    let i = start;
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") { i += 2; continue; }
      if (quote === "`" && c === "$" && src[i + 1] === "{") { depth++; i += 2; continue; }
      if (depth > 0) {
        if (c === "{") depth++;
        else if (c === "}") depth--;
        i++;
        continue;
      }
      if (c === quote) break;
      i++;
    }
    const literal = src.slice(start, i);
    // Either interpolated (`${scopeQ}`) or wrapped in withScope(...).
    out.push({ literal, scoped: literal.includes("${scopeQ}") || withScope });
    re.lastIndex = i;
  }
  return out;
}

describe("router scope (?router=) coverage", () => {
  const files = walk(SRC);

  it("finds the web sources (guards against a broken SRC path)", () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith("HeroPanel.tsx"))).toBe(true);
  });

  it("reads prose and calls apart", () => {
    const src = [
      "/** The Metrics page took `/api/metrics/specs` (chains with traffic). */",
      "  // scoped elsewhere: `/api/metrics/chains?window=1d`",
      " *  reads `/api/metrics/upstreams` per window",
      'const a = useApi(`/api/metrics/chains?window=${w}${scopeQ}`);',
      'const b = useApi(withScope("/api/metrics/specs"));',
      'const c = useApi(`/api/metrics/errors?window=${w}`); // forgot the scope',
    ].join("\n");
    // The three comment mentions are prose; only the three calls are counted.
    expect(metricsUrlLiterals(src).map((l) => l.scoped)).toEqual([true, true, false]);
  });

  it("every /api/metrics/* fetch carries the router scope", () => {
    const unscoped: string[] = [];
    for (const file of files) {
      for (const { literal, scoped } of metricsUrlLiterals(readFileSync(file, "utf8"))) {
        const path = literal.split("?")[0]!;
        if (scoped || UNSCOPED_BY_DESIGN.has(path)) continue;
        unscoped.push(`${file.slice(SRC.length)} → ${literal}`);
      }
    }
    // Named in the failure so the fix is obvious: add `${scopeQ}` from
    // useFilters(), or withScope(...) when the URL has no params of its own.
    expect(unscoped).toEqual([]);
  });

  it("the router list itself stays unscoped", () => {
    const select = readFileSync(join(SRC, "components/gateway/RouterSelect.tsx"), "utf8");
    const [routers] = metricsUrlLiterals(select).filter((u) =>
      u.literal.startsWith("/api/metrics/routers"),
    );
    expect(routers).toBeDefined();
    expect(routers!.scoped).toBe(false);
  });
});
