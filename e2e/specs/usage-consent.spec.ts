import { gunzipSync } from "node:zlib";
import type { Page, Request } from "@playwright/test";
import { expect, signInThroughUi, test } from "../support/fixtures.js";

/**
 * Usage data through Mixpanel's browser SDK, and the consent banner in front
 * of it (MAG-5373).
 *
 * The unit tests hold the rules one call at a time. What only a browser shows
 * is the whole of it: that nothing from Mixpanel is loaded, stored or sent
 * while the banner is up; that an acceptance loads the SDK, which records page
 * views (client-side navigation too), clicks and a session replay, every event
 * tagged with the tenant and with its URLs redacted; that the replay masks
 * what was typed and is scrubbed of addresses, hashes and ids before it is
 * uploaded; that Mixpanel's EU host is the only one contacted; that each
 * "no" stops it and removes what it kept; and that the banner fits a phone and
 * reads in the light theme.
 *
 * The suite's stack has usage data off, so the api's config route is answered
 * here as a deployment with it on, and Mixpanel's host is answered here too:
 * every request the SDK makes is kept, decoded, and never leaves the machine.
 */

const CONFIG = {
  enabled: true,
  token: "e2e-project-token",
  apiHost: "https://api-eu.mixpanel.com",
  tenant: "e2e-tenant",
  deploymentMode: "managed",
  version: "0.71.0",
  viewer: { id: "0123456789abcdef0123456789abcdef", staff: false, role: "admin" },
};
const MIXPANEL = CONFIG.apiHost;
/** Where the signed-in person's answer is kept: per account, per consent version. */
const KEY = `sr:usage-consent:2:${CONFIG.viewer.id}`;
const answer = (page: Page, key = KEY) => page.evaluate((k) => localStorage.getItem(k), key);
/** A caller's own request ID in a look-up link: it must never reach Mixpanel's events. */
const TYPED = "john-smith-order-42";

interface Sent {
  /** `track`, `engage` or `record`. */
  kind: string;
  url: string;
  body: string;
}

/** A request to Mixpanel as its payload reads: events and profile updates are form-encoded base64 JSON, a replay is gzipped JSON. */
function decode(req: Request): Sent {
  const url = new URL(req.url());
  const buf = req.postDataBuffer();
  let body = "";
  if (buf && url.searchParams.get("format") === "gzip") body = gunzipSync(buf).toString("utf8");
  else if (buf) {
    const data = new URLSearchParams(buf.toString("utf8")).get("data");
    body = data === null ? buf.toString("utf8") : data.trimStart().startsWith("[") || data.trimStart().startsWith("{") ? data : Buffer.from(data, "base64").toString("utf8");
  }
  return { kind: url.pathname.split("/")[1] ?? "", url: url.toString(), body };
}

async function withUsageOn(page: Page): Promise<{ sent: Sent[]; offsite: Set<string> }> {
  const sent: Sent[] = [];
  const offsite = new Set<string>();
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.hostname !== "localhost" && u.hostname !== "127.0.0.1") offsite.add(u.origin);
  });
  await page.route("**/api/usage/config", (route) => route.fulfill({ json: CONFIG }));
  await page.route(`${MIXPANEL}/**`, (route) => {
    sent.push(decode(route.request()));
    const origin = route.request().headers()["origin"] ?? "*";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: 1, error: null }),
      headers: { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", "access-control-allow-headers": "*" },
    });
  });
  return { sent, offsite };
}

interface MpEvent {
  event: string;
  properties: Record<string, unknown>;
}
const events = (sent: Sent[]): MpEvent[] => sent.filter((s) => s.kind === "track").flatMap((s) => JSON.parse(s.body) as MpEvent[]);
const named = (sent: Sent[], name: string) => events(sent).filter((e) => e.event === name);

