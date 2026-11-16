/**
 * Rules the stylesheet and the shell's markup keep together. There is no DOM
 * in this test runner, so these read the source, as dialog-portal.test.ts does.
 *
 * - The sidebar's role badge shows the role's label as written ("Read-only"),
 *   so the stylesheet does not uppercase it.
 * - Keyboard focus is drawn in `--focus`, and this device's session in
 *   `--info`, not the brand red, which marks errors and destructive actions.
 * - The top bar folds rather than wraps: under its container query the root
 *   crumb and the Report incident label go, and the markup carries the classes
 *   that query hides.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const css = read("../../../styles/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every declaration block whose selector list contains `selector`. */
function rulesFor(selector: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]!.split(",").map((s) => s.trim());
    if (selectors.includes(selector)) out.push(m[2]!);
  }
  return out;
}

describe("the sidebar's role badge", () => {
  it("is not uppercased", () => {
    const rules = rulesFor(".gw-side__user .plan-chip");
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect(r).not.toMatch(/text-transform\s*:\s*uppercase/);
  });

  it("is not drawn in the brand red", () => {
    for (const r of rulesFor(".gw-side__user .plan-chip")) {
      expect(r).not.toMatch(/--brand\b|255,\s*57,\s*0/);
    }
  });
});

describe("keyboard focus", () => {
  it.each([".gw-input:focus", ".gw-lane:focus-visible", ".gw-disclosure:focus-visible"])(
    "%s is drawn in --focus",
    (selector) => {
      const rules = rulesFor(selector);
      expect(rules.length).toBeGreaterThan(0);
      for (const r of rules) {
        expect(r).toContain("var(--focus)");
        expect(r).not.toMatch(/--brand\b|255,\s*57,\s*0/);
      }
    },
  );

  it("has a --focus colour in both themes", () => {
    for (const theme of ["dark", "light"]) {
      const block =
        css.match(new RegExp(`\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      expect(block, theme).toMatch(/--focus:\s*#[0-9a-f]{6};/i);
    }
  });
});

describe("the session this device holds", () => {
  it("is marked in --info, not the brand red", () => {
    const card = read("../../account/SessionsCard.tsx");
    expect(card).not.toContain("var(--brand)");
    expect(card).toMatch(/s\.current \? "var\(--info\)"/);
  });
});

describe("the top bar", () => {
  const query = css.match(/@container gw-top \(max-width: (\d+)px\)\s*\{([^}]*)\}/);

  it("is the container its fold is measured against", () => {
    const top = rulesFor(".gw-top").join(";");
    expect(top).toMatch(/container:\s*gw-top\s*\/\s*inline-size/);
    expect(query, "no @container gw-top query").not.toBeNull();
  });

  it("folds the root crumb and the button labels away", () => {
    expect(query![2]).toMatch(/\.gw-top__root,\s*\.gw-top__label\s*\{\s*display:\s*none;/);
  });

  it("keeps its pills and buttons on one line", () => {
    const nowrap = rulesFor(".gw-top__right > .gw-btn").join(";");
    expect(nowrap).toMatch(/white-space:\s*nowrap/);
    expect(rulesFor(".gw-top__right > .pill").join(";")).toMatch(/white-space:\s*nowrap/);
  });

  it("marks what the fold hides", () => {
    const shell = read("../Shell.tsx");
    expect(shell.match(/className="gw-top__root"/g)?.length).toBe(2);
    const report = read("../../incidents/ReportIncident.tsx");
    expect(report).toMatch(/<span className="gw-top__label">Report incident<\/span>/);
    expect(report).toMatch(/aria-label="Report incident"/);
  });
});
