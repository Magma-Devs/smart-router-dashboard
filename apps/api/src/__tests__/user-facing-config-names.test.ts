import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * No string the api hands a person names a configuration setting.
 *
 * Somebody refused on the Team page or the enrolment screen cannot set
 * `PUBLIC_WEB_ORIGIN` or `TOTP_ENCRYPTION_KEY`, and "Postgres" means nothing
 * to them: a response's `message`, and an audit note the Audit log page shows
 * every role, say what is wrong in plain words. The names stay where an
 * operator reads them: log lines, the errors that stop a boot or that the 500
 * handler keeps from the response, the host recovery command, and the OpenAPI
 * descriptions.
 *
 * This walks the source rather than calling each route, so a refusal added
 * later is covered the day it is written.
 */

const NAMES = /TOTP_ENCRYPTION_KEY|PUBLIC_WEB_ORIGIN|AUTH_MODE|postgres/i;

const SRC = fileURLToPath(new URL("../", import.meta.url));

/** Run from a shell by an operator, never answered to a request. */
const OPERATOR_FILES = new Set(["recover.ts", "config.ts", "main.ts"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      if (entry !== "node_modules" && entry !== "__tests__") walk(p, out);
    } else if (/\.ts$/.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

const LOG_METHODS = new Set(["error", "warn", "info", "debug", "trace", "fatal", "log"]);

/** Is this call a log line (`request.log.error(…)`, `app.log.warn`, a `log`
 *  callback, `console.error`)? */
function isLogCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return /^log$|Log$/.test(callee.text);
  if (ts.isPropertyAccessExpression(callee)) {
    const target = callee.expression.getText();
    return LOG_METHODS.has(callee.name.text) && /(^|\.)(log|logger|console)$/.test(target);
  }
  return false;
}

/** Where an operator reads the string, rather than the person in front of the screen. */
function operatorContext(node: ts.Node): string | null {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (ts.isCallExpression(at) && isLogCall(at)) return "log";
    if (ts.isCallExpression(at) && ts.isIdentifier(at.expression) && at.expression.text === "env") {
      return "reads the setting";
    }
    // Thrown at boot, or caught by the 500 handler, which answers
    // "Internal Server Error" and logs the rest.
    if (ts.isNewExpression(at) && /Error$/.test(at.expression.getText())) return "error";
    if (ts.isPropertyAssignment(at) && ["summary", "description"].includes(at.name.getText())) {
      return "OpenAPI";
    }
    if (ts.isElementAccessExpression(at) && at.expression.getText() === "process.env") {
      return "reads the setting";
    }
  }
  return null;
}

interface Found {
  file: string;
  line: number;
  text: string;
}

function userFacingStrings(): { scanned: number; found: Found[] } {
  const found: Found[] = [];
  const files = walk(SRC);
  for (const path of files) {
    const file = relative(SRC, path).split("\\").join("/");
    if (OPERATOR_FILES.has(file)) continue;
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node) => {
      let text: string | null = null;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
      else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
        text = node.text;
      // An import specifier names a module, not a sentence.
      if (
        text !== null &&
        !ts.isImportDeclaration(node.parent) &&
        !ts.isExportDeclaration(node.parent)
      ) {
        if (NAMES.test(text) && !operatorContext(node)) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart());
          found.push({ file, line: line + 1, text });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { scanned: files.length, found };
}

describe("configuration names in what the api tells a person", () => {
  const { scanned, found } = userFacingStrings();

  it("finds the source", () => {
    expect(scanned).toBeGreaterThan(50);
  });

  it("appear in none of its messages or audit notes", () => {
    expect(found).toEqual([]);
  });

  it("would be caught in a response message", () => {
    // The scan itself, on a refusal written the way the old ones were.
    const source = ts.createSourceFile(
      "probe.ts",
      'reply.code(500).send({ message: "PUBLIC_WEB_ORIGIN is not configured" });\n' +
        'request.log.error("PUBLIC_WEB_ORIGIN is not set");\n',
      ts.ScriptTarget.Latest,
      true,
    );
    const flagged: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isStringLiteral(node) && NAMES.test(node.text) && !operatorContext(node))
        flagged.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(flagged).toEqual(["PUBLIC_WEB_ORIGIN is not configured"]);
  });
});
