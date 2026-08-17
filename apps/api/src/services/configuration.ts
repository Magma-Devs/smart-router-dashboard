/**
 * Reads the live smart-router config (the mounted values file) the dashboard
 * reflects. Ports v1's dual-format loader (`app/services/configuration.py`):
 *
 * 1. **Helm-chart values** — `routers:[{id, network, nodes:[{name, is_backup,
 *    endpoints:[{url, interface, addons}]}], custom_url_prefix?, pathBased?}]`
 *    plus the global `miscellaneous.gateway.pathBased.enabled` default. When
 *    the values' Gateway is enabled, each interface also gets its public
 *    URL (`publicUrls`) — see `readGatewayRouting` below.
 * 2. **Smart-router SR_CONFIG** — the YAML the router itself runs
 *    (`endpoints:` + `direct-rpc:`); providers are grouped by chain-id into
 *    one router per chain, and the `endpoints` block's listen ports become
 *    `localPorts` (keyed per api-interface — one chain can expose several
 *    interfaces on different ports).
 *
 * Detection is by key: `routers` ⇒ helm; `direct-rpc` ⇒ sr-config; anything
 * else yields an empty topology. Node URLs are sanitized to scheme+host —
 * upstream provider URLs routinely embed API keys in the path.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { RouterNode, RouterTopology, UpstreamEndpointRef } from "@sr/shared";
import { config } from "../config.js";

/** First defined value among several key dialects (snake/kebab/camel). */
function pick(obj: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function asArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null) : [];
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Keep scheme + host (incl. port) only — paths/queries often carry API keys. */
export function maskNodeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}

/**
 * Whether the relay can dial this url on the user's behalf. http(s) and
 * ws(s) only — a `grpcs://` upstream needs a gRPC client the api doesn't
 * carry, and anything else isn't a transport we speak.
 */
export function isDirectable(url: string): boolean {
  try {
    const proto = new URL(url).protocol;
    return proto === "http:" || proto === "https:" || proto === "ws:" || proto === "wss:";
  } catch {
    return false;
  }
}

/** Extract the port from a `host:port` listen-address (`0.0.0.0:3360`). */
export function portFromListenAddress(listen: string | undefined): number | null {
  if (!listen || !listen.includes(":")) return null;
  const port = Number(listen.slice(listen.lastIndexOf(":") + 1).trim());
  return Number.isInteger(port) && port > 0 ? port : null;
}

function detectFormat(raw: unknown): "helm" | "sr-config" | "unknown" {
  if (typeof raw !== "object" || raw === null) return "unknown";
  const o = raw as Record<string, unknown>;
  if ("routers" in o) return "helm";
  if ("direct-rpc" in o) return "sr-config";
  return "unknown";
}

/**
 * How the Gateway publishes routers, or null when the mounted values
 * describe no routable address (gateway disabled, no `base_domain`, or a
 * listener list with nothing HTTP(S) on it). Mirrors the Gateway + HTTPRoute
 * shapes the values declare: an HTTPS listener wins over HTTP because
 * deployments ship both and TLS is the one users dial.
 */
interface GatewayRouting {
  scheme: "http" | "https";
  /** `":8443"` — empty string for the scheme's default port. */
  portSuffix: string;
  /** `chain.interface` (the default) or `chain-interface`. */
  hostStructure: "chain.interface" | "chain-interface";
  baseDomain: string;
}

function readGatewayRouting(raw: Record<string, unknown>): GatewayRouting | null {
  const baseDomain = asString(raw["base_domain"]).trim();
  if (!baseDomain) return null;

  const misc = (raw["miscellaneous"] ?? {}) as Record<string, unknown>;
  const gateway = (misc["gateway"] ?? {}) as Record<string, unknown>;
  if (gateway["enabled"] !== true) return null;

  const listeners = asArray(gateway["listeners"]);
  const https = listeners.find(
    (l) => asString(l["protocol"]).toUpperCase() === "HTTPS" || l["tls"] !== undefined,
  );
  const listener = https ?? listeners.find((l) => asString(l["protocol"]).toUpperCase() === "HTTP");
  if (!listener) return null;

  const scheme = https !== undefined ? "https" : "http";
  const defaultPort = scheme === "https" ? 443 : 80;
  const declared = Number(listener["port"]);
  const port = Number.isInteger(declared) && declared > 0 ? declared : defaultPort;

  return {
    scheme,
    portSuffix: port === defaultPort ? "" : `:${port}`,
    hostStructure:
      asString(gateway["hostStructure"]) === "chain-interface"
        ? "chain-interface"
        : "chain.interface",
    baseDomain,
  };
}

