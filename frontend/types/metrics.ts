/**
 * Shared types for metrics across the dashboard
 */

// Health state enums

export enum NodeHealth {
  HEALTHY = 'healthy',
  UNHEALTHY = 'unhealthy',
}

export enum RouterHealth {
  HEALTHY = 'healthy',
  UNHEALTHY = 'unhealthy',
  MIXED = 'mixed',
}

export interface NodeMetrics {
  provider: string;
  chain?: string; // chain label for display
  chainValue?: string; // chain value for icon lookup
  network?: string; // network field for proper icon lookup
  latest_block: string; // latest block number
  traffic: string; // requests in time window
  uptime: string; // percentage
  latency: string; // single value
}

export interface RouterMetrics {
  chain: string;
  chainValue?: string; // chain value for icon lookup
  network?: string; // network field for proper icon lookup
  latest_block: string; // latest block number
  traffic: string; // requests in time window
  uptime: string; // percentage
  latency: string; // single value
}

export interface MetricsData {
  providers: NodeMetrics[];
  chains: RouterMetrics[];
  selectedRouter: string;
  selectedNode: string;
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
  recoveredNodeErrors?: { recovered: string; total: string } | string; // Format: { recovered, total } or "Error"/"N/A"
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

// ---------------------------------------------------------------------------
// API Response Types for Metrics Endpoints
// ---------------------------------------------------------------------------

/** Endpoint information (safe — URL is not exposed) */
export interface EndpointInfo {
  interface: string;
}

/** Node information for flow visualization */
export interface NodeInfo {
  name: string;
  endpoints: EndpointInfo[];
  health_status: NodeHealth;
  is_backup?: boolean;
}

/** Router information for flow visualization */
export interface RouterInfo {
  id: string;
  network: string;
  nodes: NodeInfo[];
  health_status: RouterHealth;
}

/** Response from routers-to-nodes endpoint */
export interface RoutersToNodesResponse {
  chains: RouterInfo[];
}

// ---------------------------------------------------------------------------
// Backward-compatible type aliases
// ---------------------------------------------------------------------------

/** @deprecated Use NodeMetrics */
export type ProviderMetrics = NodeMetrics;

/** @deprecated Use RouterMetrics */
export type ChainMetrics = RouterMetrics;

/** @deprecated Use NodeInfo */
export type ProviderInfo = NodeInfo;

/** @deprecated Use RouterInfo */
export type ChainInfo = RouterInfo;

/** @deprecated Use RoutersToNodesResponse */
export type ChainsToProvidersResponse = RoutersToNodesResponse;
