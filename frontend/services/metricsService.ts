/**
 * Metrics Service for Dashboard Application
 *
 * This service provides a centralized interface for fetching and formatting
 * metrics data from the backend APIs. It handles data transformation,
 * formatting, and type-safe API interactions for chains and providers metrics.
 */

import { apiClient } from '@/lib/api-client';

/**
 * Type definitions for API responses and metrics data
 */

/** Metrics data structure for individual chains */
export interface ChainMetrics {
  network?: string; // Network field for proper icon lookup
  uptime: number; // Uptime percentage (0-100)
  latency_in_ms: number; // Average latency in milliseconds
  reachability: number; // Provider reachability percentage (0-100)
  requests_in_window: number; // Number of requests in time window
  latest_block: number; // Latest block number
}

/** Metrics data structure for individual providers */
export interface ProviderMetrics {
  provider?: string; // Provider name/identifier
  network?: string; // Network field for proper icon lookup
  uptime: number; // Uptime percentage (0-100)
  latency_in_ms: number | null; // Average latency in milliseconds (null for providers)
  requests_in_window: number; // Number of requests in time window
  latest_block: number; // Latest block number
}

/** API response structure for chains metrics endpoint */
export interface ChainsResponse {
  chains: { [chainId: string]: ChainMetrics }; // Individual chain metrics
  avg: ChainMetrics; // Average metrics across all chains
  p90: ChainMetrics; // 90th percentile metrics across all chains
}

/** API response structure for providers metrics endpoint */
export interface ProvidersResponse {
  providers: { [providerId: string]: ProviderMetrics }; // Individual provider metrics as a dictionary
  avg: ProviderMetrics; // Average metrics across all providers
  p90: ProviderMetrics; // 90th percentile metrics across all providers
}

/**
 * Centralized service for metrics data operations.
 *
 * This class provides static methods for:
 * - Fetching metrics data from backend APIs
 * - Converting time frames to appropriate units
 * - Formatting metrics values for display
 * - Type-safe API interactions
 */
export class MetricsService {
  /**
   * Time frame conversion utilities
   */

  /**
   * Converts time frame string to minutes for API consumption.
   *
   * Supports the following formats:
   * - Minutes: "5m", "15m", "30m"
   * - Hours: "1h", "4h", "12h"
   * - Days: "1d", "7d", "30d"
   *
   * @param timeFrame - Time frame string (e.g., "5m", "1h", "2d")
   * @returns Number of minutes
   * @throws Error if format is invalid
   *
   * @example
   * ```typescript
   * MetricsService.convertTimeFrameToMinutes("5m")  // Returns 5
   * MetricsService.convertTimeFrameToMinutes("1h")  // Returns 60
   * MetricsService.convertTimeFrameToMinutes("2d")  // Returns 2880
   * ```
   */
  static convertTimeFrameToMinutes(timeFrame: string): number {
    const match = timeFrame.match(/^(\d+)([mhd])$/);
    if (!match) {
      throw new Error(
        `Invalid time frame format: ${timeFrame}. Expected format: number + unit (m/h/d)`,
      );
    }

    const value = parseInt(match[1], 10);
    const unit = match[2];

    switch (unit) {
      case 'm':
        return value; // Minutes
      case 'h':
        return value * 60; // Hours to minutes
      case 'd':
        return value * 24 * 60; // Days to minutes
      default:
        throw new Error(`Unsupported time unit: ${unit}. Use 'm', 'h', or 'd'`);
    }
  }

  /**
   * API interaction methods
   */

