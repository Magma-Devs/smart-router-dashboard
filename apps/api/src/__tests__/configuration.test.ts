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

  it("marks backup-direct-rpc providers isBackup", () => {
    const eth = serviceFor(`
endpoints:
  - listen-address: "0.0.0.0:3360"
    chain-id: "ETH1"
    api-interface: "jsonrpc"
direct-rpc:
  - name: "eth-primary"
    chain-id: "ETH1"
    api-interface: "jsonrpc"
    node-urls:
      - url: "https://eth-rpc.example.com"
backup-direct-rpc:
  - name: "eth-backup"
    chain-id: "ETH1"
    api-interface: "jsonrpc"
    node-urls:
      - url: "https://eth-fallback.example.com"
`).getRouters()[0]!;
    const primary = eth.nodes.find((n) => n.name === "eth-primary");
    const backup = eth.nodes.find((n) => n.name === "eth-backup");
    expect(primary?.isBackup).toBe(false);
    expect(backup?.isBackup).toBe(true);
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

  it("publishes no public URLs — an SR_CONFIG mount describes ports, not ingress", () => {
    expect(serviceFor(SR_CONFIG_ETH).getRouters()[0]!.publicUrls).toEqual({});
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

  /* Public gateway URLs — mirrors the HTTPRoute + Gateway shapes in the values.
     These are the addresses a k8s user actually dials, so a drift here
     prints URLs that resolve nowhere. */
  describe("publicUrls (mirrors the HTTPRoute hostname scheme)", () => {
    /** GATEWAY block + `routers:` body, so each case varies only what it tests. */
    const withGateway = (gateway: string, routers?: string): string => `
base_domain: rpc.example.com
miscellaneous:
  gateway:
${gateway}
routers:
${routers ?? `  - id: Ethereum
    network: eth1
    nodes:
      - name: n1
        endpoints: [{ url: "https://up1.example.com", interface: jsonrpc }]`}
`;

    const HTTPS_GATEWAY = `    enabled: true
    listeners:
      - { name: http, protocol: HTTP, port: 80 }
      - { name: https, protocol: HTTPS, port: 443 }`;

    it("renders the chain.interface form (the default) on the TLS listener", () => {
      const eth = serviceFor(withGateway(HTTPS_GATEWAY)).getRouters()[0]!;
      expect(eth.publicUrls).toEqual({ jsonrpc: "https://ethereum.jsonrpc.rpc.example.com" });
    });

    it("renders the chain-interface form when hostStructure selects it", () => {
      const eth = serviceFor(
        withGateway(`${HTTPS_GATEWAY}
    hostStructure: chain-interface`),
      ).getRouters()[0]!;
      expect(eth.publicUrls).toEqual({ jsonrpc: "https://ethereum-jsonrpc.rpc.example.com" });
    });

    it("uses custom_url_prefix verbatim, like the values' own default", () => {
      const eth = serviceFor(
        withGateway(
          HTTPS_GATEWAY,
          `  - id: HyperliquidProduction
    network: hyperliquid
    custom_url_prefix: hyper-l
    nodes:
      - name: n1
        endpoints: [{ url: "https://up1.example.com", interface: jsonrpc }]`,
        ),
      ).getRouters()[0]!;
      expect(eth.publicUrls).toEqual({ jsonrpc: "https://hyper-l.jsonrpc.rpc.example.com" });
    });

    it("gives every interface its own hostname, grpc included", () => {
      const lava = serviceFor(
        withGateway(
          HTTPS_GATEWAY,
          `  - id: Lava
    network: lava
    nodes:
      - name: n1
        endpoints:
          - { url: "https://a.example.com", interface: rest }
          - { url: "https://b.example.com", interface: tendermintrpc }
          - { url: "https://c.example.com", interface: grpc }`,
        ),
      ).getRouters()[0]!;
      expect(lava.publicUrls).toEqual({
        rest: "https://lava.rest.rpc.example.com",
        tendermintrpc: "https://lava.tendermintrpc.rpc.example.com",
        grpc: "https://lava.grpc.rpc.example.com",
      });
    });

    it("falls back to the HTTP listener when no TLS listener exists", () => {
      const eth = serviceFor(
        withGateway(`    enabled: true
    listeners:
      - { name: http, protocol: HTTP, port: 80 }`),
      ).getRouters()[0]!;
      expect(eth.publicUrls).toEqual({ jsonrpc: "http://ethereum.jsonrpc.rpc.example.com" });
    });

    it("keeps a non-default listener port in the URL", () => {
      const eth = serviceFor(
        withGateway(`    enabled: true
    listeners:
      - { name: https, protocol: HTTPS, port: 8443 }`),
      ).getRouters()[0]!;
      expect(eth.publicUrls).toEqual({ jsonrpc: "https://ethereum.jsonrpc.rpc.example.com:8443" });
    });

    it("treats a tls block as HTTPS even when the protocol says otherwise", () => {
      const eth = serviceFor(
        withGateway(`    enabled: true
    listeners:
      - name: tls
        port: 443
        tls: { mode: Terminate }`),
      ).getRouters()[0]!;
      expect(eth.publicUrls).toEqual({ jsonrpc: "https://ethereum.jsonrpc.rpc.example.com" });
    });

    it("publishes nothing when the gateway is disabled", () => {
      const eth = serviceFor(
        withGateway(`    enabled: false
    listeners:
      - { name: https, protocol: HTTPS, port: 443 }`),
      ).getRouters()[0]!;
      expect(eth.publicUrls).toEqual({});
    });

    it("publishes nothing without a base_domain or listeners", () => {
      const noDomain = serviceFor(`
miscellaneous:
  gateway:
    enabled: true
    listeners:
      - { name: https, protocol: HTTPS, port: 443 }
routers:
  - id: A
    network: eth1
    nodes:
      - name: n1
        endpoints: [{ url: "https://up.example.com", interface: jsonrpc }]
`).getRouters()[0]!;
      expect(noDomain.publicUrls).toEqual({});

      const noListeners = serviceFor(withGateway("    enabled: true")).getRouters()[0]!;
      expect(noListeners.publicUrls).toEqual({});
    });

    it("keeps several routers on ONE chain apart by hostname", () => {
      const routers = serviceFor(
        withGateway(
          HTTPS_GATEWAY,
          `  - id: HyperliquidStaging
    network: hyperliquid
    custom_url_prefix: hyperliquid-staging
    nodes:
      - name: n1
        endpoints: [{ url: "https://up1.example.com", interface: jsonrpc }]
  - id: HyperliquidProduction
    network: hyperliquid
    custom_url_prefix: hyper-l
    nodes:
      - name: n1
        endpoints: [{ url: "https://up1.example.com", interface: jsonrpc }]`,
        ),
      ).getRouters();
      expect(routers.map((r) => r.id)).toEqual(["HyperliquidStaging", "HyperliquidProduction"]);
      // Same chain (one `spec`, so one metrics identity) — distinct addresses.
      expect(routers.every((r) => r.spec === "HYPERLIQUID")).toBe(true);
      expect(routers.map((r) => r.publicUrls["jsonrpc"])).toEqual([
        "https://hyperliquid-staging.jsonrpc.rpc.example.com",
        "https://hyper-l.jsonrpc.rpc.example.com",
      ]);
    });

    it("falls back to the lowercased id when no prefix is set", () => {
      const eth = serviceFor(
        withGateway(
          HTTPS_GATEWAY,
          `  - id: eth-mainnet
    network: eth1
    nodes:
      - name: n1
        endpoints: [{ url: "https://up1.example.com", interface: jsonrpc }]`,
        ),
      ).getRouters()[0]!;
      expect(eth.publicUrls).toEqual({ jsonrpc: "https://eth-mainnet.jsonrpc.rpc.example.com" });
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
