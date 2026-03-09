'use client';

/**
 * Configuration Management Hook
 *
 * This hook provides centralized configuration management for the dashboard application.
 * It handles API endpoint configuration, refresh intervals, and persistent storage
 * of user preferences using localStorage.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useLocalStorage } from '@/hooks/use-local-storage';
import { getRuntimeConfig } from '@/lib/runtime-config';
import { apiClient } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';

/**
 * Configuration object interface
 */
interface Config {
  apiEndpoint: string; // Backend API endpoint URL
  refreshInterval: number; // Auto-refresh interval in seconds
  prometheusUrl: string; // Direct Prometheus endpoint URL
  endpointDomain: string; // Domain for endpoint URL calculation
  endpointPort: string; // Port for endpoint URL calculation
}

/**
 * Backend settings response interface
 */
interface BackendSettings {
  prometheus_url: string;
  api_url: string;
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
  const { isAuthenticated } = useAuth();

  // Initialize with null - will be set from runtime config
  const [apiHost, setApiHost] = useLocalStorage<string | null>('api-host', null);
  const [defaultApiUrl, setDefaultApiUrl] = useState<string>('');

  // Prometheus URL - for direct Prometheus queries
  const [prometheusUrl, setPrometheusUrl] = useLocalStorage<string | null>('prometheus-url', null);
  const [defaultPrometheusUrl, setDefaultPrometheusUrl] = useState<string>('');

  // Endpoint domain and port - for calculating endpoint URLs
  const [endpointDomain, setEndpointDomain] = useLocalStorage<string | null>('endpoint-domain', null);
  const [defaultEndpointDomain, setDefaultEndpointDomain] = useState<string>('');
  const [endpointPort, setEndpointPort] = useLocalStorage<string | null>('endpoint-port', null);
  const [defaultEndpointPort, setDefaultEndpointPort] = useState<string>('');

  // Default refresh interval of 60 seconds
  const [refreshInterval, setRefreshInterval] = useLocalStorage<number>('refresh-interval', 60);

  // Loading state for backend settings
  const [isLoadingSettings, setIsLoadingSettings] = useState(false);

  /**
   * Fetch settings from the backend API.
   * This gets the current Prometheus URL from the backend.
   */
  const fetchBackendSettings = useCallback(async () => {
    try {
      setIsLoadingSettings(true);
      const settings = await apiClient.get<BackendSettings>('/api/settings/');
      return settings;
    } catch (error) {
      console.error('Failed to fetch backend settings:', error);
      return null;
    } finally {
      setIsLoadingSettings(false);
    }
  }, []);

  /**
   * Initialize default values from runtime config (no auth required).
   * Uses a ref to ensure it only runs once, even in React Strict Mode.
   */
  const initRef = React.useRef(false);

