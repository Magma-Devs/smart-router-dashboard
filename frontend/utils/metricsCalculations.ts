/**
 * Shared utility functions for calculating metrics from Prometheus data
 * These functions are used by both summary-section and in-depth-metrics
 */

export interface PrometheusResult {
  metric?: { 
    spec?: string
    provider?: string
    service?: string
    qos_metric?: string
  }
  values?: [number, string][]
}

export interface PrometheusResponse {
  status?: string
  data?: { 
    result?: PrometheusResult[]
  }
}

/**
 * Calculates uptime percentage for a specific chain from health data
 */
export const calculateUptime = (healthData: unknown, targetChain: string): string => {
  if (!healthData || typeof healthData !== 'object') {
    return "N/A"
  }
  
  const data = healthData as PrometheusResponse
  if (data?.status !== "success" || !data.data?.result) {
    return "N/A"
  }
  
  const results = data.data.result
  
  if (results.length === 0) {
    return "N/A"
  }
  
  let totalHealthyTime = 0
  let totalTime = 0
  
  results.forEach((result) => {
    const spec = result.metric?.spec
    
    // For "all chains", process all results
    if (targetChain === "all") {
      // Process all results without spec filtering
    } else {
      // For specific chains, we need a spec field
      if (!spec) {
        return
      }
      
      // Filter by target chain
      if (spec.toLowerCase() !== targetChain.toLowerCase()) {
        return
      }
    }
    
    const values = result.values || []
    values.forEach(([timestamp, value]) => {
      const isConsumerHealthy = value === "1"
      totalTime++
      if (isConsumerHealthy) {
        totalHealthyTime++
      }
    })
  })
  
  const uptimePercentage = totalTime > 0 ? (totalHealthyTime / totalTime) * 100 : 0
  
  // Format as float unless it's a whole number
  return uptimePercentage % 1 === 0 
    ? `${Math.round(uptimePercentage)}%` 
    : `${uptimePercentage.toFixed(1)}%`
}

/**
 * Calculates data freshness percentage from freshness data
 */
export const calculateFreshness = (freshnessData: unknown): string => {
  if (!freshnessData || typeof freshnessData !== 'object') {
    return "N/A"
  }
  
  const data = freshnessData as PrometheusResponse
  if (data?.status !== "success" || !data.data?.result) {
    return "N/A"
  }
  
  const results = data.data.result
  
  if (results.length === 0) {
    return "N/A"
  }
  
  let totalFreshness = 0
  let totalSamples = 0
  
  results.forEach((result) => {
    const values = result.values || []
    values.forEach(([timestamp, value]) => {
      const freshnessValue = parseFloat(value)
      if (!isNaN(freshnessValue)) {
        totalFreshness += freshnessValue
        totalSamples++
      }
    })
  })
  
  const averageFreshness = totalSamples > 0 ? (totalFreshness / totalSamples) * 100 : 0
  
  // Format as float unless it's a whole number
  return averageFreshness % 1 === 0 
    ? `${Math.round(averageFreshness)}%` 
    : `${averageFreshness.toFixed(1)}%`
}

/**
 * Calculates average latency in milliseconds for a specific chain
 */
export const calculateLatency = (latencyData: unknown, targetChain: string): string => {
  if (!latencyData || typeof latencyData !== 'object') {
    return "N/A"
  }
  
  const data = latencyData as PrometheusResponse
  if (data?.status !== "success" || !data.data?.result) {
    return "N/A"
  }
  
  const results = data.data.result
  
  if (results.length === 0) return "N/A"
  
  let totalLatency = 0
  let totalSamples = 0
  
  results.forEach((result) => {
    const spec = result.metric?.spec
    if (!spec) return
    
    // Filter by target chain if not "all"
    if (targetChain !== "all" && spec.toLowerCase() !== targetChain.toLowerCase()) {
      return
    }
    
    const values = result.values || []
    values.forEach(([timestamp, value]) => {
      const latencyMs = parseFloat(value)
      if (!isNaN(latencyMs)) {
        totalLatency += latencyMs
        totalSamples++
      }
    })
  })
  
  const averageLatency = totalSamples > 0 ? totalLatency / totalSamples : 0
  
  return averageLatency > 0 ? `${Math.round(averageLatency)}ms` : "N/A"
}

/**
 * Extracts specs from consumer data
 */
const extractSpecsFromConsumerData = (consumersData: unknown): string[] => {
  if (!consumersData || typeof consumersData !== 'object') {
    return []
  }
  
  const data = consumersData as PrometheusResponse
  if (data?.status !== "success" || !data.data?.result) {
    return []
  }
  
  const specs = new Set<string>()
  data.data.result.forEach((result) => {
    const spec = result.metric?.spec
    if (spec) {
      specs.add(spec)
    }
  })
  
  return Array.from(specs)
}

/**
 * Calculates reachability percentage for a specific chain
 */
