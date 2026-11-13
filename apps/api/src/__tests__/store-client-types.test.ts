/**
 * The store clients take only query text the api built: `PromQL` for
 * Prometheus, `LogQL` for Loki. `pnpm typecheck` skips test files, so this
 * compiles a snippet with the TypeScript compiler against the real clients
 * and reads the errors: a request's string handed to a client must not
 * compile, as text or interpolated into a plain template.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "store-client-fixture.ts");

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

describe("store clients", () => {
  it("refuse a request's string as a query, take what the builders make", { timeout: 60_000 }, () => {
    const errors = compile(
      [
        'import { logql, promql, qRequestsTotal } from "@sr/shared";', // 1
        'import type { PrometheusClient } from "../services/prometheus-client.js";', // 2
        'import type { LokiClient } from "../services/loki-client.js";', // 3
        "declare const prom: PrometheusClient;", // 4
        "declare const loki: LokiClient;", // 5
        "declare const request: { query: { query: string; spec: string } };", // 6
        "export const a = prom.query(promql`up`);", // 7: fine
        "export const b = prom.query(qRequestsTotal(request.query.spec, \"1h\"));", // 8: fine, the builder escapes the value
        "export const c = loki.count(logql`sum(count_over_time({a=\"b\"}[1m]))`);", // 9: fine
        "export const d = prom.query(request.query.query);", // 10: refused
        "export const e = prom.scalar(`count(${request.query.spec})`);", // 11: refused
        "export const f = prom.queryRange(request.query.query, 0, 1, \"60s\");", // 12: refused
        "export const g = loki.queryRange(request.query.query, 0, 1, 1, \"forward\");", // 13: refused
        "export const h = loki.count(promql`up`);", // 14: refused - PromQL is not LogQL
        "export const i = prom.query(promql`up{spec=\"${request.query.spec}\"}`);", // 15: refused
      ].join("\n"),
    );
    expect([...new Set(errors.map((e) => e.line))].sort((x, y) => x - y), JSON.stringify(errors)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(errors.every((e) => e.code === 2322 || e.code === 2345), JSON.stringify(errors)).toBe(true);
  });
});