/** What Mixpanel's SDK has in this browser: its keys, cookies, databases, and whether its code was loaded. */
async function sdkTraces(page: Page) {
  return page.evaluate(async () => ({
    storage: [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((k) => /^(mp_|__mp)/.test(k)),
    cookies: document.cookie,
    databases: (await indexedDB.databases()).map((d) => d.name ?? "").filter((n) => /mixpanel|__mprec/i.test(n)),
    chunks: performance.getEntriesByType("resource").map((e) => e.name).filter((n) => n.startsWith(location.origin) && /mixpanel/i.test(n)),
  }));
}

/** Rows left in the SDK's replay database, 0 when there is none. */
async function replayRows(page: Page): Promise<number> {
  return page.evaluate(async () => {
    if (!(await indexedDB.databases()).some((d) => d.name === "mixpanelBrowserDb")) return 0;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("mixpanelBrowserDb");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    let rows = 0;
    for (const name of Array.from(db.objectStoreNames)) {
      rows += await new Promise<number>((resolve) => {
        const count = db.transaction(name).objectStore(name).count();
        count.onsuccess = () => resolve(count.result);
        count.onerror = () => resolve(0);
      });
    }
    db.close();
    return rows;
  });
}

/** Every text and input value a replay recorded. */
function replayText(sent: Sent[]): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if ((k === "textContent" || k === "value" || k === "text") && typeof x === "string") out.push(x);
        else walk(x);
      }
    }
  };
  for (const s of sent.filter((r) => r.kind === "record")) walk(JSON.parse(s.body));
  return out;
}

/** Longer than the replay's upload interval (10 s) and the events' (5 s): anything due would have gone. */
const SEND_WINDOW_MS = 12_000;

