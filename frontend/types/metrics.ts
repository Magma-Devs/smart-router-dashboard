/**
 * Shared types for metrics across the dashboard
 */

// Health state enums

export enum ProviderHealth {
  HEALTHY = 'healthy',
  UNHEALTHY = 'unhealthy',
}

export enum ChainHealth {
  HEALTHY = 'healthy',
  UNHEALTHY = 'unhealthy',
  MIXED = 'mixed',
}

export interface ProviderMetrics {
  provider: string;
  chain?: string; // chain label for display
  chainValue?: string; // chain value for icon lookup
  network?: string; // network field for proper icon lookup
  latest_block: string; // latest block number
  traffic: string; // requests in time window
  uptime: string; // percentage
  latency: string; // single value
}

export interface ChainMetrics {
  chain: string;
  chainValue?: string; // chain value for icon lookup
  network?: string; // network field for proper icon lookup
  latest_block: string; // latest block number
  traffic: string; // requests in time window
  uptime: string; // percentage
  latency: string; // single value
}

export interface MetricsData {
  providers: ProviderMetrics[];
  chains: ChainMetrics[];
  selectedChain: string;
  selectedProvider: string;
  timeFrame: string;
}

export type SortField = 'name';
export type SortDirection = 'asc' | 'desc';

export interface KPIData {
  uptime: string;
  reachability: string;
  latency: string;
  totalRequests?: string;
  cacheHitRate?: string;
  recoveredNodeErrors?: { recovered: string; total: string } | string;  // Format: { recovered, total } or "Error"/"N/A"
}

export interface KPICardProps {
  title: string;
  value: string;
  color: 'green' | 'orange' | 'red' | 'grey';
  tooltip?: string;
  showInfo?: boolean;
  tooltipText?: string;
  isLoading?: boolean;
}

// API Response Types for Metrics Endpoints

/** Endpoint information */
export interface EndpointInfo {
  url: string;
  interface: string;
  addons?: string[];
}

/** Provider information for flow visualization */
export interface ProviderInfo {
  name: string;
  endpoints: EndpointInfo[];
  auth_config?: any;
  health_status: ProviderHealth;
}

/** Chain information for flow visualization */
export interface ChainInfo {
  id: string;
  network: string;
  providers: ProviderInfo[];
  health_status: ChainHealth;
}

/** Response from chains-to-providers endpoint */
export interface ChainsToProvidersResponse {
  chains: ChainInfo[];
}
