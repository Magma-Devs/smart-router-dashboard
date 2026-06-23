/**
 * Reads the live smart-router config (helm-values YAML) the dashboard reflects.
 * Ports the essential shape of `app/services/configuration.py`: it understands
 * the router's native `endpoints:` + `direct-rpc:` example format and groups
 * direct-rpc providers by (chain-id, api-interface) into router rows.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { RouterConfig, RouterConfigNode } from "@sr/shared";
import { config } from "../config.js";

interface RawNodeUrl {
  url?: string;
  addons?: string[];
}
interface RawDirectRpc {
  name?: string;
  "chain-id"?: string;
  "api-interface"?: string;
  "node-urls"?: RawNodeUrl[];
}
interface RawEndpoint {
  "chain-id"?: string;
  "api-interface"?: string;
  "listen-address"?: string;
  "network-address"?: string;
}
interface RawConfig {
  endpoints?: RawEndpoint[];
  "direct-rpc"?: RawDirectRpc[];
}

function portFromListen(listen: string | undefined): number | null {
  if (!listen) return null;
  const m = listen.match(/:(\d+)$/);
  return m && m[1] ? Number(m[1]) : null;
}

export class ConfigurationService {
  constructor(private readonly valuesDir: string = config.config.valuesDir) {}

  private readRaw(): RawConfig | null {
    const path = join(this.valuesDir, "core", "values.yml");
    try {
      return parse(readFileSync(path, "utf8")) as RawConfig;
    } catch {
      return null;
    }
  }

  /** Group direct-rpc providers into one RouterConfig per (chain, interface). */
  getRouters(): RouterConfig[] {
    const raw = this.readRaw();
    if (!raw) return [];

    const listenByKey = new Map<string, number | null>();
    for (const ep of raw.endpoints ?? []) {
      const key = `${ep["chain-id"]}|${ep["api-interface"]}`;
      listenByKey.set(key, portFromListen(ep["listen-address"] ?? ep["network-address"]));
    }

    const byKey = new Map<string, RouterConfig>();
    for (const provider of raw["direct-rpc"] ?? []) {
      const spec = provider["chain-id"];
      const apiInterface = provider["api-interface"];
      if (!spec || !apiInterface) continue;
      const key = `${spec}|${apiInterface}`;

      let router = byKey.get(key);
      if (!router) {
        router = {
          spec,
          apiInterface,
          listenPort: listenByKey.get(key) ?? null,
          nodes: [],
        };
        byKey.set(key, router);
      }

      const node: RouterConfigNode = {
        name: provider.name ?? spec,
        url: provider["node-urls"]?.[0]?.url ?? "",
        addons: provider["node-urls"]?.flatMap((u) => u.addons ?? []) ?? [],
      };
      router.nodes.push(node);
    }

    return [...byKey.values()];
  }
}
