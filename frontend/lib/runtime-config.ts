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