test("nothing reaches Mixpanel until Accept; then it records, redacted and replayed, until it is turned off", async ({ page, operator }) => {
  test.setTimeout(180_000);
  const { sent, offsite } = await withUsageOn(page);
  await signInThroughUi(page, operator);

  const bar = page.getByRole("region", { name: "Cookies & analytics" });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("Mixpanel also records clicks, pages and session replays, with text hidden.");
  await expect(bar.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "https://magmadevs.com/privacy");
  await expect(bar.getByRole("link", { name: "Terms & Conditions" })).toHaveAttribute("href", "https://magmadevs.com/terms");
  // Docked bottom-right, inside the window, and clear of nothing it needs.
  const box = (await bar.boundingBox())!;
  const view = page.viewportSize()!;
  expect(box.x + box.width).toBeLessThanOrEqual(view.width);
  expect(box.y + box.height).toBeLessThanOrEqual(view.height);
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/consent-bar.png` });

  // The page behind the banner is in use, and nothing of Mixpanel's is loaded, kept or sent.
  await page.getByRole("link", { name: "Account" }).first().click();
  await page.waitForURL(/\/account$/);
  await page.waitForTimeout(3_000);
  expect(sent, "a request reached Mixpanel before an acceptance").toHaveLength(0);
  expect([...offsite]).toEqual([]);
  expect(await sdkTraces(page)).toEqual({ storage: [], cookies: "", databases: [], chunks: [] });
  expect(await answer(page)).toBeNull();

  await bar.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(bar).toBeHidden();
  expect(await answer(page)).toBe("accepted");

  // The page at the acceptance is viewed, by the viewer's opaque id, tagged with the tenant.
  await expect.poll(() => named(sent, "$mp_web_page_view").length, { timeout: 15_000 }).toBeGreaterThan(0);
  const first = named(sent, "$mp_web_page_view")[0]!.properties;
  expect(first).toMatchObject({
    distinct_id: CONFIG.viewer.id,
    tenant: "e2e-tenant",
    deployment_mode: "managed",
    dashboard_version: "0.71.0",
    staff: false,
    role: "admin",
    current_url_path: "/account",
  });
  expect(first.$current_url).toMatch(/^http:\/\/localhost:3000\/account$/);
  expect((await sdkTraces(page)).chunks.length, "the SDK is its own chunk, loaded now").toBeGreaterThan(0);

  // A shared look-up link: its URL carries the request, the events carry :id.
  await page.goto(`/metrics?tab=errors&request=${TYPED}`);
  const metricsViews = () => named(sent, "$mp_web_page_view").filter((e) => e.properties.current_url_path === "/metrics");
  await expect.poll(() => metricsViews().length, { timeout: 15_000 }).toBeGreaterThan(0);
  const looked = metricsViews()[0]!.properties;
  expect(looked).toMatchObject({ tenant: "e2e-tenant" });
  expect(looked.$current_url).toMatch(/[?&]request=:id(&|$)/);
  expect(looked.$current_url).toMatch(/[?&]tab=errors(&|$)/);
  expect(JSON.stringify(sent), "an event carried the request").not.toContain(TYPED);

  // A client-side navigation is a page view of its own, without a page load.
  await page.evaluate(() => { (window as unknown as { __samePage: boolean }).__samePage = true; });
  await page.getByRole("link", { name: "Upstreams" }).first().click();
  await page.waitForURL(/\/upstreams$/);
  await expect.poll(() => named(sent, "$mp_web_page_view").map((e) => e.properties.current_url_path), { timeout: 15_000 }).toContain("/upstreams");
  expect(await page.evaluate(() => (window as unknown as { __samePage?: boolean }).__samePage)).toBe(true);
  expect(named(sent, "$mp_click").length, "clicks are captured").toBeGreaterThan(0);

  // A click on the element whose title is the signed-in address: the click is captured, its title and labels are not.
  await page.locator(".gw-app .email").first().click();
  const onEmail = () => named(sent, "$mp_click").filter((e) => JSON.stringify(e.properties.$target ?? {}).includes('"email"'));
  await expect.poll(() => onEmail().length, { timeout: 15_000 }).toBeGreaterThan(0);
  for (const e of named(sent, "$mp_click")) {
    expect(JSON.stringify(e.properties), "a click carried a title or a label").not.toMatch(/"\$attr-(title|aria-label|aria-labelledby|aria-describedby)"/);
  }

  // A session replay is uploaded, and what was typed is masked in it.
  await expect.poll(() => sent.filter((s) => s.kind === "record").length, { timeout: 30_000 }).toBeGreaterThan(0);
  const texts = replayText(sent);
  expect(texts.length).toBeGreaterThan(0);
  expect(texts.filter((t) => t.includes(TYPED))).toEqual([]);

  // No event, profile update or replay carries what was typed or the address, and only Mixpanel's EU host was contacted.
  for (const s of sent) {
    expect(s.body, `${s.kind} carried the look-up`).not.toContain(TYPED);
    expect(s.url).not.toContain(TYPED);
    expect(s.body.toLowerCase()).not.toContain(operator.email.toLowerCase());
  }
  for (const e of events(sent)) expect(e.properties.tenant, e.event).toBe("e2e-tenant");
  expect([...offsite]).toEqual([MIXPANEL]);
  expect((await sdkTraces(page)).cookies, "the SDK keeps nothing in cookies").toBe("");

  // The Account page says so, and takes it back.
  await page.getByRole("link", { name: "Account" }).first().click();
  const off = page.getByRole("button", { name: "Turn off" });
  await expect(off).toBeVisible();
  await expect(page.locator(".gw-usage-note")).toContainText("Mixpanel records clicks, pages and session replays, with text hidden.");
  if (process.env.E2E_SHOTS) {
    await off.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${process.env.E2E_SHOTS}/account-usage.png` });
  }
  await off.click();
  await expect(page.getByRole("button", { name: "Turn on" })).toBeVisible();
  expect(await answer(page)).toBe("rejected");
  await expect.poll(async () => (await sdkTraces(page)).storage).toEqual([]);
  expect((await sdkTraces(page)).cookies).toBe("");
  await expect.poll(() => replayRows(page)).toBe(0);
  const atOff = sent.length;
  await page.waitForTimeout(SEND_WINDOW_MS);
  expect(sent.length, "Mixpanel was sent to after it was turned off").toBe(atOff);

  // Turned on again on the same page, it records again.
  await page.getByRole("button", { name: "Turn on" }).click();
  await expect.poll(() => sent.length, { timeout: 15_000 }).toBeGreaterThan(atOff);
  await page.getByRole("button", { name: "Turn off" }).click();
  await expect.poll(async () => (await sdkTraces(page)).storage).toEqual([]);

  // The next page load loads nothing of Mixpanel's and deletes its database.
  await page.waitForTimeout(SEND_WINDOW_MS);
  const atReload = sent.length;
  await page.reload();
  await expect(page.getByRole("button", { name: "Turn on" })).toBeVisible();
  await expect.poll(async () => (await sdkTraces(page)).databases).toEqual([]);
  await page.waitForTimeout(3_000);
  expect(await sdkTraces(page)).toEqual({ storage: [], cookies: "", databases: [], chunks: [] });
  expect(sent.length).toBe(atReload);
});

