"use client";
/**
 * Session replay uploads, scrubbed in the browser before they leave it
 * (MAG-5402). Mixpanel's SDK masks a replay's text and inputs, but not the
 * page's address or the elements' attributes, which here carry what was
 * typed into a look-up, hashes, request IDs, customer ids and the signed-in
 * person's address. The SDK uploads a replay with `fetch` to
 * `<api host>/record/`, as gzipped (or plain) JSON of rrweb events; while
 * usage data is on, `fetch` is wrapped for that path alone:
 *
 *   the upload's URL       every address in its query through `redactUrl`
 *   meta events            `href` through `redactUrl`
 *   node attributes        in full snapshots, added nodes and attribute
 *                          changes: link and source targets, and any other
 *                          attribute whose value is an http(s) URL, through
 *                          `redactUrl`; titles, labels, alt text,
 *                          placeholders, values, `data-*` (but `data-theme`
 *                          and `data-density`), and an `id` or `for` that
 *                          isn't one of ours (`gw-…`) dropped; every other
 *                          attribute kept, since the player draws the page
 *                          from them (an icon's `d`, `viewBox`)
 *   anything else          any string that is an http(s) URL, redacted
 *
 * What must never be in a replay is never recorded instead: the 2FA
 * enrolment holds the recording off (`holdReplay` in `usage.ts`), and its QR
 * carries `REPLAY_BLOCK_CLASS`, which the SDK leaves out.
 *
 * Fails closed: an upload that can't be read, scrubbed or re-encoded is not
 * sent. The SDK is answered as if it had been, so it does not retry, and
 * `replayUploadsDropped()` counts it. Loaded with the SDK, after an
 * acceptance only.
 */
import { redactUrl } from "./usage-redact";

const URL_ATTRS = new Set(["href", "src", "xlink:href", "action", "formaction", "poster", "cite", "background", "ping"]);
const DROP_ATTRS = new Set([
  "title", "alt", "placeholder", "value", "label", "download", "srcset",
  "aria-label", "aria-valuetext", "aria-description", "aria-roledescription", "aria-placeholder",
]);
/** `data-*` attributes the page's styles read, each with a value from a fixed set. */
const KEPT_DATA = new Set(["data-theme", "data-density"]);
const FIXED_VALUE = /^[a-z-]{1,16}$/;
const OWN_ID = /^gw-[a-z0-9-]+$/;

/** One element's attributes as a replay may carry them. A null (an attribute removed) carries nothing and stays. */
export function scrubAttributes(attrs: Record<string, unknown>, origin: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    const name = key.toLowerCase();
    if (value === null) {
      out[key] = null;
      continue;
    }
    if (DROP_ATTRS.has(name)) continue;
    if (name.startsWith("data-") && !(KEPT_DATA.has(name) && typeof value === "string" && FIXED_VALUE.test(value))) continue;
    if ((name === "id" || name === "for") && !(typeof value === "string" && OWN_ID.test(value))) continue;
    const url = URL_ATTRS.has(name) || (typeof value === "string" && /^https?:\/\//i.test(value.trim()));
    out[key] = url ? redactUrl(value, origin) : value;
  }
  return out;
}

interface ReplayNode {
  attributes?: Record<string, unknown>;
  childNodes?: unknown[];
  [k: string]: unknown;
}

function scrubNode(node: unknown, origin: string): unknown {
  if (!node || typeof node !== "object") return node;
  const n = node as ReplayNode;
  const out: ReplayNode = { ...n };
  if (n.attributes && typeof n.attributes === "object") out.attributes = scrubAttributes(n.attributes, origin);
  if (Array.isArray(n.childNodes)) out.childNodes = n.childNodes.map((c) => scrubNode(c, origin));
  return out;
}

/** Every string anywhere in `v` that is an http(s) URL, redacted. */
function scrubUrls(v: unknown, origin: string): unknown {
  if (typeof v === "string") return /^https?:\/\//i.test(v) ? redactUrl(v, origin) : v;
  if (Array.isArray(v)) return v.map((x) => scrubUrls(x, origin));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrubUrls(x, origin)]));
  return v;
}

