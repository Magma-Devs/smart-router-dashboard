import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { readUsageSettings } from "../config.js";
import { toMixpanel, viewerOf } from "../services/usage.js";
import Fastify from "fastify";
import { usageRoutes } from "../routes/usage.js";
import { USAGE_VIEWS } from "@sr/shared";

/* Usage data (MAG-5373): the web's events go to POST /api/usage, and only what
   the catalog allows reaches Mixpanel, server side, tagged with the tenant. */

const VISIT = "3f2c9a1e-7b4d-4c3e-9a1f-0d2e5b6c7a8f";
const TOKEN = "test-project-token";
const KEYS = ["DEPLOYMENT_MODE", "USAGE_ANALYTICS", "MIXPANEL_TOKEN", "MIXPANEL_API_HOST", "USAGE_TENANT", "TENANT_ID", "APP_VERSION"];

let app: FastifyInstance;
let sent: { url: string; body: unknown }[];

async function boot(env: Record<string, string>) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  sent = [];
  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
    const url = input.toString();
    if (url.includes("/track")) sent.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response("1", { status: 200 });
  });
  app = await buildApp();
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const post = (body: unknown) => app.inject({ method: "POST", url: "/api/usage", payload: body as object });

afterEach(async () => {
  await app?.close();
  for (const k of KEYS) delete process.env[k];
  vi.unstubAllGlobals();
});

describe("POST /api/usage on a deployment we host", () => {
  beforeEach(() => boot({ DEPLOYMENT_MODE: "managed", MIXPANEL_TOKEN: TOKEN, TENANT_ID: "tenant-a", APP_VERSION: "0.69.9" }));

  it("says it is on", async () => {
    expect((await app.inject({ method: "GET", url: "/api/usage/config" })).json()).toEqual({ enabled: true });
  });

  it("forwards the catalog's fields to Mixpanel's EU track endpoint, tagged with the tenant, without the client's address", async () => {
    const now = Date.now();
    const res = await post({
      visit: VISIT,
      events: [
        { name: "search", at: now, seq: 0, props: { kind: "hash", from: "top-bar", result: "found", seconds: 4.2, value: "0xabc", email: "a@b.c" } },
        { name: "password_typed", at: now, seq: 1, props: {} },
        { name: "tab_change", at: now, seq: 2, props: { from: "metrics", to: "errors" } },
      ],
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: 2 });
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://api-eu.mixpanel.com/track?ip=0&strict=1");
    const [search, tab] = sent[0]!.body as { event: string; properties: Record<string, unknown> }[];
    expect(search).toEqual({
      event: "search",
      properties: expect.objectContaining({ kind: "hash", from: "top-bar", result: "found", seconds: 4.2, token: TOKEN, distinct_id: VISIT, tenant: "tenant-a", deployment_mode: "managed", dashboard_version: "0.69.9", time: now }),
    });
    expect(search!.properties).not.toHaveProperty("value");
    expect(search!.properties).not.toHaveProperty("email");
    expect(String(search!.properties.$insert_id)).toMatch(/^[0-9a-f]{32}$/);
    expect(tab!.event).toBe("tab_change");
  });

  it("takes the api's time for a browser clock far off", async () => {
    await post({ visit: VISIT, events: [{ name: "load_older", at: 0, seq: 0, props: { list: "errors" } }] });
    await settle();
    const t = (sent[0]!.body as { properties: { time: number } }[])[0]!.properties.time;
    expect(Math.abs(Date.now() - t)).toBeLessThan(5_000);
  });

  it("refuses a visit id that isn't random characters, and a batch over 50", async () => {
    expect((await post({ visit: "omer@example.com", events: [] })).statusCode).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) => ({ name: "page_view", at: Date.now(), seq: i, props: {} }));
    expect((await post({ visit: VISIT, events: many })).statusCode).toBe(400);
    expect(sent).toHaveLength(0);
  });
});

describe("where usage data is off", () => {
  it("a self-hosted deployment sends nothing by default, token or not", async () => {
    await boot({ DEPLOYMENT_MODE: "onprem", MIXPANEL_TOKEN: TOKEN });
    expect((await app.inject({ method: "GET", url: "/api/usage/config" })).json()).toEqual({ enabled: false });
    const res = await post({ visit: VISIT, events: [{ name: "page_view", at: Date.now(), seq: 0, props: { page: "metrics" } }] });
    expect(res.statusCode).toBe(204);
    await settle();
    expect(sent).toHaveLength(0);
  });

  it("a hosted deployment without a token sends nothing", async () => {
    await boot({ DEPLOYMENT_MODE: "managed" });
    expect((await app.inject({ method: "GET", url: "/api/usage/config" })).json()).toEqual({ enabled: false });
  });
});