/**
 * api-interface → public URL, mirroring the deployment's hostname scheme:
 * `<custom_url_prefix | id-lowered>[-<iface> | .<iface>].<base_domain>`.
 * grpc interfaces are included — GRPCRoutes publish them on the same
 * hostname scheme as the HTTPRoutes.
 */
function publicUrlsFor(
  router: Record<string, unknown>,
  interfaces: string[],
  gw: GatewayRouting | null,
): Record<string, string> {
  if (!gw) return {};
  // The values resolve `custom_url_prefix | default (id | lower)` — the custom
  // prefix verbatim, only the id fallback lowercased.
  const prefix =
    asString(pick(router, "custom_url_prefix", "custom-url-prefix", "customUrlPrefix")) ||
    asString(router["id"]).toLowerCase();
  if (!prefix) return {};

  const urls: Record<string, string> = {};
  for (const iface of interfaces) {
    const i = iface.toLowerCase();
    const host =
      gw.hostStructure === "chain-interface"
        ? `${prefix}-${i}.${gw.baseDomain}`
        : `${prefix}.${i}.${gw.baseDomain}`;
    urls[iface] = `${gw.scheme}://${host}${gw.portSuffix}`;
  }
  return urls;
}

/**
 * Key under which a node endpoint's FULL (credentialed) url is recorded while
 * the topology is normalized. Recording it in the same pass that builds the
 * masked view is deliberate: a second, independent traversal could drift from
 * the one that assigned the indices, and then the relay would dial the wrong
 * upstream.
 */
export function endpointKey(routerId: string, node: string, index: number): string {
  return `${routerId} ${node} ${index}`;
}

/* Temporary: mirror the chart's `lower | replace " " "-"` so node names match
   what the router registers (and reports on `provider_address`). Drop once the
   router matches `lava-select-provider` case-insensitively. */
export function normalizeHelmNodeName(name: string): string {
  return name.toLowerCase().replace(/ /g, "-");
}

/** Helm `routers:` shape → RouterTopology[] (pathBased resolved like the chart). */
function normalizeHelm(raw: Record<string, unknown>, urls: Map<string, string>): RouterTopology[] {
  const misc = (raw["miscellaneous"] ?? {}) as Record<string, unknown>;
  const gateway = (misc["gateway"] ?? {}) as Record<string, unknown>;
  const pathBasedCfg = (gateway["pathBased"] ?? {}) as Record<string, unknown>;
  const globalPathBased = Boolean(pathBasedCfg["enabled"] ?? false);
  const gw = readGatewayRouting(raw);

  return asArray(raw["routers"]).map((router) => {
    const network = asString(router["network"]).toLowerCase();
    const override = pick(router, "pathBased", "path-based", "path_based");
    const routerId = asString(router["id"]) || network.toUpperCase();

    const nodes: RouterNode[] = asArray(router["nodes"]).map((node) => {
      const name = normalizeHelmNodeName(asString(node["name"])) || network;
      return {
        name,
        isBackup: Boolean(pick(node, "is_backup", "is-backup", "isBackup") ?? false),
        endpoints: asArray(node["endpoints"])
          .filter((ep) => asString(ep["url"]))
          .map((ep, index) => {
            const url = asString(ep["url"]);
            urls.set(endpointKey(routerId, name, index), url);
            return {
              urlHost: maskNodeUrl(url),
              interface: asString(ep["interface"]),
              addons: Array.isArray(ep["addons"]) ? ep["addons"].map(String) : [],
              index,
              directable: isDirectable(url),
            };
          }),
      };
    });

    const interfaces = dedupe(nodes.flatMap((n) => n.endpoints.map((e) => e.interface)));

    return {
      id: routerId,
      spec: network.toUpperCase(),
      network,
      pathBased: override !== undefined ? Boolean(override) : globalPathBased,
      customUrlPrefix:
        asString(pick(router, "custom_url_prefix", "custom-url-prefix", "customUrlPrefix")) ||
        null,
      localPort: null,
      localPorts: {},
      publicUrls: publicUrlsFor(router, interfaces, gw),
      interfaces,
      nodes,
    };
  });
}

