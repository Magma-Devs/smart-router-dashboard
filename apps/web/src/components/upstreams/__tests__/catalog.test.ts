import { describe, expect, it } from "vitest";
import type { RouterTopology } from "@sr/shared";
import { VENDOR_IDENTITIES } from "@sr/shared";
import {
  buildUpstreamRows,
  directTargetFor,
  groupByChain,
  matchCatalog,
  UPSTREAM_CATALOG,
  UPSTREAM_DOMAINS,
} from "../catalog";

/** Two chains, three upstreams, one of them serving both chains over two
 *  transports — the shape the grouping has to survive. */
const ROUTERS: RouterTopology[] = [
  {
    id: "eth-router",
    spec: "ETH1",
    network: "eth1",
    pathBased: false,
    customUrlPrefix: null,
    localPort: 3360,
    localPorts: { jsonrpc: 3360 },
    publicUrls: {},
    interfaces: ["jsonrpc"],
    nodes: [
      {
        name: "publicnode",
        isBackup: false,
        endpoints: [
          { urlHost: "https://ethereum-rpc.publicnode.com", interface: "jsonrpc", addons: [], index: 0, directable: true, internalPath: null },
          { urlHost: "wss://ethereum-rpc.publicnode.com", interface: "jsonrpc", addons: [], index: 1, directable: true, internalPath: null },
        ],
      },
      {
        name: "flashbots",
        isBackup: true,
        endpoints: [{ urlHost: "https://rpc.flashbots.net", interface: "jsonrpc", addons: [], index: 0, directable: true, internalPath: null }],
      },
    ],
  },
  {
    id: "cosmos-router",
    spec: "COSMOSHUB",
    network: "cosmoshub",
    pathBased: false,
    customUrlPrefix: null,
    localPort: 3364,
    localPorts: { rest: 3364 },
    publicUrls: {},
    interfaces: ["rest"],
    nodes: [
      {
        name: "publicnode",
        isBackup: false,
        endpoints: [{ urlHost: "https://cosmos-rest.publicnode.com", interface: "rest", addons: [], index: 0, directable: true, internalPath: null }],
      },
      {
        name: "polkachu",
        isBackup: false,
        endpoints: [{ urlHost: "https://cosmos-api.polkachu.com", interface: "rest", addons: [], index: 0, directable: true, internalPath: null }],
      },
    ],
  },
];

describe("groupByChain", () => {
  const upstreams = buildUpstreamRows(ROUTERS, undefined);

  it("carves the same rows by chain instead of by upstream", () => {
    const groups = groupByChain(upstreams);
    expect(groups.map((g) => g.spec)).toEqual(["ETH1", "COSMOSHUB"]);
    // Every endpoint the provider grouping shows appears exactly once here.
    const endpoints = (rows: { row: { urlHost: string } }[]) => rows.map((r) => r.row.urlHost);
    expect(endpoints(groups[0]!.rows)).toEqual([
      "https://ethereum-rpc.publicnode.com",
      "wss://ethereum-rpc.publicnode.com",
      "https://rpc.flashbots.net",
    ]);
    expect(endpoints(groups[1]!.rows)).toEqual([
      "https://cosmos-rest.publicnode.com",
      "https://cosmos-api.polkachu.com",
    ]);
  });

  it("counts upstreams, not endpoints", () => {
    const [eth] = groupByChain(upstreams);
    // publicnode serves ETH1 twice (http + ws) — that is ONE upstream.
    expect(eth!.rows).toHaveLength(3);
    expect(eth!.upstreams).toBe(2);
  });

  it("keeps an upstream that serves several chains in each of their cards", () => {
    const groups = groupByChain(upstreams);
    for (const group of groups) {
      expect(group.rows.some((r) => r.upstream.name === "publicnode")).toBe(true);
    }
    // The row carries its upstream, so a chain card can name it.
    const first = groups[0]!.rows[0]!;
    expect(first.upstream.id).toBe("publicnode");
    expect(first.row.spec).toBe("ETH1");
  });

  it("loses no rows — the two groupings partition the same set", () => {
    const viaProviders = upstreams.flatMap((u) => u.chainRows);
    const viaChains = groupByChain(upstreams).flatMap((g) => g.rows.map((r) => r.row));
    expect(viaChains).toHaveLength(viaProviders.length);
    expect(new Set(viaChains)).toEqual(new Set(viaProviders));
  });

  it("returns nothing for an empty roster", () => {
    expect(groupByChain([])).toEqual([]);
  });
});

/* ── Direct-relay identity ────────────────────────────────────────────────
   The drawer's HTTP/WS toggle has to switch upstream ENDPOINTS, not just
   envelopes: a node's http and ws urls are separate entries in the values
   file, each with its own index. */

