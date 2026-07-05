import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigurationService,
  maskNodeUrl,
  portFromListenAddress,
} from "../services/configuration.js";

/** Write `core/values.yml` into a fresh temp values-dir and return a service. */
const dirs: string[] = [];
function serviceFor(yaml: string): ConfigurationService {
  const dir = mkdtempSync(join(tmpdir(), "srdash-values-"));
  dirs.push(dir);
  mkdirSync(join(dir, "core"), { recursive: true });
  writeFileSync(join(dir, "core", "values.yml"), yaml);
  return new ConfigurationService(dir);
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/* ── SR_CONFIG format (the router's own YAML) ─────────────────────────────── */

const SR_CONFIG_ETH = `
metrics-listen-address: "0.0.0.0:7779"
endpoints:
  - listen-address: "0.0.0.0:3360"
    chain-id: "ETH1"
    api-interface: "jsonrpc"
direct-rpc:
  - name: "eth-lava"
    chain-id: "ETH1"
    api-interface: "jsonrpc"
    node-urls:
      - url: "https://eth1.lava.build/lava-referer-secret-key/"
        addons: [archive]
      - url: "wss://eth1.lava.build/websocket"
  - name: "eth-publicnode"
    chain-id: "ETH1"
    api-interface: "jsonrpc"
    node-urls:
      - url: "https://ethereum-rpc.publicnode.com"
`;

describe("ConfigurationService · SR_CONFIG format", () => {
  it("groups direct-rpc providers into one router per chain", () => {
    const routers = serviceFor(SR_CONFIG_ETH).getRouters();
    expect(routers).toHaveLength(1);
    const eth = routers[0]!;
    expect(eth.id).toBe("ETH1");
    expect(eth.spec).toBe("ETH1");
    expect(eth.network).toBe("eth1");
    expect(eth.nodes.map((n) => n.name)).toEqual(["eth-lava", "eth-publicnode"]);
    expect(eth.interfaces).toEqual(["jsonrpc"]);
    expect(eth.pathBased).toBe(false);
  });

  it("extracts the local port from listen-address", () => {
    const eth = serviceFor(SR_CONFIG_ETH).getRouters()[0]!;
    expect(eth.localPort).toBe(3360);
    expect(eth.localPorts).toEqual({ jsonrpc: 3360 });
  });

  it("keeps per-interface ports when one chain exposes several interfaces", () => {
    const routers = serviceFor(`
endpoints:
  - listen-address: "0.0.0.0:3360"
    chain-id: "LAVA"
    api-interface: "rest"
  - listen-address: "0.0.0.0:3361"
    chain-id: "LAVA"
    api-interface: "tendermintrpc"
direct-rpc:
  - name: "lava-rest"
    chain-id: "LAVA"
    api-interface: "rest"
    node-urls: [{ url: "https://lava.rest.lava.build" }]
  - name: "lava-tm"
    chain-id: "LAVA"
    api-interface: "tendermintrpc"
    node-urls: [{ url: "https://lava.tendermintrpc.lava.build" }]
`).getRouters();
    expect(routers).toHaveLength(1);
    const lava = routers[0]!;
    expect(lava.localPorts).toEqual({ rest: 3360, tendermintrpc: 3361 });
    expect(lava.localPort).toBe(3360); // back-compat scalar = first interface
    expect(lava.interfaces.sort()).toEqual(["rest", "tendermintrpc"]);
  });

  it("falls back to network-address when listen-address is missing", () => {
    const routers = serviceFor(`
endpoints:
  - network-address: "0.0.0.0:4444"
    chain-id: "BTC"
    api-interface: "jsonrpc"
direct-rpc:
  - name: "btc-node"
    chain-id: "BTC"
    api-interface: "jsonrpc"
    node-urls: [{ url: "https://bitcoin-rpc.publicnode.com" }]
`).getRouters();
    expect(routers[0]!.localPort).toBe(4444);
  });

  it("leaves localPort null when there is no endpoints block", () => {
    const routers = serviceFor(`
direct-rpc:
  - name: "eth-x"
    chain-id: "ETH1"
    api-interface: "jsonrpc"
    node-urls: [{ url: "https://example.com" }]
`).getRouters();
    expect(routers[0]!.localPort).toBeNull();
    expect(routers[0]!.localPorts).toEqual({});
  });

  it("preserves addons and masks node URLs to scheme+host", () => {
    const eth = serviceFor(SR_CONFIG_ETH).getRouters()[0]!;
    const lavaNode = eth.nodes[0]!;
    expect(lavaNode.endpoints[0]!.addons).toEqual(["archive"]);
    // The referer-secret path segment must NOT survive into the API payload.
    expect(lavaNode.endpoints[0]!.urlHost).toBe("https://eth1.lava.build");
    expect(lavaNode.endpoints[1]!.urlHost).toBe("wss://eth1.lava.build");
  });

  it("multichain config yields one router per chain", () => {
    const routers = serviceFor(`
endpoints:
  - { listen-address: "0.0.0.0:3360", chain-id: "ETH1", api-interface: "jsonrpc" }
  - { listen-address: "0.0.0.0:3361", chain-id: "SOLANA", api-interface: "jsonrpc" }
direct-rpc:
  - { name: "eth-a", chain-id: "ETH1", api-interface: "jsonrpc", node-urls: [{ url: "https://a" }] }
  - { name: "sol-a", chain-id: "SOLANA", api-interface: "jsonrpc", node-urls: [{ url: "https://b" }] }
  - { name: "sol-b", chain-id: "SOLANA", api-interface: "jsonrpc", node-urls: [{ url: "https://c" }] }
`).getRouters();
    expect(routers.map((r) => r.spec).sort()).toEqual(["ETH1", "SOLANA"]);
    expect(routers.find((r) => r.spec === "SOLANA")!.nodes).toHaveLength(2);
  });
});

/* ── Helm-chart values format ─────────────────────────────────────────────── */

const HELM_FULL = `
routers:
  - id: Ethereum
    network: eth1
    custom_url_prefix: eth-main
    nodes:
      - name: lava
        endpoints:
          - url: https://eth1.lava.build/some/keyed/path
            interface: jsonrpc
            addons: [archive]
      - name: backup-node
        is_backup: true
        endpoints:
          - url: https://backup.example.com
            interface: jsonrpc
  - id: Lava
    network: lava
    nodes:
      - name: lava
        endpoints:
          - url: https://lava.tendermintrpc.lava.build
            interface: tendermintrpc
            addons: [archive]
          - url: https://lava.rest.lava.build
            interface: rest
`;

describe("ConfigurationService · helm-values format", () => {
  it("parses the routers/nodes shape with spec correlation", () => {
    const routers = serviceFor(HELM_FULL).getRouters();
    expect(routers).toHaveLength(2);
    const eth = routers[0]!;
    expect(eth.id).toBe("Ethereum");
    expect(eth.network).toBe("eth1");
    expect(eth.spec).toBe("ETH1"); // network.upper() == Prometheus spec label
    expect(eth.customUrlPrefix).toBe("eth-main");
    expect(eth.localPort).toBeNull(); // gateway deployments have no local port
    const lava = routers[1]!;
    expect(lava.interfaces.sort()).toEqual(["rest", "tendermintrpc"]);
  });

  it("carries is_backup onto nodes (any key dialect)", () => {
    const eth = serviceFor(HELM_FULL).getRouters()[0]!;
    expect(eth.nodes.find((n) => n.name === "lava")!.isBackup).toBe(false);
    expect(eth.nodes.find((n) => n.name === "backup-node")!.isBackup).toBe(true);

    const kebab = serviceFor(`
routers:
  - id: X
    network: eth1
    nodes:
      - name: n1
        is-backup: true
        endpoints: [{ url: "https://x", interface: jsonrpc }]
`).getRouters();
    expect(kebab[0]!.nodes[0]!.isBackup).toBe(true);
  });

  it("masks helm node URLs too", () => {
    const eth = serviceFor(HELM_FULL).getRouters()[0]!;
    expect(eth.nodes[0]!.endpoints[0]!.urlHost).toBe("https://eth1.lava.build");
  });

  describe("pathBased resolution (mirrors the chart's httproute logic)", () => {
    it("per-router override wins over the global default", () => {
      const routers = serviceFor(`
miscellaneous:
  gateway:
    pathBased:
      enabled: true
routers:
  - id: A
    network: eth1
    pathBased: false
    nodes: []
  - id: B
    network: base
    nodes: []
`).getRouters();
      expect(routers[0]!.pathBased).toBe(false); // explicit override
      expect(routers[1]!.pathBased).toBe(true); // global default
    });

    it("accepts snake/kebab dialects for the override", () => {
      const routers = serviceFor(`
routers:
  - id: A
    network: eth1
    path_based: true
    nodes: []
  - id: B
    network: base
    path-based: true
    nodes: []
`).getRouters();
      expect(routers[0]!.pathBased).toBe(true);
      expect(routers[1]!.pathBased).toBe(true);
    });

    it("defaults false when no gateway block exists", () => {
      const routers = serviceFor(`
routers:
  - id: A
    network: eth1
    nodes: []
`).getRouters();
      expect(routers[0]!.pathBased).toBe(false);
    });
  });
});

/* ── Shared edges ─────────────────────────────────────────────────────────── */

describe("ConfigurationService · unknown shapes", () => {
  it("returns [] for a YAML without routers or direct-rpc", () => {
    expect(serviceFor("foo: bar\n").getRouters()).toEqual([]);
  });
  it("returns [] for a missing file", () => {
    expect(new ConfigurationService("/nonexistent-dir").getRouters()).toEqual([]);
  });
  it("returns [] for invalid YAML", () => {
    expect(serviceFor("{{{ not yaml").getRouters()).toEqual([]);
  });
});

describe("maskNodeUrl", () => {
  it("keeps scheme + host (+port), drops path/query", () => {
    expect(maskNodeUrl("https://mainnet.gateway.tenderly.co/abc123?key=s")).toBe(
      "https://mainnet.gateway.tenderly.co",
    );
    expect(maskNodeUrl("https://host.example:8545/v2/API_KEY")).toBe(
      "https://host.example:8545",
    );
    expect(maskNodeUrl("wss://eth.example/ws/KEY")).toBe("wss://eth.example");
  });
  it("returns empty string for unparseable URLs (never leak raw input)", () => {
    expect(maskNodeUrl("not a url")).toBe("");
  });
});

describe("portFromListenAddress", () => {
  it("parses host:port shapes", () => {
    expect(portFromListenAddress("0.0.0.0:3360")).toBe(3360);
    expect(portFromListenAddress(":3360")).toBe(3360);
    expect(portFromListenAddress("127.0.0.1:8080")).toBe(8080);
  });
  it("rejects missing/invalid ports", () => {
    expect(portFromListenAddress("nocolon")).toBeNull();
    expect(portFromListenAddress("host:notaport")).toBeNull();
    expect(portFromListenAddress(undefined)).toBeNull();
  });
});
