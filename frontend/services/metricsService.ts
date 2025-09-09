import { apiClient } from "@/lib/api-client"
import { PrometheusResponse } from "@/utils/metricsCalculations"

/**
 * Service for fetching Prometheus metrics data
 */
export class MetricsService {
  /**
   * Fetches all required metrics for a specific time window
   */
  static async fetchMetricsForTimeWindow(
    timeWindowMinutes: number,
    stepSize: number
  ): Promise<{
    consumersData: PrometheusResponse
    providersData: PrometheusResponse
    freshnessData: PrometheusResponse
    latencyData: PrometheusResponse
    chainTrafficData: PrometheusResponse
    providerTrafficData: PrometheusResponse
  }> {
    const timeRange = `${timeWindowMinutes}m`
    
    const [consumersData, providersData, freshnessData, latencyData, chainTrafficData, providerTrafficData] = await Promise.all([
      apiClient.get<PrometheusResponse>(`/api/metrics/last_minutes?query=${encodeURIComponent("lava_consumer_overall_health_breakdown")}&minutes=${timeWindowMinutes}&step=${stepSize}`),
      apiClient.get<PrometheusResponse>(`/api/metrics/last_minutes?query=${encodeURIComponent("lava_provider_overall_health_breakdown")}&minutes=${timeWindowMinutes}&step=${stepSize}`),
      apiClient.get<PrometheusResponse>(`/api/metrics/last_minutes?query=${encodeURIComponent("lava_consumer_qos_metrics{qos_metric=\"sync/freshness\"}")}&minutes=${timeWindowMinutes}&step=${stepSize}`),
      apiClient.get<PrometheusResponse>(`/api/metrics/last_minutes?query=${encodeURIComponent(`avg_over_time(lava_consumer_average_latency_in_milliseconds[${timeRange}])`)}&minutes=${timeWindowMinutes}&step=${stepSize}`),
      apiClient.get<PrometheusResponse>(`/api/metrics/last_minutes?query=${encodeURIComponent("lava_consumer_total_relays_serviced")}&minutes=${timeWindowMinutes}&step=${stepSize}`),
      apiClient.get<PrometheusResponse>(`/api/metrics/last_minutes?query=${encodeURIComponent("lava_provider_total_relays_serviced")}&minutes=${timeWindowMinutes}&step=${stepSize}`)
    ])

    return {
      consumersData,
      providersData,
      freshnessData,
      latencyData,
      chainTrafficData,
      providerTrafficData
    }
  }

  /**
   * Fetches metrics for a specific chain
   */
  static async fetchMetricsForChain(
    chainValue: string,
    timeWindowMinutes: number,
    stepSize: number
  ): Promise<{
    uptime: string
    latency: string
    freshness: string
    reachability: string
    traffic: string
  }> {
    const { consumersData, providersData, freshnessData, latencyData, chainTrafficData } = 
      await this.fetchMetricsForTimeWindow(timeWindowMinutes, stepSize)

    const { 
      calculateUptime, 
      calculateLatency, 
      calculateFreshness, 
      calculateReachability,
      calculateChainTraffic
    } = await import("@/utils/metricsCalculations")

    return {
      uptime: calculateUptime(consumersData, chainValue),
      latency: calculateLatency(latencyData, chainValue),
      freshness: calculateFreshness(freshnessData),
      reachability: calculateReachability(consumersData, providersData, chainValue),
      traffic: calculateChainTraffic(chainTrafficData, chainValue)
    }
  }

  /**
   * Fetches metrics for all available chains
   */
  static async fetchMetricsForAllChains(
    chains: string[],
    timeWindowMinutes: number,
    stepSize: number
  ): Promise<Record<string, {
    uptime: string
    latency: string
    freshness: string
    reachability: string
    traffic: string
  }>> {
    const { consumersData, providersData, freshnessData, latencyData, chainTrafficData } = 
      await this.fetchMetricsForTimeWindow(timeWindowMinutes, stepSize)

    const { 
      calculateUptime, 
      calculateLatency, 
      calculateFreshness, 
      calculateReachability,
      calculateChainTraffic
    } = await import("@/utils/metricsCalculations")

    const results: Record<string, any> = {}

    chains.forEach(chainValue => {
      results[chainValue] = {
        uptime: calculateUptime(consumersData, chainValue),
        latency: calculateLatency(latencyData, chainValue),
        freshness: calculateFreshness(freshnessData),
        reachability: calculateReachability(consumersData, providersData, chainValue),
        traffic: calculateChainTraffic(chainTrafficData, chainValue)
      }
    })

    return results
  }

  /**
   * Fetches metrics for all available providers
   */
  static async fetchMetricsForAllProviders(
    providers: string[],
    timeWindowMinutes: number,
    stepSize: number
  ): Promise<Record<string, {
    uptime: string
    latency: string
    freshness: string
    traffic: string
  }>> {
    const { providersData, freshnessData, providerTrafficData } = 
      await this.fetchMetricsForTimeWindow(timeWindowMinutes, stepSize)

    const { 
      calculateProviderUptime, 
      calculateProviderFreshness,
      calculateProviderTraffic
    } = await import("@/utils/metricsCalculations")

    const results: Record<string, any> = {}

    providers.forEach(provider => {
      results[provider] = {
        uptime: calculateProviderUptime(providersData, provider),
        latency: "N/A",
        freshness: calculateProviderFreshness(freshnessData, provider),
        traffic: calculateProviderTraffic(providerTrafficData, provider)
      }
    })

    return results
  }
}
