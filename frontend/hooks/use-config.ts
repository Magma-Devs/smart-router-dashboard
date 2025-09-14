'use client';

/**
 * Configuration Management Hook
 *
 * This hook provides centralized configuration management for the dashboard application.
 * It handles API endpoint configuration, refresh intervals, and persistent storage
 * of user preferences using localStorage.
 */

import { useState, useEffect } from 'react';
import { useLocalStorage } from '@/hooks/use-local-storage';

/**
 * Configuration object interface
 */
interface Config {
  apiEndpoint: string; // Backend API endpoint URL
  refreshInterval: number; // Auto-refresh interval in seconds
}

/**
 * Configuration management hook for dashboard settings.
 *
 * This hook manages application configuration including:
 * - API endpoint URL (with fallback to environment variable)
 * - Auto-refresh interval for data polling
 * - Persistent storage of user preferences
 * - Configuration validation and sanitization
 *
 * @returns Object containing current config and update functions
 *
 * @example
 * ```typescript
 * const { config, updateApiEndpoint, updateRefreshInterval, resetConfig } = useConfig()
 *
 * // Access current configuration
 * console.log(config.apiEndpoint)     // "https://api.example.com"
 * console.log(config.refreshInterval) // 60
 *
 * // Update configuration
 * updateApiEndpoint("https://new-api.example.com")
 * updateRefreshInterval(30)
 *
 * // Reset to defaults
 * resetConfig()
 * ```
 */
export function useConfig() {
  // Initialize with environment variable or null for first-time users
  const [apiHost, setApiHost] = useLocalStorage<string | null>(
    'api-host',
    process.env.NEXT_PUBLIC_API_URL || null,
  );

  // Default refresh interval of 60 seconds
  const [refreshInterval, setRefreshInterval] = useLocalStorage<number>('refresh-interval', 60);

  /**
   * Initialize API host from environment variable if not set.
   * This ensures new users get the default configuration automatically.
   */
  useEffect(() => {
    if (apiHost === null) {
      const defaultEndpoint = process.env.NEXT_PUBLIC_API_URL;
      if (defaultEndpoint) {
        setApiHost(defaultEndpoint);
      }
    }
  }, [apiHost, setApiHost]);

  /**
   * Updates the API endpoint URL with validation.
   *
   * Automatically removes trailing slashes to ensure consistent URL format
   * and prevent double-slash issues in API calls.
   *
   * @param value - New API endpoint URL
   */
  const updateApiEndpoint = (value: string) => {
    // Ensure the host doesn't end with a slash for consistent API calls
    const cleanHost = value.replace(/\/+$/, '');
    setApiHost(cleanHost);
  };

  /**
   * Updates the auto-refresh interval.
   *
   * @param value - New refresh interval in seconds
   */
  const updateRefreshInterval = (value: number) => {
    setRefreshInterval(value);
  };

  /**
   * Resets configuration to default values.
   *
   * Restores API endpoint to environment variable default and
   * refresh interval to 60 seconds.
   */
  const resetConfig = () => {
    const defaultEndpoint = process.env.NEXT_PUBLIC_API_URL;
    if (defaultEndpoint) {
      setApiHost(defaultEndpoint);
    }
    setRefreshInterval(60);
  };

  return {
    /**
     * Current configuration object with validated values
     */
    config: {
      apiEndpoint: apiHost || process.env.NEXT_PUBLIC_API_URL || '',
      refreshInterval:
        typeof refreshInterval === 'string' ? parseInt(refreshInterval, 10) : refreshInterval,
    } as Config,

    /**
     * Configuration update functions
     */
    updateApiEndpoint,
    updateRefreshInterval,
    resetConfig,

    /**
     * Direct access to storage values (for advanced use cases)
     */
    apiHost,
    setApiHost,
  };
}
