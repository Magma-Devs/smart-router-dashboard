/**
 * No text the web shows names a configuration setting.
 *
 * The person on the enrolment screen or the Audit log page cannot set
 * `TOTP_ENCRYPTION_KEY` or `AUTH_MODE`, and "Postgres" means nothing to them,
 * so the screens say what is wrong in plain words and who can fix it. The
 * names belong in the server's log, its startup errors and the docs, where an
 * operator reads them.
 *
 * This walks the source, as dialog-portal.test.ts does: every string literal,
 * template and piece of JSX text in the web app, and in `@sr/shared`, whose
 * labels and notes the web renders. Comments are not strings, so the many
 * that name `AUTH_MODE` for the next developer are left alone.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import ts from "typescript";

const NAMES = /TOTP_ENCRYPTION_KEY|PUBLIC_WEB_ORIGIN|AUTH_MODE|postgres/i;

const ROOTS = [
  fileURLToPath(new URL("../", import.meta.url)),
  fileURLToPath(new URL("../../../../packages/shared/src/", import.meta.url)),
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== "node_modules" && entry !== "__tests__") walk(p, out);
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** `process.env["AUTH_MODE"]` reads the setting; it says nothing to anybody. */
function readsTheSetting(node: ts.Node): boolean {
  const parent = node.parent;
  return ts.isElementAccessExpression(parent) && parent.expression.getText() === "process.env";
}

function stringsNaming(path: string, src: string): string[] {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    let text: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      text = node.text;
    else if (ts.isJsxText(node)) text = node.text;
    const isModulePath =
      node.parent && (ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent));
    if (text !== null && !isModulePath && NAMES.test(text) && !readsTheSetting(node)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${line + 1}: ${text.trim()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("configuration names in what the web shows", () => {
  const files = ROOTS.flatMap((root) => walk(root).map((p) => ({ root, path: p })));

  it("finds the source", () => {
    expect(files.some((f) => f.path.endsWith("components/auth/enrol-panel.tsx"))).toBe(true);
    expect(files.some((f) => f.path.endsWith("constants/emails.ts"))).toBe(true);
    expect(files.length).toBeGreaterThan(100);
  });

  it("appear in no string or JSX text", () => {
    const found = files.flatMap(({ root, path }) =>
      stringsNaming(path, readFileSync(path, "utf8")).map(
        (hit) => `${relative(root, path).split("\\").join("/")}:${hit}`,
      ),
    );
    expect(found).toEqual([]);
  });

  it("would be caught in a component's text, but not in a comment", () => {
    expect(
      stringsNaming(
        "probe.tsx",
        "// AUTH_MODE=enabled only\n" +
          "const a = <p>Set AUTH_MODE=enabled to turn it on.</p>;\n" +
          'const b = "Ask whoever runs it to set TOTP_ENCRYPTION_KEY.";\n' +
          'const c = process.env["AUTH_MODE"];\n',
      ),
    ).toEqual([
      "2: Set AUTH_MODE=enabled to turn it on.",
      "3: Ask whoever runs it to set TOTP_ENCRYPTION_KEY.",
    ]);
  });
});