export const calculateReachability = (consumersData: unknown, providersData: unknown, targetChain: string): string => {
  if (!consumersData || typeof consumersData !== 'object' ||
      !providersData || typeof providersData !== 'object') {
    return "N/A"
  }
  
  const consumersPrometheusData = consumersData as PrometheusResponse
  const providersPrometheusData = providersData as PrometheusResponse
  
  if (consumersPrometheusData?.status !== "success" || !consumersPrometheusData.data?.result ||
      providersPrometheusData?.status !== "success" || !providersPrometheusData.data?.result) {
    return "N/A"
  }
  
  // Get all specs from consumer data
  const specs = extractSpecsFromConsumerData(consumersData)
  const filteredSpecs = targetChain === "all" 
    ? specs 
    : specs.filter(spec => spec.toLowerCase() === targetChain.toLowerCase())
  
  if (filteredSpecs.length === 0) {
    return "N/A"
  }
  
  const results = providersPrometheusData.data.result as Array<{
    metric?: { provider?: string; spec?: string }
    values?: [number, string][]
  }>
  
  // Calculate reachability for each consumer
  const consumerReachabilities: number[] = []
  
  filteredSpecs.forEach((spec) => {
    // Count providers for this consumer
    const consumerProviders = results.filter(result => result.metric?.spec === spec)
    
    if (consumerProviders.length === 0) {
      consumerReachabilities.push(0)
      return
    }
    
    // Count healthy providers
    let healthyProviders = 0
    consumerProviders.forEach((providerResult) => {
      const values = providerResult.values || []
      if (values.length > 0) {
        const latestValue = values[values.length - 1]
        const healthValue = parseFloat(latestValue[1])
        if (healthValue === 1) {
          healthyProviders++
        }
      }
    })
    
    const reachabilityScore = (healthyProviders / consumerProviders.length) * 100
    consumerReachabilities.push(reachabilityScore)
  })
  
  if (consumerReachabilities.length === 0) {
    return "N/A"
  }
  
  // Average all consumer reachability scores
  const averageReachability = consumerReachabilities.reduce((sum, reachability) => sum + reachability, 0) / consumerReachabilities.length
  
  // Format as float unless it's a whole number
  return averageReachability % 1 === 0 
    ? `${Math.round(averageReachability)}%` 
    : `${averageReachability.toFixed(1)}%`
}

/**
 * Calculates uptime percentage for a specific provider from provider health data
 */
export const calculateProviderUptime = (providerHealthData: unknown, targetProvider: string): string => {
  if (!providerHealthData || typeof providerHealthData !== 'object') {
    console.log(`Provider uptime: No health data for ${targetProvider}`)
    return "N/A"
  }
  
  const data = providerHealthData as PrometheusResponse
  if (data?.status !== "success" || !data.data?.result) {
    console.log(`Provider uptime: Invalid data status for ${targetProvider}`, data?.status)
    return "N/A"
  }
  
  const results = data.data.result
  
  if (results.length === 0) {
    console.log(`Provider uptime: No results for ${targetProvider}`)
    return "N/A"
  }
  
  // Debug logging removed - provider uptime calculation working
  
  let totalHealthyTime = 0
  let totalTime = 0
  
  results.forEach((result) => {
    const service = result.metric?.service
    
    // Filter by target provider using service field (handle -provider suffix)
    if (!service) {
      return
    }
    
    // Check if service matches targetProvider or targetProvider-provider
    const serviceMatches = service.toLowerCase() === targetProvider.toLowerCase() || 
                          service.toLowerCase() === `${targetProvider.toLowerCase()}-provider`
    
    if (!serviceMatches) {
      return
    }
    
    // Found matching service for uptime calculation
    
    const values = result.values || []
    values.forEach(([timestamp, value]) => {
      const healthValue = parseFloat(value)
      // lava_provider_overall_health_breakdown is 0-1, so multiply by 100 for percentage
      const uptimePercentage = healthValue * 100
      totalTime++
      totalHealthyTime += uptimePercentage
    })
  })
  
  if (totalTime === 0) {
    console.log(`Provider uptime: No matching data for ${targetProvider}`)
    return "N/A"
  }
  
  const averageUptime = totalHealthyTime / totalTime
  
  // Calculated uptime percentage
  
  // Format as integer as specified
  return `${Math.round(averageUptime)}%`
}

/**
 * Calculates freshness percentage for a specific provider from QoS metrics
 */
