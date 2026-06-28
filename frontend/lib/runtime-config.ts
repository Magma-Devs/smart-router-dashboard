/**
 * Runtime Configuration Utility
 *
 * This module provides runtime access to environment variables that can be
 * set at container runtime, rather than being embedded at build time.
 *
 * The config is fetched once and cached for the lifetime of the application.
 */

export interface RuntimeConfig {
  NEXT_PUBLIC_API_URL: string;
  NEXT_PUBLIC_DOMAIN: string;
  NEXT_PUBLIC_PORT: string;
  NEXT_PUBLIC_PROMETHEUS_URL: string;
  NEXT_PUBLIC_USE_TLS: string;
  // 'true' for a local docker-compose run: chains are reached directly at
  // localhost:<port> (port from the router config) instead of the gateway's
  // <chain>-<interface>.<domain> subdomain shape.
  NEXT_PUBLIC_LOCAL_MODE: string;
}

let cachedConfig: RuntimeConfig | null = null;
let configPromise: Promise<RuntimeConfig> | null = null;

/**
 * Fetches runtime configuration from the API endpoint.
 * Results are cached after the first fetch.
 */
async function fetchRuntimeConfig(): Promise<RuntimeConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }

  if (configPromise) {
    return configPromise;
  }

  configPromise = (async () => {
    try {
      const response = await fetch('/api/config');
      if (!response.ok) {
        throw new Error(`Failed to fetch config: ${response.statusText}`);
      }
      const config = await response.json();
      cachedConfig = config;
      return config;
    } catch (error) {
      // Fallback to defaults if API call fails
      const fallbackConfig: RuntimeConfig = {
        NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000',
        NEXT_PUBLIC_DOMAIN: process.env.NEXT_PUBLIC_DOMAIN || 'localhost',
        NEXT_PUBLIC_PORT: process.env.NEXT_PUBLIC_PORT || '3000',
        NEXT_PUBLIC_PROMETHEUS_URL:
          process.env.NEXT_PUBLIC_PROMETHEUS_URL || 'http://localhost:9090',
        NEXT_PUBLIC_USE_TLS: process.env.NEXT_PUBLIC_USE_TLS || 'true',
        NEXT_PUBLIC_LOCAL_MODE: process.env.NEXT_PUBLIC_LOCAL_MODE || 'false',
      };
      return fallbackConfig;
    } finally {
      configPromise = null;
    }
  })();

  return configPromise;
}

/**
 * Gets the runtime configuration.
 *
 * This function will fetch the config from the API if not already cached.
 * In SSR contexts, it falls back to environment variables directly.
 *
 * @returns Promise resolving to the runtime configuration
 */
export async function getRuntimeConfig(): Promise<RuntimeConfig> {
  // In SSR context, read directly from env vars
  if (typeof window === 'undefined') {
    return {
      NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000',
      NEXT_PUBLIC_DOMAIN: process.env.NEXT_PUBLIC_DOMAIN || 'localhost',
      NEXT_PUBLIC_PORT: process.env.NEXT_PUBLIC_PORT || '3000',
      NEXT_PUBLIC_PROMETHEUS_URL: process.env.NEXT_PUBLIC_PROMETHEUS_URL || 'http://localhost:9090',
      NEXT_PUBLIC_USE_TLS: process.env.NEXT_PUBLIC_USE_TLS || 'true',
      NEXT_PUBLIC_LOCAL_MODE: process.env.NEXT_PUBLIC_LOCAL_MODE || 'false',
    };
  }

  return fetchRuntimeConfig();
}

/**
 * Gets a specific runtime config value synchronously.
 *
 * ⚠️ WARNING: This will return undefined if called before the config is loaded.
 * Use getRuntimeConfig() or useRuntimeConfig() hook for guaranteed values.
 *
 * @param key - The config key to retrieve
 * @returns The config value or undefined if not yet loaded
 */
export function getRuntimeConfigSync(key: keyof RuntimeConfig): string | undefined {
  return cachedConfig?.[key];
}

/**
 * Gets the API URL from runtime config.
 * Falls back to build-time env var if runtime config not available.
 */
export function getApiUrl(): string {
  if (typeof window !== 'undefined' && cachedConfig) {
    return cachedConfig.NEXT_PUBLIC_API_URL;
  }
  return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
}

/**
 * Gets the domain from runtime config.
 * Falls back to build-time env var if runtime config not available.
 */
export function getDomain(): string {
  if (typeof window !== 'undefined' && cachedConfig) {
    return cachedConfig.NEXT_PUBLIC_DOMAIN;
  }
  return process.env.NEXT_PUBLIC_DOMAIN || 'localhost';
}

/**
 * Gets the port from runtime config.
 * Falls back to build-time env var if runtime config not available.
 */
export function getPort(): string {
  if (typeof window !== 'undefined' && cachedConfig) {
    return cachedConfig.NEXT_PUBLIC_PORT;
  }
  return process.env.NEXT_PUBLIC_PORT || '3000';
}

