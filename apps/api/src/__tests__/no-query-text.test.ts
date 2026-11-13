/**
 * No route takes query text, and every value a request can put into a store
 * query is checked before the read. This walks every route the app registers
 * (accounts on, so the account and audit routes are there too) and reads its
 * schemas:
 *
 *  - no querystring, params or body property is named like query text
 *    (`query`, `expr`, `q`, `promql`, `logql`, a free-form `filter`, …);
 *  - every querystring and params string is bounded - an enum, a pattern, a
 *    length cap or a format - so no unbounded free text reaches a store;
 *  - the routes that read the metrics store or the logs declare their
 *    querystring, and drop what it doesn't declare, so a handler sees only
 *    checked values.
 *
 * It also pins where a configured string becomes LogQL (`trustedLogQL`).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, RouteOptions } from "fastify";

const routes = vi.hoisted(() => [] as RouteOptions[]);

// Every Fastify instance the app builds records its routes as they register.
vi.mock("fastify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fastify")>();
  const factory = actual.default as unknown as (opts?: unknown) => FastifyInstance;
  const recording = (opts?: unknown) => {
    const app = factory(opts);
    app.addHook("onRoute", (route) => {
      routes.push(route);
    });
    return app;
  };
  return { ...actual, default: recording, fastify: recording };
});

const { buildApp } = await import("../app.js");

/** Property names that would carry query text. */
const QUERY_LIKE = /^(q|query|queries|expr|expression|promql|logql|sql|selector|matcher|matchers|filter|filters|pipeline|regex|pattern)$/i;

/** Where the routes that read Prometheus or Loki live. */
const STORE_ROUTES = /^\/api\/(metrics|transactions|error-requests|requests)(\/|$)/;

interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  maxLength?: number;
  format?: string;
  additionalProperties?: boolean | JsonSchema;
}

/** Every property in a schema, nested ones included, with its path. */
function propertiesOf(schema: JsonSchema | undefined, at = ""): [string, JsonSchema][] {
  if (!schema || typeof schema !== "object") return [];
  const out: [string, JsonSchema][] = [];
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    out.push([`${at}${name}`, prop]);
    out.push(...propertiesOf(prop, `${at}${name}.`));
    if (prop.items) out.push([`${at}${name}[]`, prop.items], ...propertiesOf(prop.items, `${at}${name}[].`));
  }
  return out;
}

const isString = (s: JsonSchema) => s.type === "string" || (Array.isArray(s.type) && s.type.includes("string"));
const bounded = (s: JsonSchema) =>
  s.enum !== undefined || s.const !== undefined || s.pattern !== undefined || s.maxLength !== undefined || s.format !== undefined;

const SAVED: Record<string, string | undefined> = {};
const ENV = {
  AUTH_MODE: "enabled",
  AUTH_SECRET: "test-secret-for-auth-tests-32-chars!",
  // Unroutable (RFC 5737): the lazy connect loop fails fast, nothing is read.
  DATABASE_URL: "postgres://sr:x@192.0.2.1:5432/na",
  TOTP_ENCRYPTION_KEY: "Ozw3vJk9pQ0sT6xN2mB8fH4dR1yL5aC7eU3gI9oK0jM=",
  INTERNAL_AUTH_SECRET: "test-internal-secret-32-characters!",
  LOKI_URL: "http://loki.invalid:3100",
};

let app: FastifyInstance;

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    SAVED[k] = process.env[k];
    process.env[k] = v;
  }
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("route schemas", () => {
  it("registers the routes it walks", () => {
    const urls = routes.map((r) => r.url);
    expect(urls).toContain("/api/metrics/upstream-detail");
    expect(urls).toContain("/api/error-requests");
    expect(urls).toContain("/api/audit/events");
    expect(urls).not.toContain("/api/metrics/query");
  });

  it("no route takes a property named like query text", () => {
    const offenders: string[] = [];
    for (const r of routes) {
      const s = (r.schema ?? {}) as Record<string, JsonSchema | undefined>;
      for (const part of ["querystring", "params", "body"] as const) {
        for (const [name] of propertiesOf(s[part])) {
          const leaf = name.split(".").pop()!.replace("[]", "");
          if (QUERY_LIKE.test(leaf)) offenders.push(`${String(r.method)} ${r.url} ${part}.${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every querystring and params string is bounded", () => {
    const offenders: string[] = [];
    for (const r of routes) {
      const s = (r.schema ?? {}) as Record<string, JsonSchema | undefined>;
      for (const part of ["querystring", "params"] as const) {
        for (const [name, prop] of propertiesOf(s[part])) {
          if (isString(prop) && !bounded(prop)) offenders.push(`${String(r.method)} ${r.url} ${part}.${name}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every route that reads the metrics store or the logs declares its querystring and drops the rest", () => {
    const offenders: string[] = [];
    for (const r of routes) {
      if (!STORE_ROUTES.test(r.url)) continue;
      const methods = [r.method].flat();
      if (!methods.includes("GET")) continue;
      const qs = (r.schema as { querystring?: JsonSchema } | undefined)?.querystring;
      // `/api/metrics/routers` and `/api/metrics/reads` take nothing.
      if (!qs) {
        if (!["/api/metrics/routers", "/api/metrics/reads"].includes(r.url)) offenders.push(`${r.url}: no querystring schema`);
        continue;
      }
      if (qs.additionalProperties !== false) offenders.push(`${r.url}: keeps undeclared parameters`);
      const params = (r.schema as { params?: JsonSchema } | undefined)?.params;
      if (params && params.additionalProperties !== false) offenders.push(`${r.url}: keeps undeclared path parameters`);
    }
    expect(offenders).toEqual([]);
  });
});

describe("configured query text", () => {
  /** Every .ts file under a directory, tests left out. */
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) return name === "__tests__" ? [] : sources(p);
      return p.endsWith(".ts") ? [p] : [];
    });
  }

  it("only the Loki plugin turns a configured string into LogQL", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const roots = [path.join(here, ".."), path.join(here, "../../../../packages/shared/src")];
    const callers = roots
      .flatMap(sources)
      .filter((f) => !f.endsWith(path.join("promql", "query-text.ts")))
      .filter((f) => /\btrustedLogQL\(/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(path.join(here, "../../../.."), f));
    expect(callers).toEqual([path.join("apps", "api", "src", "plugins", "loki.ts")]);
  });
});