  useEffect(() => {
    // Prevent double initialization in React Strict Mode
    if (initRef.current) return;
    initRef.current = true;

    const initializeConfig = async () => {
      // Check localStorage directly to avoid race condition with useLocalStorage hook
      const hasStoredApiHost = typeof window !== 'undefined' && window.localStorage.getItem('api-host') !== null;
      const hasStoredPrometheusUrl = typeof window !== 'undefined' && window.localStorage.getItem('prometheus-url') !== null;
      const hasStoredDomain = typeof window !== 'undefined' && window.localStorage.getItem('endpoint-domain') !== null;
      const hasStoredPort = typeof window !== 'undefined' && window.localStorage.getItem('endpoint-port') !== null;

      // Get runtime config for default values
      const config = await getRuntimeConfig();
      const defaultEndpoint = config.NEXT_PUBLIC_API_URL;
      setDefaultApiUrl(defaultEndpoint);

      // Only set apiHost if it hasn't been stored yet (first load)
      if (!hasStoredApiHost && defaultEndpoint) {
        setApiHost(defaultEndpoint);
      }

      // Set default Prometheus URL from runtime config
      const defaultPromUrl = config.NEXT_PUBLIC_PROMETHEUS_URL;
      setDefaultPrometheusUrl(defaultPromUrl);
      if (!hasStoredPrometheusUrl && defaultPromUrl) {
        setPrometheusUrl(defaultPromUrl);
      }

      // Set default endpoint domain and port from runtime config
      const defaultDomain = config.NEXT_PUBLIC_DOMAIN;
      setDefaultEndpointDomain(defaultDomain);
      if (!hasStoredDomain && defaultDomain) {
        setEndpointDomain(defaultDomain);
      }

      const defaultPort = config.NEXT_PUBLIC_PORT;
      setDefaultEndpointPort(defaultPort);
      if (!hasStoredPort && defaultPort) {
        setEndpointPort(defaultPort);
      }
    };

    initializeConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Fetch settings from backend once the user is authenticated.
   * This overrides runtime config defaults with actual backend values.
   */
  const settingsFetchedRef = React.useRef(false);

  useEffect(() => {
    if (!isAuthenticated || settingsFetchedRef.current) return;
    settingsFetchedRef.current = true;

    const fetchSettings = async () => {
      const hasStoredPrometheusUrl = typeof window !== 'undefined' && window.localStorage.getItem('prometheus-url') !== null;

      try {
        const backendSettings = await fetchBackendSettings();
        if (backendSettings && backendSettings.prometheus_url) {
          // Use backend setting if user hasn't stored a custom value
          if (!hasStoredPrometheusUrl) {
            setPrometheusUrl(backendSettings.prometheus_url);
          }
        }
      } catch {
        // Backend fetch failed, keep runtime config defaults
      }
    };

    fetchSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

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
   * Updates the Prometheus URL with validation.
   * Also syncs the URL to the backend.
   *
   * Automatically removes trailing slashes to ensure consistent URL format.
   *
   * @param value - New Prometheus URL
   * @param syncToBackend - Whether to sync to backend (default: true)
   */
  const updatePrometheusUrl = async (value: string, syncToBackend: boolean = true) => {
    // Ensure the URL doesn't end with a slash for consistent API calls
    const cleanUrl = value.replace(/\/+$/, '');
    setPrometheusUrl(cleanUrl);

    // Sync to backend so the backend uses this URL for Prometheus queries
    if (syncToBackend) {
      try {
        await apiClient.put<BackendSettings>('/api/settings/', {
          prometheus_url: cleanUrl,
        });
      } catch (error) {
        console.error('Failed to sync Prometheus URL to backend:', error);
        // Don't throw - local storage update still succeeded
      }
    }
  };

  /**
   * Updates the endpoint domain.
   *
   * @param value - New domain
   */
  const updateEndpointDomain = (value: string) => {
    setEndpointDomain(value.trim());
  };

  /**
   * Updates the endpoint port.
   *
   * @param value - New port
   */
  const updateEndpointPort = (value: string) => {
    setEndpointPort(value.trim());
  };

  /**
   * Resets configuration to default values.
   *
   * Restores API endpoint, Prometheus URL, and endpoint settings to runtime config defaults,
   * and refresh interval to 60 seconds. Also resets backend settings.
   */
  const resetConfig = async () => {
    if (defaultApiUrl) {
      setApiHost(defaultApiUrl);
    }
    setPrometheusUrl(defaultPrometheusUrl);
    setEndpointDomain(defaultEndpointDomain);
    setEndpointPort(defaultEndpointPort);
    setRefreshInterval(60);

    // Reset backend settings
    try {
      await apiClient.post<BackendSettings>('/api/settings/reset');
    } catch (error) {
      console.error('Failed to reset backend settings:', error);
      // Don't throw - local storage reset still succeeded
    }
  };

  return {
    /**
     * Current configuration object with validated values
     */
    config: {
      apiEndpoint: apiHost || defaultApiUrl || '',
      refreshInterval:
        typeof refreshInterval === 'string' ? parseInt(refreshInterval, 10) : refreshInterval,
      prometheusUrl: prometheusUrl || defaultPrometheusUrl || '',
      endpointDomain: endpointDomain || defaultEndpointDomain || '',
      endpointPort: endpointPort || defaultEndpointPort || '',
    } as Config,

    /**
     * Configuration update functions
     */
    updateApiEndpoint,
    updateRefreshInterval,
    updatePrometheusUrl,
    updateEndpointDomain,
    updateEndpointPort,
    resetConfig,

    /**
     * Loading state
     */
    isLoadingSettings,

    /**
     * Refresh settings from backend
     */
    fetchBackendSettings,

    /**
     * Direct access to storage values (for advanced use cases)
     */
    apiHost,
    setApiHost,
  };
}