/**
 * Gets the Prometheus URL from runtime config.
 * Falls back to build-time env var if runtime config not available.
 */
export function getPrometheusUrl(): string {
  if (typeof window !== 'undefined' && cachedConfig) {
    return cachedConfig.NEXT_PUBLIC_PROMETHEUS_URL;
  }
  return process.env.NEXT_PUBLIC_PROMETHEUS_URL || 'http://localhost:9090';
}

/**
 * Gets the scheme ('http' | 'https') from runtime config.
 * Defaults to https.
 */
export function getEndpointScheme(): 'http' | 'https' {
  const useTls =
    typeof window !== 'undefined' && cachedConfig
      ? cachedConfig.NEXT_PUBLIC_USE_TLS
      : process.env.NEXT_PUBLIC_USE_TLS;
  return useTls === 'false' ? 'http' : 'https';
}

/**
 * Gets the WebSocket scheme ('ws' | 'wss')
 * when TLS is on, `ws` when off. Same `NEXT_PUBLIC_USE_TLS` switch.
 */
export function getWebSocketScheme(): 'ws' | 'wss' {
  return getEndpointScheme() === 'https' ? 'wss' : 'ws';
}

/**
 * Whether the dashboard is running against a local docker-compose smart-router.
 * In local mode there's no gateway: each chain is reached at localhost:<port>.
 */
export function getLocalMode(): boolean {
  const localMode =
    typeof window !== 'undefined' && cachedConfig
      ? cachedConfig.NEXT_PUBLIC_LOCAL_MODE
      : process.env.NEXT_PUBLIC_LOCAL_MODE;
  return localMode === 'true';
}

/**
 * Builds the base endpoint URL for a chain's interface.
 *
 * - **Local mode** (docker-compose): `http://localhost:<localPort>` — the
 *   chain is reached directly on its published port over plain HTTP (the local
 *   router has no TLS), so the scheme is always `http`/`ws` regardless of
 *   `NEXT_PUBLIC_USE_TLS`; `domain`/`port` and the `<chain>-<interface>`
 *   subdomain shape don't apply. Returns null when no local port is known for
 *   the chain (so callers can skip / show a hint).
 * - **Gateway mode** (default): `<scheme>://<chain>-<interface>.<domain>:<port>`
 *   — the production shape routed by the gateway on the Host header.
 * - **Gateway, path-based** (`pathBased: true`): `<scheme>://<prefix>.<domain>:<port>/<interface>`
 *   — the additive path-based shape (the gateway strips the `/<interface>`
 *   prefix before the router). `prefix` is `urlPrefix` when set (the chart's
 *   `custom_url_prefix`), else the lowercased `chainId` (the router id).
 *
 * @param chainId      chain id / router id (any case; lowercased for the host)
 * @param interfaceType e.g. 'jsonrpc', 'rest', 'tendermintrpc'
 * @param domain        gateway domain (gateway mode only)
 * @param port          gateway port (gateway mode only)
 * @param localPort     chain's local listen port (local mode only)
 * @param ws            build a websocket base (ws/wss) instead of http(s)
 * @param pathBased     route via <prefix>.<domain>/<interface> (gateway mode)
 * @param urlPrefix     host prefix override (chart's custom_url_prefix); when
 *                      omitted the lowercased chainId is used
 */
export function buildEndpointBaseUrl(params: {
  chainId: string;
  interfaceType: string;
  domain: string;
  port: string;
  localPort?: number | null;
  ws?: boolean;
  pathBased?: boolean;
  urlPrefix?: string | null;
}): string | null {
  const { chainId, interfaceType, domain, port, localPort, ws, pathBased, urlPrefix } = params;

  if (getLocalMode()) {
    if (localPort == null) return null;
    // The local docker-compose router serves plain HTTP/WS (no TLS), so force
    // http/ws here rather than honoring NEXT_PUBLIC_USE_TLS.
    const scheme = ws ? 'ws' : 'http';
    return `${scheme}://localhost:${localPort}`;
  }

  const scheme = ws ? getWebSocketScheme() : getEndpointScheme();
  const iface = interfaceType.toLowerCase();

  if (pathBased) {
    // Additive path-based shape: <prefix>.<domain>:<port>/<interface>.
    // Matches the chart's HTTPRoute (hostname <prefix>.<base_domain>,
    // PathPrefix /<interface> rewritten to /). The prefix is the chart's
    // custom_url_prefix when present, else the lowercased router id.
    const prefix = (urlPrefix || chainId).toLowerCase();
    return `${scheme}://${prefix}.${domain}:${port}/${iface}`;
  }

  const prefix = (urlPrefix || chainId).toLowerCase();
  const host = `${prefix}-${iface}.${domain}`;
  return `${scheme}://${host}:${port}`;
}
