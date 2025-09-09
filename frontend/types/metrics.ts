/**
 * Shared types for metrics across the dashboard
 */

export interface ProviderMetrics {
  provider: string
  traffic: string // req/day
  uptime: string // percentage
  latency: string // single value
  sync: string // percentage
}

export interface ChainMetrics {
  chain: string
  traffic: string // req/day
  uptime: string // percentage
  latency: string // single value
  freshness: string // percentage
}

export interface MetricsData {
  providers: ProviderMetrics[]
  chains: ChainMetrics[]
  selectedChain: string
  selectedProvider: string
  timeFrame: string
}

export type SortField = 'name' | 'traffic' | 'uptime' | 'latency' | 'dataFreshness'
export type SortDirection = 'asc' | 'desc'

// Prometheus API response types
export interface PrometheusMetric {
  spec?: string
  provider?: string
  qos_metric?: string
  apiInterface?: string
  container?: string
  instance?: string
}

export interface PrometheusResult {
  metric: PrometheusMetric
  values: [number, string][]
}

export interface PrometheusResponse {
  status: string
  data: {
    result: PrometheusResult[]
  }
}

export interface KPIData {
  uptime: string
  freshness: string
  reachability: string
  latency: string
}

export interface KPICardProps {
  title: string
  value: string
  color: "green" | "orange" | "red"
  showInfo?: boolean
  tooltipText?: string
  isLoading?: boolean
}
