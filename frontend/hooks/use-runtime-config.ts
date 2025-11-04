'use client';

import { useState, useEffect } from 'react';
import { getRuntimeConfig, type RuntimeConfig } from '@/lib/runtime-config';

/**
 * Hook to access runtime configuration
 *
 * This hook fetches runtime environment variables from the API endpoint
 * and provides them to components. The config is cached after the first fetch.
 *
 * @returns The runtime configuration object
 */
export function useRuntimeConfig() {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getRuntimeConfig().then(runtimeConfig => {
      setConfig(runtimeConfig);
      setLoading(false);
    });
  }, []);

  return { config, loading };
}
