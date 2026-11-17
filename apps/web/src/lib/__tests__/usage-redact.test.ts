import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { auditLocationSearch } from "@/components/audit/audit-location";
import { REQUEST_PARAM } from "../request-in-url";
import { requestSearchUrl } from "../request-search";
import {
  redactPath,
  redactProfileUpdate,
  redactSearch,
  redactUrl,
  redactUsageEvent,
  redactUsageProps,
  USAGE_FIXED_PARAMS,
  USAGE_OPAQUE_PARAMS,
  USAGE_PATH_SEGMENTS,
} from "../usage-redact";
import { VIEW_KEYS } from "../view-in-url";

/* Usage data (MAG-5373): every URL and clicked element an event carries goes
   through these before Mixpanel's SDK queues or sends it. What was typed into
   a look-up, a request ID, a hash, a node name, an address, a cursor and a
   token never reach it: only routes and values from fixed sets do. */

const ORIGIN = "https://dash.example";
/** Things that must never leave the browser, each planted somewhere a URL or an element can carry it. */
const SECRETS = [
  "john-smith-order-42",
  "0x" + "ab".repeat(32),
  "7708800000000000042",
  "ops@client.example",
  "https://eth.node.example/v3/KEY123",
  "invite-token-9f8e7d",
  "eyJjdXJzb3IiOiIxMjMifQ",
  "node-a.provider.example",
];

describe("a path", () => {
  it("keeps the routes' fixed segments and names every other one :id", () => {
    expect(redactPath("/metrics")).toBe("/metrics");
    expect(redactPath("/account/two-factor")).toBe("/account/two-factor");
    expect(redactPath("/invite/invite-token-9f8e7d")).toBe("/invite/:id");
    expect(redactPath("/reset/abc/")).toBe("/reset/:id/");
    expect(redactPath("/")).toBe("/");
    expect(redactPath("/john-smith/metrics")).toBe("/:id/metrics");
  });

  it("knows every fixed segment of the app's routes", () => {
    const app = fileURLToPath(new URL("../../app", import.meta.url));
    const segments = new Set<string>();
    // Each page's folders, less route groups `(app)` and dynamic segments `[token]`.
    const walk = (dir: string, path: string[]) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, [...path, name]);
        else if (name === "page.tsx") for (const s of path) if (!/^[([]/.test(s)) segments.add(s);
      }
    };
    walk(app, []);
    expect(segments.size).toBeGreaterThan(5);
    expect([...segments].filter((s) => !(USAGE_PATH_SEGMENTS as readonly string[]).includes(s))).toEqual([]);
  });
});

describe("a query", () => {
  it("keeps a value only when it is from a fixed set, names the rest :id, and drops unknown keys", () => {
    expect(redactSearch("?tab=request&request=0xabc&window=1d&chain=ETH1&router=r-1&upstream=node-a&foo=bar"))
      .toBe("?tab=request&request=:id&window=1d&chain=ETH1&router=:id&upstream=:id");
    expect(redactSearch("?tab=john-smith&window=7y&chain=NOT_A_CHAIN&upstreamChain=ETH1")).toBe("?tab=:id&window=:id&chain=:id&upstreamChain=ETH1");
    expect(redactSearch("?window=24h")).toBe("?window=24h");
    expect(redactSearch("group=accounts&actor=ops%40client.example&target=ep_8143&size=100&older=eyJjdXJzb3IiOiIxMjMifQ&page=3"))
      .toBe("?group=accounts&actor=:id&target=:id&size=100&older=:id&page=:id");
    expect(redactSearch("?group=nope&size=77")).toBe("?group=:id&size=:id");
    expect(redactSearch("?0xabc=1&john=smith")).toBe("");
    expect(redactSearch("")).toBe("");
  });

  it("lists every key the dashboard writes into its URLs", () => {
    const listed = new Set([...Object.keys(USAGE_FIXED_PARAMS), ...USAGE_OPAQUE_PARAMS]);
    const written = new Set<string>([...VIEW_KEYS, REQUEST_PARAM, "chain", "router", "tab"]);
    const metrics = new URL(requestSearchUrl("0xabc", { chain: "ETH1", router: "r-1" }), ORIGIN);
    for (const k of metrics.searchParams.keys()) written.add(k);
    const audit = auditLocationSearch({
      filters: { group: "accounts", actor: "a@b.c", targetId: "ep_1", from: "2026-11-01", to: "2026-11-02" },
      size: 100,
      position: { kind: "older", cursor: "abc", page: 2 },
    });
    for (const k of new URLSearchParams(audit).keys()) written.add(k);
    expect([...written].filter((k) => !listed.has(k))).toEqual([]);
  });
});