test("a replay upload is scrubbed before it leaves the browser: no typed value, hash, id, title or address", async ({ page, operator }) => {
  test.setTimeout(120_000);
  const HASH = "0x" + "cd".repeat(32);
  const GUID = "7708800000000000042";
  const TITLE = "on the chain's explorer";
  const { sent } = await withUsageOn(page);
  await signInThroughUi(page, operator);
  // A shared look-up link, and an explorer link of the kind the request tables render.
  await page.goto(`/metrics?tab=errors&request=${TYPED}`);
  await expect(page.getByRole("region", { name: "Cookies & analytics" })).toBeVisible();
  await page.evaluate(({ hash, guid, title }) => {
    const a = document.createElement("a");
    Object.assign(a, { id: guid, href: `https://etherscan.io/tx/${hash}`, title: `${hash} - ${title}`, textContent: hash.slice(0, 10) });
    a.setAttribute("aria-label", `Copy ${hash}`);
    a.setAttribute("data-guid", guid);
    document.querySelector(".gw-app")!.appendChild(a);
  }, { hash: HASH, guid: GUID, title: TITLE });
  await page.getByRole("region", { name: "Cookies & analytics" }).getByRole("button", { name: "Accept", exact: true }).click();

  await expect.poll(() => sent.filter((s) => s.kind === "record").length, { timeout: 30_000 }).toBeGreaterThan(0);
  const uploads = sent.filter((s) => s.kind === "record");
  for (const u of uploads) {
    for (const secret of [TYPED, HASH, GUID, TITLE, operator.email]) {
      expect(u.body, `the replay carried ${secret}`).not.toContain(secret);
      expect(decodeURIComponent(u.url), `the replay's URL carried ${secret}`).not.toContain(secret);
    }
  }
  // Scrubbed, not missing: the page's route, and the link by its site alone.
  const first = uploads[0]!;
  expect(new URL(first.url).searchParams.get("$current_url")).toMatch(/\/metrics\?(.*&)?request=:id/);
  expect(first.body).toContain("request=:id");
  expect(first.body).toContain('"href":"https://etherscan.io"');
});

test("an answer belongs to one account and to this release; signing out makes the SDK forget the account", async ({ page, operator }) => {
  test.setTimeout(120_000);
  const { sent, offsite } = await withUsageOn(page);
  // 0.70.0's answer, which asked about events only: not read, the banner asks again.
  await page.addInitScript(() => {
    try { localStorage.setItem("sr:usage-consent", "accepted"); } catch { /* ignore */ }
  });
  await signInThroughUi(page, operator);
  const bar = page.getByRole("region", { name: "Cookies & analytics" });
  await expect(bar).toBeVisible();
  await page.waitForTimeout(2_000);
  expect(sent, "an answer from 0.70.0 started usage data").toHaveLength(0);
  expect(await sdkTraces(page)).toEqual({ storage: [], cookies: "", databases: [], chunks: [] });

  // This account accepts.
  await bar.getByRole("button", { name: "Accept", exact: true }).click();
  await expect.poll(() => named(sent, "$mp_web_page_view").length, { timeout: 15_000 }).toBeGreaterThan(0);
  const firstDevice = named(sent, "$mp_web_page_view")[0]!.properties.$device_id;
  expect(firstDevice).toBeTruthy();

  // Another account on this browser is asked for its own answer, and nothing of the first one's is kept for it.
  const other = { ...CONFIG, viewer: { id: "fedcba9876543210fedcba9876543210", staff: true, role: "read_only" } };
  await page.route("**/api/usage/config", (route) => route.fulfill({ json: other }));
  await page.reload();
  await expect(bar).toBeVisible();
  await expect.poll(async () => (await sdkTraces(page)).storage).toEqual([]);
  await expect.poll(async () => (await sdkTraces(page)).databases).toEqual([]);
  expect(events(sent).filter((e) => e.properties.distinct_id === other.viewer.id), "sent for an account that has not answered").toEqual([]);
  await bar.getByRole("button", { name: "Accept", exact: true }).click();
  const otherViews = () => named(sent, "$mp_web_page_view").filter((e) => e.properties.distinct_id === other.viewer.id);
  await expect.poll(() => otherViews().length, { timeout: 15_000 }).toBeGreaterThan(0);
  expect(otherViews()[0]!.properties.$device_id, "the second account shares the first one's device").not.toBe(firstDevice);
  for (const e of events(sent).filter((x) => x.properties.distinct_id === other.viewer.id)) {
    expect(e.properties.$anon_distinct_id, `${e.event} links the two accounts`).not.toBe(CONFIG.viewer.id);
  }
  expect(await answer(page, `sr:usage-consent:2:${other.viewer.id}`)).toBe("accepted");
  expect(await answer(page), "the first account's answer stays with it").toBe("accepted");

  // Signing out: the SDK forgets the account, and whose its storage was.
  // Dispatched on the button: the dev server's overlay badge sits over the collapsed sidebar's foot.
  await page.getByTitle("Sign out").dispatchEvent("click");
  await page.waitForURL(/\/login/);
  const left = await page.evaluate(() => ({
    owner: localStorage.getItem("sr:usage-sdk-viewer"),
    ids: Object.entries(localStorage).filter(([k]) => k.startsWith("mp_")).map(([, v]) => {
      try { return String((JSON.parse(v) as { distinct_id?: unknown }).distinct_id ?? ""); } catch { return ""; }
    }),
  }));
  expect(left.owner).toBeNull();
  for (const id of left.ids) expect(id, "the SDK still names the signed-out account").not.toBe(other.viewer.id);
  expect([...offsite]).toEqual([MIXPANEL]);
});

