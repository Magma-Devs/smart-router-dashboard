import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installReplayScrubber,
  replayUploadsDropped,
  scrubAttributes,
  scrubRecordUpload,
  scrubRecordUrl,
  scrubReplayEvents,
} from "../usage-replay";

/* Session replay uploads (MAG-5402): the SDK masks a replay's text and inputs,
   not the page's address or the elements' attributes, so every upload is
   scrubbed before it leaves the browser, and one that can't be is not sent.
   `fixtures/replay-upload.json` is a real upload the SDK made in the e2e
   stack before the scrubber existed (inlined CSS and scripts taken out): a
   look-up's typed value sits in its URL and its meta event, and the
   signed-in person's address in a `title`. */

const ORIGIN = "http://localhost:3000";
const fixture = JSON.parse(readFileSync(new URL("./fixtures/replay-upload.json", import.meta.url), "utf8")) as { url: string; events: unknown[] };
const TYPED = "john-smith-order-42";
const ADDRESS = "e2e.operator@example.com";
const HASH = "0x" + "ab".repeat(32);
const GUID = "7708800000000000042";

interface Node { type: number; tagName?: string; attributes?: Record<string, unknown>; childNodes?: Node[] }

function elements(events: unknown[]): Node[] {
  const out: Node[] = [];
  const walk = (n: Node) => {
    if (n.type === 2) out.push(n);
    for (const c of n.childNodes ?? []) walk(c);
  };
  for (const e of events as { type: number; data: { node?: Node } }[]) if (e.type === 2 && e.data.node) walk(e.data.node);
  return out;
}

/** An explorer link of the kind the request tables render, with a value in every attribute that can hold one. */
const hashLink = (): Node => ({
  type: 2,
  tagName: "a",
  attributes: {
    class: "gw-mono",
    href: `https://etherscan.io/tx/${HASH}`,
    title: `${HASH} - on the chain's explorer`,
    "aria-label": `Copy ${HASH}`,
    id: GUID,
    "data-guid": GUID,
    alt: ADDRESS,
  },
  childNodes: [{ type: 3, textContent: "*".repeat(10) } as Node],
});

/** The fixture with the explorer link in its body, in a node added later, and set again by an attribute change. */
function withHashLink(): unknown[] {
  const events = structuredClone(fixture.events) as { type: number; data: { node?: Node } }[];
  const body = elements(events).find((n) => n.tagName === "body")!;
  body.childNodes!.push(hashLink());
  return [
    ...events,
    {
      type: 3,
      timestamp: 1,
      data: {
        source: 0,
        texts: [],
        removes: [],
        adds: [{ parentId: 1, nextId: null, node: hashLink() }],
        attributes: [{ id: 99, attributes: { title: `Customer - the project-id header the caller sent: ${ADDRESS}`, href: `/metrics?tab=request&request=${TYPED}`, "data-x": null } }],
      },
    },
  ];
}

