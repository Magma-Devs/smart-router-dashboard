/**
 * Reads the live smart-router config (the mounted values file) the dashboard
 * reflects. Ports v1's dual-format loader (`app/services/configuration.py`):
 *
 * 1. **Helm-chart values** — `routers:[{id, network, nodes:[{name, is_backup,
 *    endpoints:[{url, interface, addons}]}], custom_url_prefix?, pathBased?}]`
 *    plus the global `miscellaneous.gateway.pathBased.enabled` default.
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
import type { RouterNode, RouterTopology } from "@sr/shared";
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

/** Helm `routers:` shape → RouterTopology[] (pathBased resolved like the chart). */
function normalizeHelm(raw: Record<string, unknown>): RouterTopology[] {
  const misc = (raw["miscellaneous"] ?? {}) as Record<string, unknown>;
  const gateway = (misc["gateway"] ?? {}) as Record<string, unknown>;
  const pathBasedCfg = (gateway["pathBased"] ?? {}) as Record<string, unknown>;
  const globalPathBased = Boolean(pathBasedCfg["enabled"] ?? false);

  return asArray(raw["routers"]).map((router) => {
    const network = asString(router["network"]).toLowerCase();
    const override = pick(router, "pathBased", "path-based", "path_based");

    const nodes: RouterNode[] = asArray(router["nodes"]).map((node) => ({
      name: asString(node["name"]) || network,
      isBackup: Boolean(pick(node, "is_backup", "is-backup", "isBackup") ?? false),
      endpoints: asArray(node["endpoints"])
        .filter((ep) => asString(ep["url"]))
        .map((ep) => ({
          urlHost: maskNodeUrl(asString(ep["url"])),
          interface: asString(ep["interface"]),
          addons: Array.isArray(ep["addons"]) ? ep["addons"].map(String) : [],
        })),
    }));

    return {
      id: asString(router["id"]) || network.toUpperCase(),
      spec: network.toUpperCase(),
      network,
      pathBased: override !== undefined ? Boolean(override) : globalPathBased,
      customUrlPrefix:
        asString(pick(router, "custom_url_prefix", "custom-url-prefix", "customUrlPrefix")) ||
        null,
      localPort: null,
      localPorts: {},
      interfaces: dedupe(nodes.flatMap((n) => n.endpoints.map((e) => e.interface))),
      nodes,
    };
  });
}

/** SR_CONFIG shape → RouterTopology[] (grouped by chain, per-interface ports). */
function normalizeSrConfig(raw: Record<string, unknown>): RouterTopology[] {
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
          interfaces: [],
          nodes: [],
        };
        byChain.set(chainId, router);
      }

      const endpoints = asArray(provider["node-urls"])
        .filter((nu) => asString(nu["url"]))
        .map((nu) => ({
          urlHost: maskNodeUrl(asString(nu["url"])),
          interface: iface,
          addons: Array.isArray(nu["addons"]) ? nu["addons"].map(String) : [],
        }));

      router.nodes.push({
        name: asString(provider["name"]) || chainId,
        isBackup,
        endpoints,
      });
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

  /** The normalized topology from EITHER supported values-file format. */
  getRouters(): RouterTopology[] {
    const raw = this.readRaw();
    switch (detectFormat(raw)) {
      case "helm":
        return normalizeHelm(raw as Record<string, unknown>);
      case "sr-config":
        return normalizeSrConfig(raw as Record<string, unknown>);
      default:
        return [];
    }
  }
}