/** SR_CONFIG shape → RouterTopology[] (grouped by chain, per-interface ports). */
function normalizeSrConfig(raw: Record<string, unknown>, urls: Map<string, string>): RouterTopology[] {
  // (chain-id → api-interface → port). Keyed per interface because one chain
  // can expose several interfaces on different ports (LAVA rest:3360 +
  // tendermintrpc:3361); "" buckets legacy entries that omit api-interface.
  const portsByChain = new Map<string, Record<string, number>>();
  for (const ep of asArray(raw["endpoints"])) {
    const chainId = asString(ep["chain-id"]);
    const port = portFromListenAddress(
      asString(pick(ep, "listen-address", "network-address")),
    );
    if (!chainId || port === null) continue;
    const bucket = portsByChain.get(chainId) ?? {};
    const iface = asString(ep["api-interface"]);
    if (bucket[iface] === undefined) bucket[iface] = port;
    portsByChain.set(chainId, bucket);
  }

  const byChain = new Map<string, RouterTopology>();

  // Process a provider list into the topology. `direct-rpc` is the primary
  // tier; `backup-direct-rpc` (the router's emergency-fallback section) marks
  // its nodes isBackup so the Upstreams/Endpoints UI can tag them "backup".
  const addProviders = (key: string, isBackup: boolean): void => {
    for (const provider of asArray(raw[key])) {
      const chainId = asString(provider["chain-id"]);
      if (!chainId) continue;
      const iface = asString(provider["api-interface"]);

      let router = byChain.get(chainId);
      if (!router) {
        const ports = portsByChain.get(chainId) ?? {};
        const firstPort = Object.values(ports)[0] ?? null;
        router = {
          id: chainId,
          spec: chainId,
          network: chainId.toLowerCase(),
          pathBased: false,
          customUrlPrefix: null,
          localPort: firstPort,
          localPorts: ports,
          // An SR_CONFIG mount describes listen ports, not ingress — the
          // dashboard has no way to know what fronts them.
          publicUrls: {},
          interfaces: [],
          nodes: [],
        };
        byChain.set(chainId, router);
      }

      const name = asString(provider["name"]) || chainId;
      const endpoints = asArray(provider["node-urls"])
        .filter((nu) => asString(nu["url"]))
        .map((nu, index) => {
          const url = asString(nu["url"]);
          urls.set(endpointKey(router.id, name, index), url);
          return {
            urlHost: maskNodeUrl(url),
            interface: iface,
            addons: Array.isArray(nu["addons"]) ? nu["addons"].map(String) : [],
            index,
            directable: isDirectable(url),
          };
        });

      router.nodes.push({ name, isBackup, endpoints });
      router.interfaces = dedupe([...router.interfaces, iface]);
    }
  };

  addProviders("direct-rpc", false);
  addProviders("backup-direct-rpc", true);

  return [...byChain.values()];
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export class ConfigurationService {
  constructor(private readonly valuesDir: string = config.config.valuesDir) {}

  private readRaw(): unknown {
    const path = join(this.valuesDir, "core", "values.yml");
    try {
      return parse(readFileSync(path, "utf8"));
    } catch {
      return null;
    }
  }

  /**
   * Normalize the mounted values file into BOTH the masked topology the api
   * serves and the private url map the relay resolves against. The file is
   * re-read per call (it is a live mount — the operator can edit it under a
   * running api), so both views are always the same generation of the file.
   */
  private normalize(): { routers: RouterTopology[]; urls: Map<string, string> } {
    const raw = this.readRaw();
    const urls = new Map<string, string>();
    switch (detectFormat(raw)) {
      case "helm":
        return { routers: normalizeHelm(raw as Record<string, unknown>, urls), urls };
      case "sr-config":
        return { routers: normalizeSrConfig(raw as Record<string, unknown>, urls), urls };
      default:
        return { routers: [], urls };
    }
  }

  /** The normalized topology from EITHER supported values-file format. */
  getRouters(): RouterTopology[] {
    return this.normalize().routers;
  }

  /**
   * The FULL url of one configured node endpoint — path, query and any API
   * key the operator put in it. THE ONLY function that returns an unmasked
   * upstream url; its single caller is the direct-relay route, which dials it
   * server-side and never echoes it back. Null when the triple names nothing
   * in the current values file.
   */
  resolveEndpointUrl(ref: UpstreamEndpointRef): string | null {
    return this.normalize().urls.get(endpointKey(ref.routerId, ref.node, ref.endpointIndex)) ?? null;
  }
}