describe("a replay's events", () => {
  it("carry nothing typed, no address, hash or request ID once scrubbed, from a real upload", () => {
    const raw = JSON.stringify(withHashLink());
    for (const secret of [TYPED, ADDRESS, HASH, GUID]) expect(raw, secret).toContain(secret);
    const out = JSON.stringify(scrubReplayEvents(withHashLink(), ORIGIN));
    for (const secret of [TYPED, ADDRESS, HASH, GUID, "on the chain's explorer", "project-id header"]) expect(out, secret).not.toContain(secret);
  });

  it("keep the page's route, our own ids, links by route and the styles' fixed-set data, node for node", () => {
    const before = elements(fixture.events);
    const scrubbed = scrubReplayEvents(fixture.events, ORIGIN);
    const after = elements(scrubbed);
    expect(after.map((n) => n.tagName)).toEqual(before.map((n) => n.tagName));
    const meta = (scrubbed as { type: number; data: { href?: string } }[]).find((e) => e.type === 4)!;
    expect(meta.data.href).toBe(`${ORIGIN}/metrics?request=:id&tab=request&window=30m`);
    const attrs = after.flatMap((n) => Object.keys(n.attributes ?? {}));
    for (const gone of ["title", "aria-label", "placeholder", "value"]) expect(attrs, gone).not.toContain(gone);
    expect(after.find((n) => n.attributes?.id === "gw-request-search")).toBeTruthy();
    expect(after.filter((n) => n.tagName === "a").map((n) => n.attributes?.href)).toEqual(expect.arrayContaining([`${ORIGIN}/metrics`, `${ORIGIN}/upstreams`]));
    expect(after.find((n) => n.tagName === "html")?.attributes?.["data-theme"]).toBe("dark");
  });

  it("redact an added node and an attribute change the same way", () => {
    const events = scrubReplayEvents(withHashLink(), ORIGIN) as { type: number; data: Record<string, unknown> }[];
    const mutation = events.at(-1)!.data as { adds: { node: Node }[]; attributes: { attributes: Record<string, unknown> }[] };
    expect(mutation.adds[0]!.node.attributes).toEqual({ class: "gw-mono", href: "https://etherscan.io" });
    expect(mutation.attributes[0]!.attributes).toEqual({ href: "/metrics?tab=request&request=:id", "data-x": null });
  });
});

describe("an element's attributes", () => {
  it("keep link targets by route, drop free text and values, and keep only our own ids", () => {
    expect(scrubAttributes({
      href: `${ORIGIN}/invite/token-123`, src: "/_next/static/chunks/app.js", "xlink:href": "https://grafana.example/d/x?var-search=1",
      title: "t", alt: "a", placeholder: "p", value: "v", label: "l", download: "errors.csv", srcset: "a.png 1x",
      "aria-label": "Copy 0xabc", "aria-valuetext": "v", "aria-hidden": "true", "aria-expanded": "false",
      "data-guid": GUID, "data-theme": "light", "data-density": ADDRESS,
      id: GUID, for: "row-1", class: "gw-btn", style: "width: 40%", d: "M0 0L1 1", role: "button", type: "submit", name: "email",
    }, ORIGIN)).toEqual({
      href: `${ORIGIN}/invite/:id`, src: "/:id/:id/:id/:id", "xlink:href": "https://grafana.example",
      "aria-hidden": "true", "aria-expanded": "false", "data-theme": "light",
      class: "gw-btn", style: "width: 40%", d: "M0 0L1 1", role: "button", type: "submit", name: "email",
    });
    expect(scrubAttributes({ id: "gw-request-search", for: "gw-request-search", title: null }, ORIGIN)).toEqual({ id: "gw-request-search", for: "gw-request-search", title: null });
  });
});

describe("an upload's URL", () => {
  it("has every address in its query redacted, and nothing else changed", () => {
    expect(fixture.url).toContain(TYPED);
    const out = new URL(scrubRecordUrl(fixture.url, ORIGIN));
    const before = new URL(fixture.url);
    expect(out.toString()).not.toContain(TYPED);
    expect(out.searchParams.get("$current_url")).toBe(`${ORIGIN}/metrics?request=:id&tab=request&window=30m`);
    expect(out.searchParams.get("replay_start_url")).toBe(`${ORIGIN}/metrics?window=30m`);
    for (const k of ["replay_id", "seq", "distinct_id", "format", "batch_start_time"]) expect(out.searchParams.get(k), k).toBe(before.searchParams.get(k));
  });
});

const gzip = (text: string) => new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
const gunzip = (blob: Blob) => new Response(blob.stream().pipeThrough(new DecompressionStream("gzip"))).text();
const INIT = { method: "POST", headers: { Authorization: "Basic dG9rZW46", "Content-Type": "application/octet-stream" } };