for (const [answer, button] of [["Decline", "Decline"], ["the X", "Dismiss cookie banner"]] as const) {
  test(`${answer} loads nothing of Mixpanel's and is not asked again`, async ({ page, operator }) => {
    const { sent, offsite } = await withUsageOn(page);
    await signInThroughUi(page, operator);
    const bar = page.getByRole("region", { name: "Cookies & analytics" });
    await bar.getByRole("button", { name: button }).click();
    await expect(bar).toBeHidden();
    await page.waitForTimeout(3_000);
    expect(await sdkTraces(page)).toEqual({ storage: [], cookies: "", databases: [], chunks: [] });
    await page.reload();
    await expect(page.locator(".gw-app")).toBeVisible();
    await expect(bar).toBeHidden();
    await page.waitForTimeout(3_000);
    expect(sent).toHaveLength(0);
    expect([...offsite]).toEqual([]);
    expect(await sdkTraces(page)).toEqual({ storage: [], cookies: "", databases: [], chunks: [] });
  });
}

test("on a phone the banner fits the screen and its buttons stay in reach", async ({ page, operator }) => {
  await withUsageOn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await signInThroughUi(page, operator);
  const bar = page.getByRole("region", { name: "Cookies & analytics" });
  await expect(bar).toBeVisible();
  const box = (await bar.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  for (const name of ["Decline", "Accept"]) {
    const b = (await bar.getByRole("button", { name, exact: true }).boundingBox())!;
    expect(b.x + b.width, `${name} runs off the screen`).toBeLessThanOrEqual(390);
  }
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/consent-phone.png` });
});

test("in the light theme the banner reads", async ({ page, operator }) => {
  await withUsageOn(page);
  await page.addInitScript(() => {
    try { localStorage.setItem("sr:theme", "light"); } catch { /* ignore */ }
  });
  await signInThroughUi(page, operator);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  const bar = page.getByRole("region", { name: "Cookies & analytics" });
  await expect(bar).toBeVisible();
  if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/consent-light.png` });
});

test("where the deployment records no usage data there is no banner and no SDK", async ({ page, operator }) => {
  await signInThroughUi(page, operator);
  await expect(page.locator(".gw-app")).toBeVisible();
  await expect(page.getByRole("region", { name: "Cookies & analytics" })).toBeHidden();
  await page.waitForTimeout(2_000);
  expect(await sdkTraces(page)).toEqual({ storage: [], cookies: "", databases: [], chunks: [] });
});
