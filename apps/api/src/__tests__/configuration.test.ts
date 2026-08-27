import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ConfigurationService,
  maskNodeUrl,
  normalizeHelmNodeName,
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

  describe("node-name normalization (mirrors the chart's `lower | replace \" \" \"-\"`)", () => {
    it("folds the values file's display name to the router's provider name", () => {
      const routers = serviceFor(`
routers:
  - id: iota-mainnet
    network: iota
    nodes:
      - name: Lava
        endpoints: [{ url: "https://iota.lava.build", interface: jsonrpc }]
      - name: Blockdaemon
        endpoints: [{ url: "https://iota.blockdaemon.com", interface: jsonrpc }]
`).getRouters();
      // Prometheus reports `provider_address="lava"`, and the router only
      // honours `lava-select-provider: lava`. Both read this field.
      expect(routers[0]!.nodes.map((n) => n.name)).toEqual(["lava", "blockdaemon"]);
    });

    it("turns spaces into dashes, exactly as the chart does", () => {
      const routers = serviceFor(`
routers:
  - id: A
    network: eth1
    nodes:
      - name: My Node Co
        endpoints: [{ url: "https://x", interface: jsonrpc }]
`).getRouters();
      expect(routers[0]!.nodes[0]!.name).toBe("my-node-co");
    });

    it("keys the endpoint-url index by the normalized name, not the raw one", () => {
      const svc = serviceFor(`
routers:
  - id: iota-mainnet
    network: iota
    nodes:
      - name: Lava
        endpoints: [{ url: "https://iota.lava.build/keyed/path", interface: jsonrpc }]
`);
      // A caller reads the node name off getRouters() and hands it back; if the
      // key were the raw name the round-trip would 404.
      const node = svc.getRouters()[0]!.nodes[0]!.name;
      expect(svc.resolveEndpointUrl({ routerId: "iota-mainnet", node, endpointIndex: 0 })).toBe(
        "https://iota.lava.build/keyed/path",
      );
      // And the raw name a caller may still be holding (a hand-written call,
      // a name read off an older page) folds to the same endpoint rather than
      // 404-ing — the same folding the pin header goes through.
      expect(
        svc.resolveEndpointUrl({ routerId: "iota-mainnet", node: "Lava", endpointIndex: 0 }),
      ).toBe("https://iota.lava.build/keyed/path");
    });

    it("still falls back to the network when a node is unnamed", () => {
      const routers = serviceFor(`
routers:
  - id: A
    network: eth1
    nodes:
      - endpoints: [{ url: "https://x", interface: jsonrpc }]
`).getRouters();
      expect(routers[0]!.nodes[0]!.name).toBe("eth1");
    });
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

describe("normalizeHelmNodeName", () => {
  it("lowercases and de-spaces", () => {
    expect(normalizeHelmNodeName("Lava")).toBe("lava");
    expect(normalizeHelmNodeName("Blockdaemon")).toBe("blockdaemon");
    expect(normalizeHelmNodeName("My Node Co")).toBe("my-node-co");
  });

  it("leaves an already-normalized name untouched", () => {
    expect(normalizeHelmNodeName("sr-gateway")).toBe("sr-gateway");
    expect(normalizeHelmNodeName("")).toBe("");
  });
});

describe("SR_CONFIG node names are left verbatim", () => {
  it("does not fold the case of a name the router already registered", () => {
    // An SR_CONFIG file IS the router's config — its `name:` is already the
    // registered provider name.
    const routers = serviceFor(`
endpoints:
  - listen-address: "0.0.0.0:3360"
    chain-id: "ETH1"
    api-interface: "jsonrpc"
direct-rpc:
  - name: "Eth Lava"
    chain-id: "ETH1"
    api-interface: "jsonrpc"
    node-urls:
      - url: "https://eth1.lava.build"
`).getRouters();
    expect(routers[0]!.nodes[0]!.name).toBe("Eth Lava");
  });
});

/* ── Endpoint lookup: ONE vocabulary for the pin header and the relay ─────
   The pin header goes through `normalizeHelmNodeName`; so does the relay's
   own resolution, so "via router, pinned to X" and "straight to X" can never
   disagree about which upstream X is. */

describe("ConfigurationService.resolveEndpoint · node-name folding", () => {
  const HELM_MIXED_CASE = `
routers:
  - id: Iota-Mainnet
    network: iota
    nodes:
      - name: My Node Co
        endpoints: [{ url: "https://iota.mynode.example/keyed", interface: jsonrpc }]
`;

  it("folds the router id too — metrics labels arrive lowercased", () => {
    const svc = serviceFor(HELM_MIXED_CASE);
    expect(
      svc.resolveEndpointUrl({ routerId: "iota-mainnet", node: "my-node-co", endpointIndex: 0 }),
    ).toBe("https://iota.mynode.example/keyed");
  });

  it("accepts the display name the values file wrote", () => {
    const svc = serviceFor(HELM_MIXED_CASE);
    expect(
      svc.resolveEndpointUrl({ routerId: "Iota-Mainnet", node: "My Node Co", endpointIndex: 0 }),
    ).toBe("https://iota.mynode.example/keyed");
  });

  it("refuses to guess when two nodes fold to the same name", () => {
    // The router itself couldn't tell these apart either; dialing a coin-flip
    // upstream would make the comparison meaningless.
    const svc = serviceFor(`
routers:
  - id: A
    network: eth1
    nodes:
      - name: Node One
        endpoints: [{ url: "https://one.example", interface: jsonrpc }]
      - name: node-one
        endpoints: [{ url: "https://two.example", interface: jsonrpc }]
`);
    expect(svc.resolveEndpointUrl({ routerId: "A", node: "NODE ONE", endpointIndex: 0 })).toBeNull();
  });

  it("still resolves an SR_CONFIG name verbatim — that file IS the router's config", () => {
    const svc = serviceFor(`
endpoints:
  - listen-address: "0.0.0.0:3360"
    chain-id: "ETH1"
    api-interface: "jsonrpc"
direct-rpc:
  - name: "Eth Lava"
    chain-id: "ETH1"
    api-interface: "jsonrpc"
    node-urls:
      - url: "https://eth1.lava.build/keyed"
`);
    expect(svc.getRouters()[0]!.nodes[0]!.name).toBe("Eth Lava");
    expect(svc.resolveEndpointUrl({ routerId: "ETH1", node: "Eth Lava", endpointIndex: 0 })).toBe(
      "https://eth1.lava.build/keyed",
    );
  });
});

/* ── auth-config: the credential the router attaches, and the relay must ──── */

describe("ConfigurationService.resolveEndpoint · auth-config", () => {
  it("reads the helm dialect's auth headers and query, and keeps them out of the topology", () => {
    const svc = serviceFor(`
routers:
  - id: Hyperliquid
    network: hyperliquid
    nodes:
      - name: Lava
        endpoints:
          - url: "https://g.w.lavanet.xyz/gateway/hyperliquid/rpc-http/"
            interface: jsonrpc
            auth_config:
              auth_headers:
                Authorization: "Bearer 0f8d432c-18c2-47c0"
              auth_query: "apikey=abcdef123456"
`);
    const dial = svc.resolveEndpoint({ routerId: "Hyperliquid", node: "lava", endpointIndex: 0 })!;
    expect(dial.authHeaders).toEqual({ Authorization: "Bearer 0f8d432c-18c2-47c0" });
    expect(dial.authQuery).toBe("apikey=abcdef123456");
    expect(dial.unresolved).toEqual([]);
    // The masked topology is what the browser gets — no credential in it.
    expect(JSON.stringify(svc.getRouters())).not.toContain("0f8d432c-18c2-47c0");
    expect(JSON.stringify(svc.getRouters())).not.toContain("abcdef123456");
  });

  it("reads the SR_CONFIG dialect (kebab-case) off a node-url", () => {
    const svc = serviceFor(`
endpoints:
  - listen-address: "0.0.0.0:3360"
    chain-id: "ETH1"
    api-interface: "jsonrpc"
direct-rpc:
  - name: "eth-vendor"
    chain-id: "ETH1"
    api-interface: "jsonrpc"
    node-urls:
      - url: "https://rpc.vendor.example"
        auth-config:
          auth-headers:
            x-api-key: "sk-live-abcdef123456"
          auth-query: "token=t-abcdef123456"
`);
    const dial = svc.resolveEndpoint({ routerId: "ETH1", node: "eth-vendor", endpointIndex: 0 })!;
    expect(dial.authHeaders).toEqual({ "x-api-key": "sk-live-abcdef123456" });
    expect(dial.authQuery).toBe("token=t-abcdef123456");
  });

  it("substitutes a `${VAR}` from the values file's own routers env", () => {
    // The chart's config-processor initContainer runs envsubst over the
    // rendered router config; the literal lives in the same values file.
    const svc = serviceFor(`
miscellaneous:
  routers:
    env:
      - name: HL_TOKEN
        value: "tok-abcdef123456"
routers:
  - id: Hyperliquid
    network: hyperliquid
    nodes:
      - name: Lava
        endpoints:
          - url: "https://rpc.example/\${HL_TOKEN}/evm"
            interface: jsonrpc
            auth_config:
              auth_headers:
                Authorization: "Bearer \${HL_TOKEN}"
`);
    const dial = svc.resolveEndpoint({ routerId: "Hyperliquid", node: "lava", endpointIndex: 0 })!;
    expect(dial.url).toBe("https://rpc.example/tok-abcdef123456/evm");
    expect(dial.authHeaders).toEqual({ Authorization: "Bearer tok-abcdef123456" });
    expect(dial.unresolved).toEqual([]);
  });

  it("names what it could NOT resolve instead of dialing a literal placeholder", () => {
    const svc = serviceFor(`
miscellaneous:
  routers:
    env:
      - name: OTHER_TOKEN
        value: "irrelevant"
      - name: HL_TOKEN
        secretRef:
          name: hl-credentials
          key: token
routers:
  - id: Hyperliquid
    network: hyperliquid
    nodes:
      - name: Lava
        endpoints:
          - url: "https://rpc.example/evm"
            interface: jsonrpc
            auth_config:
              auth_headers:
                Authorization: "Bearer \${HL_TOKEN}"
`);
    const dial = svc.resolveEndpoint({ routerId: "Hyperliquid", node: "lava", endpointIndex: 0 })!;
    // A Secret the router mounts and the dashboard does not.
    expect(dial.unresolved).toEqual(["${HL_TOKEN}"]);
    expect(dial.authHeaders).toEqual({ Authorization: "Bearer ${HL_TOKEN}" });
  });

  it("flags a header handed over as a secretRef object", () => {
    const svc = serviceFor(`
routers:
  - id: A
    network: eth1
    nodes:
      - name: Vendor
        endpoints:
          - url: "https://rpc.example"
            interface: jsonrpc
            auth_config:
              auth_headers:
                Authorization:
                  secretRef:
                    name: vendor-credentials
                    key: token
`);
    const dial = svc.resolveEndpoint({ routerId: "A", node: "vendor", endpointIndex: 0 })!;
    expect(dial.authHeaders).toEqual({});
    expect(dial.unresolved).toEqual(["Authorization (Kubernetes secret)"]);
  });

  it("leaves an endpoint with no auth-config carrying nothing", () => {
    const svc = serviceFor(SR_CONFIG_ETH);
    const dial = svc.resolveEndpoint({ routerId: "ETH1", node: "eth-lava", endpointIndex: 0 })!;
    expect(dial.authHeaders).toEqual({});
    expect(dial.authQuery).toBeNull();
    expect(dial.unresolved).toEqual([]);
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

/* ── Direct-relay resolution ──────────────────────────────────────────────
   The masked topology and the private url map are built in ONE pass, so the
   index a row publishes and the url the relay dials can never drift apart. */

describe("ConfigurationService.resolveEndpointUrl", () => {
  it("returns the FULL url — the part getRouters() masks away (SR_CONFIG)", () => {
    const svc = serviceFor(SR_CONFIG_ETH);
    const masked = svc.getRouters()[0]!.nodes[0]!.endpoints[0]!;
    expect(masked.urlHost).toBe("https://eth1.lava.build");
    expect(svc.resolveEndpointUrl({ routerId: "ETH1", node: "eth-lava", endpointIndex: 0 })).toBe(
      "https://eth1.lava.build/lava-referer-secret-key/",
    );
  });

  it("indexes each node's endpoints in publication order", () => {
    const svc = serviceFor(SR_CONFIG_ETH);
    const endpoints = svc.getRouters()[0]!.nodes[0]!.endpoints;
    expect(endpoints.map((e) => e.index)).toEqual([0, 1]);
    expect(svc.resolveEndpointUrl({ routerId: "ETH1", node: "eth-lava", endpointIndex: 1 })).toBe(
      "wss://eth1.lava.build/websocket",
    );
  });

  it("resolves helm-format endpoints by the router id it publishes", () => {
    const svc = serviceFor(HELM_FULL);
    // `id: Ethereum` — NOT the uppercased network, which is what `spec` is.
    expect(svc.resolveEndpointUrl({ routerId: "Ethereum", node: "lava", endpointIndex: 0 })).toBe(
      "https://eth1.lava.build/some/keyed/path",
    );
    expect(svc.resolveEndpointUrl({ routerId: "ETH1", node: "lava", endpointIndex: 0 })).toBeNull();
  });

  it("returns null for anything the values file doesn't name", () => {
    const svc = serviceFor(SR_CONFIG_ETH);
    expect(svc.resolveEndpointUrl({ routerId: "ETH1", node: "eth-lava", endpointIndex: 9 })).toBeNull();
    expect(svc.resolveEndpointUrl({ routerId: "ETH1", node: "ghost", endpointIndex: 0 })).toBeNull();
    expect(svc.resolveEndpointUrl({ routerId: "NOPE", node: "eth-lava", endpointIndex: 0 })).toBeNull();
  });

  it("carries internal_path through the helm normalizer, null when absent", () => {
    // TON on Tatum: v2 at the ROOT, v3 under /api/v3. maskNodeUrl strips path
    // and query, so without internalPath these two rows are indistinguishable.
    const svc = serviceFor(`
routers:
  - id: ton-mainnet
    network: ton
    nodes:
      - name: chainstack
        endpoints:
          - url: https://ton-mainnet.core.chainstack.com/KEY/api
            interface: rest
      - name: tatum
        endpoints:
          - url: https://ton-mainnet.gateway.tatum.io
            interface: rest
            internal_path: "/v2"
          - url: https://ton-mainnet.gateway.tatum.io/api/v3
            interface: rest
            internal_path: "/v3"
`);
    const nodes = svc.getRouters()[0]!.nodes;
    expect(nodes[0]!.endpoints[0]!.internalPath).toBeNull();
    const tatum = nodes[1]!.endpoints;
    expect(tatum.map((e) => e.internalPath)).toEqual(["/v2", "/v3"]);
    // Both mask to the same host — the internal path is the only thing that
    // separates them, which is exactly why it has to survive normalization.
    expect(tatum[0]!.urlHost).toBe(tatum[1]!.urlHost);
  });

  it("reads the kebab-case internal-path dialect in an SR_CONFIG file", () => {
    const svc = serviceFor(`
endpoints:
  - listen-address: "0.0.0.0:3370"
    chain-id: "TON"
    api-interface: "rest"
direct-rpc:
  - name: "tatum"
    chain-id: "TON"
    api-interface: "rest"
    node-urls:
      - url: "https://ton-mainnet.gateway.tatum.io"
        internal-path: "/v2"
      - url: "https://ton-mainnet.gateway.tatum.io/api/v3"
        internal-path: "/v3"
`);
    const eps = svc.getRouters()[0]!.nodes[0]!.endpoints;
    expect(eps.map((e) => e.internalPath)).toEqual(["/v2", "/v3"]);
  });

  it("marks http/ws endpoints directable and grpc ones not", () => {
    const svc = serviceFor(`
endpoints:
  - listen-address: "0.0.0.0:3366"
    chain-id: "COSMOSHUB"
    api-interface: "grpc"
direct-rpc:
  - name: "cosmos-grpc"
    chain-id: "COSMOSHUB"
    api-interface: "grpc"
    node-urls:
      - url: "grpcs://cosmos-grpc.publicnode.com:443"
`);
    const ep = svc.getRouters()[0]!.nodes[0]!.endpoints[0]!;
    expect(ep.directable).toBe(false);
    // Still resolvable — the ROUTE refuses the scheme, so the reason a caller
    // gets is about gRPC, not a phantom "no such endpoint".
    expect(svc.resolveEndpointUrl({ routerId: "COSMOSHUB", node: "cosmos-grpc", endpointIndex: 0 }))
      .toBe("grpcs://cosmos-grpc.publicnode.com:443");
  });
});