describe("directTargetFor", () => {
  const upstreams = buildUpstreamRows(ROUTERS, undefined);
  const publicnode = upstreams.find((u) => u.name === "publicnode")!;
  const flashbots = upstreams.find((u) => u.name === "flashbots")!;

  it("pairs an http row with its ws sibling on the same node", () => {
    const httpRow = publicnode.chainRows.find((r) => r.urlHost.startsWith("https://"))!;
    expect(directTargetFor(publicnode, httpRow)).toEqual({
      routerId: "eth-router",
      node: "publicnode",
      httpIndex: 0,
      wsIndex: 1,
      httpHost: "https://ethereum-rpc.publicnode.com",
      wsHost: "wss://ethereum-rpc.publicnode.com",
      httpInternalPath: null,
      wsInternalPath: null,
    });
  });

  it("resolves the same pair from the ws row", () => {
    const wsRow = publicnode.chainRows.find((r) => r.urlHost.startsWith("wss://"))!;
    expect(directTargetFor(publicnode, wsRow)).toMatchObject({ httpIndex: 0, wsIndex: 1 });
  });

  it("reports no ws endpoint when the node has none", () => {
    const row = flashbots.chainRows[0]!;
    expect(directTargetFor(flashbots, row)).toMatchObject({ httpIndex: 0, wsIndex: null, wsHost: null });
  });

  it("does not pair across routers — the relay key is (router, node, index)", () => {
    // `publicnode` also serves COSMOSHUB from a different router; its rows
    // must not leak into the ETH1 target.
    const cosmosRow = publicnode.chainRows.find((r) => r.routerId === "cosmos-router")!;
    expect(directTargetFor(publicnode, cosmosRow)).toMatchObject({
      routerId: "cosmos-router",
      httpHost: "https://cosmos-rest.publicnode.com",
      wsIndex: null,
    });
  });
});

describe("directTargetFor — internal paths", () => {
  // A node serving one chain over two versioned urls (TON: tatum pins /v2 to
  // the host root and /v3 to /api/v3). Each url is its own row, and the drawer
  // has to know which version the row it opened on is pinned to before it
  // composes a direct path.
  const TON_ROUTERS: RouterTopology[] = [
    {
      id: "ton-router",
      spec: "TON",
      network: "ton",
      pathBased: false,
      customUrlPrefix: null,
      localPort: 3460,
      localPorts: { rest: 3460 },
      publicUrls: {},
      interfaces: ["rest"],
      nodes: [
        {
          name: "tatum",
          isBackup: false,
          endpoints: [
            { urlHost: "https://ton-mainnet.gateway.tatum.io", interface: "rest", addons: [], index: 0, directable: true, internalPath: "/v2" },
            { urlHost: "https://ton-mainnet.gateway.tatum.io", interface: "rest", addons: [], index: 1, directable: true, internalPath: "/v3" },
          ],
        },
      ],
    },
  ];

  it("carries each row's own internal path, and pairs no ws sibling", () => {
    const tatum = buildUpstreamRows(TON_ROUTERS, undefined).find((u) => u.name === "tatum")!;
    const v2 = tatum.chainRows.find((r) => r.internalPath === "/v2")!;
    const v3 = tatum.chainRows.find((r) => r.internalPath === "/v3")!;
    expect(directTargetFor(tatum, v2)).toMatchObject({
      httpIndex: 0,
      httpInternalPath: "/v2",
      wsIndex: null,
      wsInternalPath: null,
    });
    expect(directTargetFor(tatum, v3)).toMatchObject({
      httpIndex: 1,
      httpInternalPath: "/v3",
    });
  });
});

/* ── Catalog identity ─────────────────────────────────────────────────────
   The catalog id is what a card joins the vendor-status index on (SPI's slugs
   ARE these ids), so a miss here is a missing vendor chip, not just a missing
   logo. */

describe("matchCatalog", () => {
  it("identifies a Tenderly gateway node by its domain", () => {
    expect(matchCatalog("eth-tenderly", ["https://mainnet.gateway.tenderly.co"])?.id).toBe("tenderly");
  });

  it("carries presentation for every vendor the shared identity map names", () => {
    // The catalog is built from @sr/shared so the api and the web agree on who
    // a node belongs to; a vendor with no presentation entry would still work
    // but would render in the placeholder grey, which is worth noticing.
    expect(UPSTREAM_CATALOG.map((c) => c.id)).toEqual(VENDOR_IDENTITIES.map((v) => v.id));
    for (const entry of UPSTREAM_CATALOG) {
      expect(entry.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(UPSTREAM_DOMAINS[entry.id]).toBeTruthy();
    }
  });

  it("identifies a vendor by domain even when the node name says nothing", () => {
    expect(matchCatalog("eth-primary", ["https://eth.drpc.org"])?.id).toBe("drpc");
  });

  it("leaves a bring-your-own node unmatched rather than guessing a vendor", () => {
    expect(matchCatalog("eth-publicnode", ["https://ethereum-rpc.publicnode.com"])).toBeNull();
  });
});