/* rrweb's event and incremental-source numbers. */
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
const META = 4;
const MUTATION = 0;

/** A replay's rrweb events as an upload may carry them. */
export function scrubReplayEvents(events: unknown[], origin: string): unknown[] {
  return events.map((e) => {
    if (!e || typeof e !== "object") return e;
    const ev = e as { type?: unknown; data?: Record<string, unknown> };
    const data = ev.data ?? {};
    if (ev.type === META) return { ...ev, data: { ...data, href: redactUrl(data.href, origin) } };
    if (ev.type === FULL_SNAPSHOT) return { ...ev, data: { ...data, node: scrubNode(data.node, origin) } };
    if (ev.type === INCREMENTAL && data.source === MUTATION) {
      const adds = Array.isArray(data.adds) ? data.adds : [];
      const attributes = Array.isArray(data.attributes) ? data.attributes : [];
      return {
        ...ev,
        data: scrubUrls({
          ...data,
          adds: adds.map((a: { node?: unknown }) => ({ ...a, node: scrubNode(a.node, origin) })),
          attributes: attributes.map((a: { attributes?: Record<string, unknown> }) => ({ ...a, attributes: scrubAttributes(a.attributes ?? {}, origin) })),
        }, origin),
      };
    }
    return scrubUrls(ev, origin);
  });
}

/** An upload's URL, every address in its query redacted. */
export function scrubRecordUrl(url: string, origin: string): string {
  const u = new URL(url);
  for (const [key, value] of [...u.searchParams]) {
    if (/^https?:\/\//i.test(value)) u.searchParams.set(key, String(redactUrl(value, origin)));
  }
  return u.toString();
}

/** One upload scrubbed, in the encoding it came in (`format=gzip`: a gzipped Blob, else a JSON string). Throws when it can't be. */
export async function scrubRecordUpload(url: string, init: RequestInit | undefined, origin: string): Promise<{ url: string; init: RequestInit }> {
  const gzip = new URL(url).searchParams.get("format") === "gzip";
  const body = init?.body;
  let text: string;
  if (gzip) {
    if (!(body instanceof Blob)) throw new Error("a gzip upload whose body is not a Blob");
    text = await new Response(body.stream().pipeThrough(new DecompressionStream("gzip"))).text();
  } else {
    if (typeof body !== "string") throw new Error("an upload whose body is not text");
    text = body;
  }
  const events: unknown = JSON.parse(text);
  if (!Array.isArray(events)) throw new Error("an upload that is not a list of events");
  const scrubbed = JSON.stringify(scrubReplayEvents(events, origin));
  const out = gzip ? await new Response(new Blob([scrubbed]).stream().pipeThrough(new CompressionStream("gzip"))).blob() : scrubbed;
  return { url: scrubRecordUrl(url, origin), init: { ...init, body: out } };
}

let dropped = 0;
/** Uploads not sent because they could not be scrubbed, on this page. */
export const replayUploadsDropped = () => dropped;

/** What the SDK is answered for an upload that is not sent: a success, so it does not retry it. */
const notSent = () => new Response(JSON.stringify({ status: 1, error: null }), { status: 200, headers: { "content-type": "application/json" } });

/**
 * Wraps `fetch` so every request to `<apiHost>/record` is scrubbed first.
 * Returns the undo: `fetch` is put back when nothing wrapped it since, and
 * otherwise the wrapper stays and drops every upload.
 */
export function installReplayScrubber(apiHost: string, origin: string): () => void {
  const prefix = `${apiHost}/record`;
  const original = window.fetch;
  let active = true;
  const wrapped: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(prefix)) return original.call(window, input, init);
    if (!active || typeof input !== "string") {
      dropped++;
      return notSent();
    }
    let scrubbed: { url: string; init: RequestInit };
    try {
      scrubbed = await scrubRecordUpload(url, init, origin);
    } catch {
      dropped++;
      return notSent();
    }
    return original.call(window, scrubbed.url, scrubbed.init);
  };
  window.fetch = wrapped;
  return () => {
    active = false;
    if (window.fetch === wrapped) window.fetch = original;
  };
}