  /**
   * Fetches metrics for all chains with aggregated statistics.
   *
   * @param timeWindowMinutes - Time window in minutes for the query
   * @param stepSize - Step size for data aggregation (in minutes)
   * @returns Promise resolving to chains response with individual and aggregate data
   * @throws Error if API request fails
   */
  static async fetchMetricsForAllChains(
    timeWindowMinutes: number,
    stepSize: number,
    choosenNetwork?: string,
  ): Promise<ChainsResponse> {
    try {
      const networkQuery = choosenNetwork
        ? `&choosen_network=${encodeURIComponent(choosenNetwork)}`
        : '';
      const response = await apiClient.get(
        `/api/metrics/chains-metrics?time_window_minutes=${timeWindowMinutes}&step_size=${stepSize}${networkQuery}`,
      );
      return response as ChainsResponse;
    } catch (error) {
      throw new Error(
        `Failed to fetch chains metrics: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Fetches metrics for all providers with aggregated statistics.
   *
   * @param timeWindowMinutes - Time window in minutes for the query
   * @param stepSize - Step size for data aggregation (in minutes)
   * @returns Promise resolving to providers response with individual and aggregate data
   * @throws Error if API request fails
   */
  static async fetchMetricsForAllProviders(
    timeWindowMinutes: number,
    stepSize: number,
  ): Promise<ProvidersResponse> {
    try {
      const response = await apiClient.get(
        `/api/metrics/providers-metrics?time_window_minutes=${timeWindowMinutes}&step_size=${stepSize}`,
      );
      return response as ProvidersResponse;
    } catch (error) {
      throw new Error(
        `Failed to fetch providers metrics: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Fetches metrics for a specific chain.
   *
   * @param chainId - Identifier of the chain to fetch metrics for
   * @param timeWindowMinutes - Time window in minutes for the query
   * @param stepSize - Step size for data aggregation (in minutes)
   * @returns Promise resolving to chain-specific metrics
   * @throws Error if API request fails
   */
  static async fetchMetricsForChain(
    chainId: string,
    timeWindowMinutes: number,
    stepSize: number,
  ): Promise<ChainMetrics> {
    try {
      const response = await apiClient.get(
        `/api/metrics/chains-metrics/${chainId}?time_window_minutes=${timeWindowMinutes}&step_size=${stepSize}`,
      );
      return response as ChainMetrics;
    } catch (error) {
      throw new Error(
        `Failed to fetch metrics for chain ${chainId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Fetches metrics for a specific provider.
   *
   * @param providerId - Identifier of the provider to fetch metrics for
   * @param timeWindowMinutes - Time window in minutes for the query
   * @param stepSize - Step size for data aggregation (in minutes)
   * @returns Promise resolving to provider-specific metrics
   * @throws Error if API request fails
   */
  static async fetchMetricsForProvider(
    providerId: string,
    timeWindowMinutes: number,
    stepSize: number,
  ): Promise<ProviderMetrics> {
    try {
      const response = await apiClient.get(
        `/api/metrics/providers-metrics/${providerId}?time_window_minutes=${timeWindowMinutes}&step_size=${stepSize}`,
      );
      return response as ProviderMetrics;
    } catch (error) {
      throw new Error(
        `Failed to fetch metrics for provider ${providerId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Data formatting utilities
   */

  /**
   * Formats percentage value for display (generic formatter).
   *
   * @param percentage - Percentage as a number (0-100)
   * @returns Formatted percentage string
   *
   * @example
   * ```typescript
   * MetricsService.formatPercentage(99.5)  // Returns "99.5%"
   * MetricsService.formatPercentage(100.0) // Returns "100%"
   * MetricsService.formatPercentage(0)     // Returns "0%"
   * ```
   */
  static formatPercentage(percentage: number): string {
    // If it's a whole number, don't show decimal
    return percentage % 1 === 0 ? `${Math.round(percentage)}%` : `${percentage.toFixed(1)}%`;
  }

  /**
   * Formats latency value for display.
   *
   * @param latencyMs - Latency in milliseconds (null for providers without latency data)
   * @returns Formatted latency string with unit or "Coming Soon" if null
   *
   * @example
   * ```typescript
   * MetricsService.formatLatency(150)  // Returns "150ms"
   * MetricsService.formatLatency(null) // Returns "Coming Soon"
   * ```
   */
  static formatLatency(latencyMs: number | null): string {
    if (latencyMs === null) return 'Coming Soon';
    return `${Math.round(latencyMs)}ms`;
  }

  /**
   * Formats traffic/requests in time window for display.
   *
   * @param requestsInWindow - Number of requests in the time window
   * @returns Formatted traffic string with appropriate unit (no label)
   *
   * @example
   * ```typescript
   * MetricsService.formatTraffic(1500000)   // Returns "1.5M"
   * MetricsService.formatTraffic(500000)    // Returns "500K"
   * MetricsService.formatTraffic(1500)      // Returns "1500"
   * ```
   */
  static formatTraffic(requestsInWindow: number): string {
    if (requestsInWindow >= 1000000) {
      const millions = requestsInWindow / 1000000;
      return millions % 1 === 0 ? `${Math.round(millions)}M` : `${millions.toFixed(1)}M`;
    } else if (requestsInWindow >= 1000) {
      const thousands = requestsInWindow / 1000;
      return thousands % 1 === 0 ? `${Math.round(thousands)}K` : `${thousands.toFixed(1)}K`;
    } else {
      return `${requestsInWindow}`;
    }
  }

  /**
   * Format latest block number for display
   * @param blockNumber - Latest block number
   * @returns Block number as string
   */
  static formatLatestBlock(blockNumber: number): string {
    if (blockNumber === 0) return 'N/A';
    return blockNumber.toString();
  }

  /**
   * Legacy formatting methods for backward compatibility
   */

  /**
   * Formats chain metrics for display (legacy method).
   *
   * @deprecated Use individual format methods instead
   * @param metrics - Chain metrics object
   * @returns Formatted metrics object
   */
  static formatChainMetrics(metrics: ChainMetrics): {
    uptime: string;
    latency: string;
    traffic: string;
    latest_block: string;
  } {
    return {
      uptime: this.formatPercentage(metrics.uptime),
      latency: this.formatLatency(metrics.latency_in_ms),
      traffic: this.formatTraffic(metrics.requests_in_window),
      latest_block: this.formatLatestBlock(metrics.latest_block),
    };
  }

  /**
   * Formats provider metrics for display (legacy method).
   *
   * @deprecated Use individual format methods instead
   * @param metrics - Provider metrics object
   * @returns Formatted metrics object
   */
  static formatProviderMetrics(metrics: ProviderMetrics): {
    uptime: string;
    latency: string;
    traffic: string;
  } {
    return {
      uptime: this.formatPercentage(metrics.uptime),
      latency: this.formatLatency(metrics.latency_in_ms),
      traffic: this.formatTraffic(metrics.requests_in_window),
    };
  }

  /**
   * Fetches chains-to-providers mapping from the backend API.
   *
   * @param timeWindowMinutes - Time window in minutes for metrics calculation
   * @param stepSize - Step size in seconds for metrics calculation
   * @returns Promise resolving to chains-to-providers mapping
   */
  static async fetchChainsToProviders(
    timeWindowMinutes: number = 15,
    stepSize: number = 5,
  ): Promise<any> {
    const response = await apiClient.get(
      `/api/metrics/chains-to-providers?time_window_minutes=${timeWindowMinutes}&step_size=${stepSize}`,
    );
    return response;
  }
}
