/**
 * Shared types for metrics across the dashboard
 */

export interface ProviderMetrics {
  provider: string;
  chain?: string; // chain label for display
  chainValue?: string; // chain value for icon lookup
  latest_block: string; // latest block number
  traffic: string; // requests in time window
  uptime: string; // percentage
  latency: string; // single value
}

export interface ChainMetrics {
  chain: string;
  chainValue?: string; // chain value for icon lookup
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
  consumer_url: string;
  providers: ProviderInfo[];
}

/** Response from chains-to-providers endpoint */
export interface ChainsToProvidersResponse {
  chains: ChainInfo[];
}