describe("readUsageSettings", () => {
  it("is on for a hosted deployment with a token, off for a self-hosted one unless switched on", () => {
    expect(readUsageSettings({ DEPLOYMENT_MODE: "managed", MIXPANEL_TOKEN: TOKEN }).enabled).toBe(true);
    expect(readUsageSettings({ DEPLOYMENT_MODE: "managed", MIXPANEL_TOKEN: TOKEN, USAGE_ANALYTICS: "off" }).enabled).toBe(false);
    expect(readUsageSettings({ MIXPANEL_TOKEN: TOKEN }).enabled).toBe(false);
    expect(readUsageSettings({ MIXPANEL_TOKEN: TOKEN, USAGE_ANALYTICS: "on" }).enabled).toBe(true);
  });

  it("names the tenant from USAGE_TENANT, else TENANT_ID", () => {
    expect(readUsageSettings({ TENANT_ID: "t1" }).tenant).toBe("t1");
    expect(readUsageSettings({ TENANT_ID: "t1", USAGE_TENANT: "t2" }).tenant).toBe("t2");
    expect(readUsageSettings({}).tenant).toBe("unnamed");
  });

  it("says why it is off when switched on without a token or with a plain-http host", () => {
    expect(readUsageSettings({ USAGE_ANALYTICS: "on" })).toMatchObject({ enabled: false, problem: "MIXPANEL_TOKEN is not set" });
    expect(readUsageSettings({ USAGE_ANALYTICS: "on", MIXPANEL_TOKEN: TOKEN, MIXPANEL_API_HOST: "http://evil.example" }))
      .toMatchObject({ enabled: false, problem: "MIXPANEL_API_HOST must be https" });
    expect(readUsageSettings({ USAGE_ANALYTICS: "on", MIXPANEL_TOKEN: TOKEN, MIXPANEL_API_HOST: "http://127.0.0.1:9999" }))
      .toMatchObject({ enabled: true, host: "http://127.0.0.1:9999" });
  });
});

describe("staff and role on each event", () => {
  const s = readUsageSettings({ DEPLOYMENT_MODE: "managed", MIXPANEL_TOKEN: TOKEN, TENANT_ID: "t" });
  it("marks a signed-in user on our domain as staff, with the role, never the address", () => {
    const viewer = viewerOf({ email: "someone@magmadevs.com", role: "admin" }, s);
    expect(viewer).toEqual({ staff: true, role: "admin" });
    const [e] = toMixpanel(VISIT, [{ name: "page_view", at: Date.now(), seq: 0, props: { page: "metrics" } }], s, Date.now(), viewer);
    expect(e!.properties).toMatchObject({ staff: true, role: "admin" });
    expect(JSON.stringify(e)).not.toContain("magmadevs.com");
    expect(viewerOf({ email: "ops@client.example", role: "read_only" }, s)).toEqual({ staff: false, role: "read_only" });
  });
  it("says nothing about the viewer with accounts off", () => {
    expect(viewerOf(null, s)).toBeNull();
    const [e] = toMixpanel(VISIT, [{ name: "page_view", at: Date.now(), seq: 0, props: {} }], s);
    expect(e!.properties).not.toHaveProperty("staff");
  });
});

describe("the process-wide cap on forwarded batches", () => {
  it("drops batches past the minute's budget, every caller together", async () => {
    const forwarded: unknown[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => { forwarded.push(init?.body); return new Response("1"); }) as unknown as typeof fetch;
    const local = Fastify();
    await local.register(usageRoutes, { settings: readUsageSettings({ DEPLOYMENT_MODE: "managed", MIXPANEL_TOKEN: TOKEN }), fetchImpl, podBatchesPerMin: 2 });
    const body = { visit: VISIT, events: [{ name: "page_view", at: Date.now(), seq: 0, props: { page: "metrics" } }] };
    const answers = [];
    for (let i = 0; i < 3; i++) answers.push((await local.inject({ method: "POST", url: "/api/usage", payload: body })).json());
    await new Promise((r) => setTimeout(r, 0));
    expect(answers).toEqual([{ accepted: 1 }, { accepted: 1 }, { accepted: 0 }]);
    expect(forwarded).toHaveLength(2);
    await local.close();
  });
});

describe("the views a usage event may name", () => {
  it("list every read the api registers, so a new one is added there and never passed through as written", async () => {
    await boot({});
    await app.ready();
    const paths = (app.swagger().paths ?? {}) as Record<string, Record<string, unknown>>;
    const reads = Object.entries(paths)
      .filter(([path, methods]) => path.startsWith("/api/") && "get" in methods)
      .map(([path]) => path.replace(/\{[^}]+\}/g, ":id"));
    expect(reads.length).toBeGreaterThan(20);
    expect(reads.filter((path) => !(USAGE_VIEWS as readonly string[]).includes(path))).toEqual([]);
  });
});
