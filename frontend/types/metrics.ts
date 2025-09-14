/**
 * Shared types for metrics across the dashboard
 */

export interface ProviderMetrics {
  provider: string;
  traffic: string; // req/day
  uptime: string; // percentage
  latency: string; // single value
  sync: string; // percentage
}

export interface ChainMetrics {
  chain: string;
  traffic: string; // req/day
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
}

export interface KPICardProps {
  title: string;
  value: string;
  color: 'green' | 'orange' | 'red';
  tooltip?: string;
  showInfo?: boolean;
  tooltipText?: string;
  isLoading?: boolean;
}

// API Response Types for Metrics Endpoints

/** Provider information for flow visualization */
export interface ProviderInfo {
  name: string;
  interface: string;
  endpoint: string;
  health_status: boolean;
}

/** Chain information for flow visualization */
export interface ChainInfo {
  chain_id: string;
  consumer_health: boolean;
  providers: ProviderInfo[];
}

/** Response from chains-to-providers endpoint */
export interface ChainsToProvidersResponse {
  chains: ChainInfo[];
}