export const calculateProviderFreshness = (freshnessData: unknown, targetProvider: string): string => {
  if (!freshnessData || typeof freshnessData !== 'object') {
    console.log(`Provider freshness: No freshness data for ${targetProvider}`)
    return "N/A"
  }
  
  const data = freshnessData as PrometheusResponse
  if (data?.status !== "success" || !data.data?.result) {
    console.log(`Provider freshness: Invalid data status for ${targetProvider}`, data?.status)
    return "N/A"
  }
  
  const results = data.data.result
  
  if (results.length === 0) {
    console.log(`Provider freshness: No results for ${targetProvider}`)
    return "N/A"
  }
  
  // Debug logging removed - provider freshness calculation working
  
  let totalFreshness = 0
  let totalSamples = 0
  
  results.forEach((result) => {
    const service = result.metric?.service
    const qosMetric = result.metric?.qos_metric
    const spec = result.metric?.spec
    
    // Filter by sync/freshness metric first
    if (!qosMetric || qosMetric !== "sync/freshness") {
      return
    }
    
    // For freshness, we need to match by chain/spec rather than provider
    // Extract chain from targetProvider (e.g., "cosmoshub-lava" -> "cosmoshub")
    const targetChain = targetProvider.split('-')[0]
    
    // Check if service matches the chain (e.g., "cosmoshub-consumer" matches "cosmoshub")
    const serviceMatches = service && service.toLowerCase().startsWith(targetChain.toLowerCase())
    
    if (!serviceMatches) {
      return
    }
    
    // Found matching service for freshness calculation
    
    const values = result.values || []
    values.forEach(([timestamp, value]) => {
      const freshnessValue = parseFloat(value)
      if (!isNaN(freshnessValue)) {
        totalFreshness += freshnessValue
        totalSamples++
      }
    })
  })
  
  if (totalSamples === 0) {
    console.log(`Provider freshness: No matching data for ${targetProvider}`)
    return "N/A"
  }
  
  const averageFreshness = (totalFreshness / totalSamples) * 100
  
  // Calculated freshness percentage
  
  // Format as float unless it's a whole number
  return averageFreshness % 1 === 0 
    ? `${Math.round(averageFreshness)}%` 
    : `${averageFreshness.toFixed(1)}%`
}

/**
 * Formats traffic numbers with appropriate scaling (1, 10, 100, 1K, 10K, 100K, 1M, 10M, 100M, etc.)
 */
export const formatTraffic = (totalRelays: number): string => {
  if (totalRelays === 0) return "0 req/day"
  
  const absRelays = Math.abs(totalRelays)
  
  if (absRelays < 1000) {
    return `${Math.round(totalRelays)} req/day`
  } else if (absRelays < 1000000) {
    const thousands = totalRelays / 1000
    return thousands % 1 === 0 
      ? `${Math.round(thousands)}K req/day`
      : `${thousands.toFixed(1)}K req/day`
  } else {
    const millions = totalRelays / 1000000
    return millions % 1 === 0 
      ? `${Math.round(millions)}M req/day`
      : `${millions.toFixed(1)}M req/day`
  }
}

/**
 * Calculates traffic (total relays) for a specific chain
 */
export const calculateChainTraffic = (trafficData: unknown, targetChain: string): string => {
  if (!trafficData || typeof trafficData !== 'object') {
    return "N/A"
  }
  
  const data = trafficData as PrometheusResponse
  if (data?.status !== "success" || !data.data?.result) {
    return "N/A"
  }
  
  const results = data.data.result
  
  if (results.length === 0) {
    return "N/A"
  }
  
  let totalRelays = 0
  
  results.forEach((result) => {
    const spec = result.metric?.spec
    
    // Filter by target chain
    if (!spec || spec.toLowerCase() !== targetChain.toLowerCase()) {
      return
    }
    
    const values = result.values || []
    if (values.length > 0) {
      // Get the latest value (most recent)
      const latestValue = values[values.length - 1]
      const relaysValue = parseFloat(latestValue[1])
      if (!isNaN(relaysValue)) {
        totalRelays += relaysValue
      }
    }
  })
  
  return formatTraffic(totalRelays)
}

/**
 * Calculates traffic (total relays) for a specific provider
 */
export const calculateProviderTraffic = (trafficData: unknown, targetProvider: string): string => {
  if (!trafficData || typeof trafficData !== 'object') {
    return "N/A"
  }
  
  const data = trafficData as PrometheusResponse
  if (data?.status !== "success" || !data.data?.result) {
    return "N/A"
  }
  
  const results = data.data.result
  
  if (results.length === 0) {
    return "N/A"
  }
  
  let totalRelays = 0
  
  results.forEach((result) => {
    const service = result.metric?.service
    
    // Filter by target provider (handle -provider suffix)
    if (!service) {
      return
    }
    
    // Check if service matches targetProvider or targetProvider-provider
    const serviceMatches = service.toLowerCase() === targetProvider.toLowerCase() || 
                          service.toLowerCase() === `${targetProvider.toLowerCase()}-provider`
    
    if (!serviceMatches) {
      return
    }
    
    const values = result.values || []
    if (values.length > 0) {
      // Get the latest value (most recent)
      const latestValue = values[values.length - 1]
      const relaysValue = parseFloat(latestValue[1])
      if (!isNaN(relaysValue)) {
        totalRelays += relaysValue
      }
    }
  })
  
  return formatTraffic(totalRelays)
}