describe("an upload", () => {
  it("is scrubbed in the encoding it came in, with the SDK's method and headers", async () => {
    const zipped = await scrubRecordUpload(fixture.url, { ...INIT, body: await gzip(JSON.stringify(withHashLink())) }, ORIGIN);
    expect(zipped.init.method).toBe("POST");
    expect(zipped.init.headers).toEqual(INIT.headers);
    const text = await gunzip(zipped.init.body as Blob);
    expect(JSON.parse(text)).toEqual(scrubReplayEvents(withHashLink(), ORIGIN));
    for (const secret of [TYPED, ADDRESS, HASH, GUID]) expect(text + zipped.url, secret).not.toContain(secret);

    const plainUrl = fixture.url.replace("format=gzip", "format=body");
    const plain = await scrubRecordUpload(plainUrl, { ...INIT, body: JSON.stringify(withHashLink()) }, ORIGIN);
    expect(JSON.parse(plain.init.body as string)).toEqual(scrubReplayEvents(withHashLink(), ORIGIN));
  });

  it("that can't be read or isn't a list of events is refused", async () => {
    await expect(scrubRecordUpload(fixture.url, { ...INIT, body: new Blob(["not gzip"]) }, ORIGIN)).rejects.toThrow();
    await expect(scrubRecordUpload(fixture.url, { ...INIT, body: await gzip('{"not":"a list"}') }, ORIGIN)).rejects.toThrow("not a list of events");
    await expect(scrubRecordUpload(fixture.url, { ...INIT, body: "plain text for a gzip upload" }, ORIGIN)).rejects.toThrow();
  });
});

describe("the fetch wrapper", () => {
  const API = "https://api-eu.mixpanel.com";
  const record = (url: string) => url.replace(/^https:\/\/api-eu\.mixpanel\.com/, API);
  let sent: { input: unknown; init?: RequestInit }[];
  function page() {
    sent = [];
    const original = vi.fn(async (input: unknown, init?: RequestInit) => {
      sent.push({ input, init });
      return new Response("1");
    });
    vi.stubGlobal("window", { fetch: original });
    return original;
  }
  afterEach(() => vi.unstubAllGlobals());

  it("scrubs an upload to the record endpoint and passes every other request through untouched", async () => {
    const original = page();
    const undo = installReplayScrubber(API, ORIGIN);
    expect(window.fetch).not.toBe(original);
    await window.fetch("/api/metrics/chains?window=1d");
    await window.fetch(`${API}/track/?verbose=1`, { method: "POST", body: "data=x" });
    expect(sent.map((s) => s.input)).toEqual(["/api/metrics/chains?window=1d", `${API}/track/?verbose=1`]);
    await window.fetch(record(fixture.url), { ...INIT, body: await gzip(JSON.stringify(withHashLink())) });
    expect(sent).toHaveLength(3);
    const upload = sent[2]!;
    const text = await gunzip(upload.init!.body as Blob);
    for (const secret of [TYPED, ADDRESS, HASH, GUID]) expect(String(upload.input) + text, secret).not.toContain(secret);
    undo();
    expect(window.fetch).toBe(original);
  });

  it("fails closed: an upload it can't scrub is not sent, the SDK hears a success, and it is counted", async () => {
    page();
    installReplayScrubber(API, ORIGIN);
    const before = replayUploadsDropped();
    const res = await window.fetch(record(fixture.url), { ...INIT, body: new Blob(["not gzip"]) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 1, error: null });
    const asRequest = await window.fetch(new Request(record(fixture.url), { method: "POST", body: "x" }));
    expect(asRequest.status).toBe(200);
    expect(sent).toHaveLength(0);
    expect(replayUploadsDropped()).toBe(before + 2);
  });

  it("taken off while something else wrapped fetch on top, drops every upload", async () => {
    page();
    const undo = installReplayScrubber(API, ORIGIN);
    const ours = window.fetch;
    const onTop: typeof fetch = (input, init) => ours(input, init);
    window.fetch = onTop;
    undo();
    expect(window.fetch).toBe(onTop);
    const before = replayUploadsDropped();
    await window.fetch(record(fixture.url), { ...INIT, body: await gzip(JSON.stringify(fixture.events)) });
    expect(sent).toHaveLength(0);
    expect(replayUploadsDropped()).toBe(before + 1);
  });
});