describe("a URL", () => {
  it("of the dashboard keeps its route and fixed-set values, absolute or relative, without the fragment", () => {
    expect(redactUrl(`${ORIGIN}${requestSearchUrl("john-smith-order-42", { chain: "ETH1", router: "r-1" })}`, ORIGIN))
      .toBe(`${ORIGIN}/metrics?chain=ETH1&router=:id&tab=request&request=:id`);
    expect(redactUrl("/metrics?chain=ETH1&tab=upstreams&upstream=node-a.provider.example", ORIGIN)).toBe("/metrics?chain=ETH1&tab=upstreams&upstream=:id");
    expect(redactUrl(`${ORIGIN}/invite/invite-token-9f8e7d#0xabc`, ORIGIN)).toBe(`${ORIGIN}/invite/:id`);
  });

  it("of another site keeps its origin only; another scheme its scheme only", () => {
    expect(redactUrl(`https://etherscan.io/tx/0x${"ab".repeat(32)}`, ORIGIN)).toBe("https://etherscan.io");
    expect(redactUrl("https://grafana.example/?var-search=7708800000000000042", ORIGIN)).toBe("https://grafana.example");
    expect(redactUrl("mailto:ops@client.example", ORIGIN)).toBe("mailto:");
    expect(redactUrl("http://[bad", ORIGIN)).toBe(":id");
  });

  it("leaves Mixpanel's $direct, an empty value and a non-string as they are", () => {
    expect(redactUrl("$direct", ORIGIN)).toBe("$direct");
    expect(redactUrl("", ORIGIN)).toBe("");
    expect(redactUrl(undefined, ORIGIN)).toBeUndefined();
  });
});

/** The shape of a click autocapture records on a look-up's hash link, with every place a value can sit. */
function clickOnHashLink(secret: string): Record<string, unknown> {
  return {
    token: "project-token",
    distinct_id: "6f1e0c2a9b8d7e6f5a4b3c2d1e0f9a8b",
    $current_url: `${ORIGIN}/metrics?tab=request&request=${encodeURIComponent(secret)}#${encodeURIComponent(secret)}`,
    $referrer: `${ORIGIN}/audit?actor=${encodeURIComponent(secret)}`,
    $initial_referrer: `https://mail.example/inbox/${encodeURIComponent(secret)}`,
    $pathname: `/invite/${encodeURIComponent(secret)}`,
    current_url_path: `/reset/${encodeURIComponent(secret)}`,
    current_url_search: `?request=${encodeURIComponent(secret)}&tab=errors`,
    $el_attr__href: `https://etherscan.io/tx/${encodeURIComponent(secret)}`,
    $el_attr__data_id: secret,
    $el_text: secret,
    replay_start_url: `${ORIGIN}/metrics?request=${encodeURIComponent(secret)}`,
    $elements: [
      {
        $tag_name: "a",
        $classes: ["gw-mono"],
        $nth_child: 1,
        $nth_of_type: 1,
        $id: secret,
        "$attr-href": `https://etherscan.io/tx/${encodeURIComponent(secret)}`,
        "$attr-title": `${secret} - on the chain's explorer`,
        "$attr-aria-label": `Copy ${secret}`,
      },
      { $tag_name: "div", $classes: ["gw-app"], $id: "gw-request-search", $nth_child: 2, $nth_of_type: 1, "$attr-role": "row" },
    ],
    tenant: "tenant-a",
    staff: false,
  };
}

describe("an event's properties", () => {
  it("never carry a planted value, wherever the URL or the element put it", () => {
    for (const secret of SECRETS) {
      const out = JSON.stringify(redactUsageProps(clickOnHashLink(secret), ORIGIN));
      expect(out, secret).not.toContain(secret);
      expect(out, secret).not.toContain(encodeURIComponent(secret));
    }
  });

  it("keep the route, fixed-set values, Mixpanel's own fields and what describes the element", () => {
    const out = redactUsageProps(clickOnHashLink("0xabc"), ORIGIN);
    expect(out).toMatchObject({
      token: "project-token",
      distinct_id: "6f1e0c2a9b8d7e6f5a4b3c2d1e0f9a8b",
      $current_url: `${ORIGIN}/metrics?tab=request&request=:id`,
      $referrer: `${ORIGIN}/audit?actor=:id`,
      $initial_referrer: "https://mail.example",
      $pathname: "/invite/:id",
      current_url_path: "/reset/:id",
      current_url_search: "?request=:id&tab=errors",
      $el_attr__href: "https://etherscan.io",
      replay_start_url: `${ORIGIN}/metrics?request=:id`,
      tenant: "tenant-a",
      staff: false,
    });
    expect(out).not.toHaveProperty("$el_text");
    expect(out).not.toHaveProperty("$el_attr__data_id");
    expect(out.$elements).toEqual([
      { $tag_name: "a", $classes: ["gw-mono"], $nth_child: 1, $nth_of_type: 1, "$attr-href": "https://etherscan.io" },
      { $tag_name: "div", $classes: ["gw-app"], $id: "gw-request-search", $nth_child: 2, $nth_of_type: 1, "$attr-role": "row" },
    ]);
  });

  it("are redacted the same way through the send hook's payload", () => {
    const sent = redactUsageEvent({ event: "$mp_click", properties: clickOnHashLink("0xabc") }, ORIGIN);
    expect(sent.event).toBe("$mp_click");
    expect(sent.properties.$current_url).toBe(`${ORIGIN}/metrics?tab=request&request=:id`);
  });
});

describe("a profile update", () => {
  it("sets nothing a URL carried", () => {
    const update = redactProfileUpdate({
      $token: "project-token",
      $distinct_id: "6f1e",
      $set: { tenant: "tenant-a", staff: true, $initial_referrer: `${ORIGIN}/metrics?request=0xabc` },
      $set_once: { $initial_referrer: "https://mail.example/inbox/ops@client.example" },
    }, ORIGIN);
    expect(update).toEqual({
      $token: "project-token",
      $distinct_id: "6f1e",
      $set: { tenant: "tenant-a", staff: true, $initial_referrer: `${ORIGIN}/metrics?request=:id` },
      $set_once: { $initial_referrer: "https://mail.example" },
    });
  });
});
