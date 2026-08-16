import { describe, expect, it } from "vitest";
import type { RouterTopology } from "@sr/shared";
import { buildUpstreamRows, groupByChain } from "../catalog";

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
          { urlHost: "https://ethereum-rpc.publicnode.com", interface: "jsonrpc", addons: [] },
          { urlHost: "wss://ethereum-rpc.publicnode.com", interface: "jsonrpc", addons: [] },
        ],
      },
      {
        name: "flashbots",
        isBackup: true,
        endpoints: [{ urlHost: "https://rpc.flashbots.net", interface: "jsonrpc", addons: [] }],
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
        endpoints: [{ urlHost: "https://cosmos-rest.publicnode.com", interface: "rest", addons: [] }],
      },
      {
        name: "polkachu",
        isBackup: false,
        endpoints: [{ urlHost: "https://cosmos-api.polkachu.com", interface: "rest", addons: [] }],
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
    expect(eth!.providers).toBe(2);
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
