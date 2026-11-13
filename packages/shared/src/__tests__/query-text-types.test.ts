/**
 * The brands are a type-level guarantee, and `pnpm typecheck` skips test
 * files, so this compiles a snippet with the TypeScript compiler against the
 * real sources and reads the errors: a request's string interpolated into
 * `promql` / `logql`, or assigned where query text goes, must not compile.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "brand-fixture.ts");

function compile(code: string): { line: number; code: number; message: string }[] {
  const tsconfig = path.join(here, "../../tsconfig.json");
  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(tsconfig, ts.sys.readFile).config, ts.sys, path.dirname(tsconfig));
  const options = { ...parsed.options, noEmit: true, declaration: false, declarationMap: false, sourceMap: false };
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists, readFile } = host;
  host.getSourceFile = (name, lang, ...rest) =>
    path.resolve(name) === FIXTURE ? ts.createSourceFile(name, code, lang) : getSourceFile.call(host, name, lang, ...rest);
  host.fileExists = (name) => path.resolve(name) === FIXTURE || fileExists.call(host, name);
  host.readFile = (name) => (path.resolve(name) === FIXTURE ? code : readFile.call(host, name));
  const program = ts.createProgram([FIXTURE], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file && path.resolve(d.file.fileName) === FIXTURE)
    .map((d) => ({
      line: d.file!.getLineAndCharacterOfPosition(d.start ?? 0).line + 1,
      code: d.code,
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    }));
}

describe("PromQL / LogQL brands", () => {
  it("a plain string can't become query text; the helpers' output can", { timeout: 60_000 }, () => {
    const errors = compile(
      [
        'import { logLineFilter, logql, promql, promString, selector, type LogQL, type PromQL } from "../promql/index.js";',
        "declare const fromRequest: string;",
        "export const a: PromQL = promql`up{spec=${promString(fromRequest)}}`;", // 3: fine
        "export const b: PromQL = selector({ spec: fromRequest });", // 4: fine
        "export const c: LogQL = logql`{a=\"b\"} |= ${logLineFilter(fromRequest)}`;", // 5: fine
        'export const d = promql`up{spec="${fromRequest}"}`;', // 6: refused
        "export const e: PromQL = fromRequest;", // 7: refused
        "export const f = logql`{a=\"b\"} |= \\`${fromRequest}\\``;", // 8: refused
        "export const g: LogQL = promql`up`;", // 9: refused - the brands don't mix
      ].join("\n"),
    );
    expect([...new Set(errors.map((e) => e.line))].sort(), JSON.stringify(errors)).toEqual([6, 7, 8, 9]);
    // Type errors (not assignable), not a fixture that fails to parse.
    expect(errors.every((e) => e.code === 2322 || e.code === 2345), JSON.stringify(errors)).toBe(true);
  });
});
