"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ChevronDown, Info, Globe, RefreshCw } from "lucide-react"
import Image from "next/image"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { chains } from "@/app/config/chains"
import { apiClient } from "@/lib/api-client"
import { useConfig } from "@/hooks/use-config"

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface PrometheusMetric {
  spec?: string
  provider?: string
  qos_metric?: string
  apiInterface?: string
  container?: string
  instance?: string
}

interface PrometheusResult {
  metric: PrometheusMetric
  values: [number, string][]
}

interface PrometheusResponse {
  status: string
  data: {
    result: PrometheusResult[]
  }
}

interface KPIData {
  uptime: string
  freshness: string
  reachability: string
  latency: string
}

interface KPICardProps {
  title: string
  value: string
  color: "green" | "orange" | "red"
  showInfo?: boolean
  tooltipText?: string
  isLoading?: boolean
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

const extractSpecsFromConsumerData = (data: unknown): string[] => {
  if (!data || typeof data !== 'object') {
    return []
  }
  
  const prometheusData = data as { status?: string; data?: { result?: unknown[] } }
  if (prometheusData?.status !== "success" || !prometheusData.data?.result) {
    return []
  }
  
  const results = prometheusData.data.result as Array<{
    metric?: { spec?: string }
  }>
  
  const specs = new Set<string>()
  results.forEach((result) => {
    const spec = result.metric?.spec
    if (spec) {
      specs.add(spec)
    }
  })
  
  return Array.from(specs)
}

const calculateUptime = (healthData: unknown, targetChain: string): string => {
  if (!healthData || typeof healthData !== 'object') {
    return "N/A"
  }
  
  const data = healthData as { status?: string; data?: { result?: unknown[] } }
  if (data?.status !== "success" || !data.data?.result) {
    return "N/A"
  }
  
  const results = data.data.result as Array<{
    metric?: { spec?: string }
    values?: [number, string][]
  }>
  
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

const calculateFreshness = (freshnessData: unknown): string => {
  if (!freshnessData || typeof freshnessData !== 'object') {
    return "N/A"
  }
  
  const data = freshnessData as { status?: string; data?: { result?: unknown[] } }
  if (data?.status !== "success" || !data.data?.result) {
    return "N/A"
  }
  
  const results = data.data.result as Array<{
    metric?: { spec?: string; qos_metric?: string }
    values?: [number, string][]
  }>
  
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

const calculateReachability = (consumersData: unknown, providersData: unknown, targetChain: string): string => {
  if (!consumersData || typeof consumersData !== 'object' ||
      !providersData || typeof providersData !== 'object') {
    return "N/A"
  }
  
  const consumersPrometheusData = consumersData as { status?: string; data?: { result?: unknown[] } }
  const providersPrometheusData = providersData as { status?: string; data?: { result?: unknown[] } }
  
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

const calculateLatency = (latencyData: unknown, targetChain: string): string => {
  if (!latencyData || typeof latencyData !== 'object') {
    return "N/A"
  }
  
  const data = latencyData as { status?: string; data?: { result?: unknown[] } }
  if (data?.status !== "success" || !data.data?.result) {
    return "N/A"
  }
  
  const results = data.data.result as Array<{
    metric?: { spec?: string }
    values?: [number, string][]
  }>
  
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

// ============================================================================
// COLOR UTILITY FUNCTIONS
// ============================================================================

const getUptimeColor = (value: string): "green" | "orange" | "red" => {
  if (value === "Error" || value === "N/A") return "red"
  const numericValue = parseFloat(value.replace('%', ''))
  if (isNaN(numericValue)) return "red"
  if (numericValue >= 99.5) return "green"
  if (numericValue >= 95) return "orange"
  return "red"
}

const getFreshnessColor = (value: string): "green" | "orange" | "red" => {
  if (value === "Error" || value === "N/A") return "red"
  const numericValue = parseFloat(value.replace('%', ''))
  if (isNaN(numericValue)) return "red"
  if (numericValue >= 95) return "green"
  if (numericValue >= 85) return "orange"
  return "red"
}

const getReachabilityColor = (value: string): "green" | "orange" | "red" => {
  if (value === "Error" || value === "N/A") return "red"
  const numericValue = parseFloat(value.replace('%', ''))
  if (isNaN(numericValue)) return "red"
  if (numericValue >= 95) return "green"
  if (numericValue >= 85) return "orange"
  return "red"
}

const getLatencyColor = (value: string): "green" | "orange" | "red" => {
  if (value === "Error" || value === "N/A") return "red"
  const numericValue = parseFloat(value.replace('ms', ''))
  if (isNaN(numericValue)) return "red"
  if (numericValue <= 200) return "green"
  if (numericValue <= 500) return "orange"
  return "red"
}

// ============================================================================
// KPI CARD COMPONENT
// ============================================================================

function KPICard({ title, value, color, showInfo = false, tooltipText, isLoading = false }: KPICardProps) {
  const colorClasses = {
    green: "text-green-500",
    orange: "text-orange-500", 
    red: "text-red-500"
  }

  return (
    <Card className="flex-1">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-muted-foreground">{title}</span>
            {showInfo && tooltipText && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3 w-3 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent>
                  <p>{tooltipText}</p>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
        <div className="mt-2">
          {isLoading ? (
            <div className="h-8 w-16 bg-muted animate-pulse rounded" />
          ) : (
            <span className={`text-2xl font-bold ${colorClasses[color]}`}>
              {value}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function SummarySection() {
  const { config } = useConfig()
  const [availableChains, setAvailableChains] = useState<string[]>([])
  const [selectedChain, setSelectedChain] = useState<string>("all")
  const [isLoadingChains, setIsLoadingChains] = useState(false)
  const [kpiData, setKpiData] = useState<KPIData>({
    uptime: "N/A",
    freshness: "N/A",
    reachability: "N/A",
    latency: "N/A"
  })
  const [isLoading, setIsLoading] = useState(false)
  const [timeWindow, setTimeWindow] = useState<number>(60)
  const [demoMode, setDemoMode] = useState<boolean>(false)
  const demoModeRef = useRef(demoMode)

  // Mock data generators
  const generateMockData = useCallback((chainValue: string): KPIData => {
    const baseValues = chainValue === "all" ? {
      uptime: Math.random() * 3 + 97, // 97-100%
      freshness: Math.random() * 8 + 92, // 92-100%
      reachability: Math.random() * 6 + 94, // 94-100%
      latency: Math.random() * 200 + 100 // 100-300ms
    } : {
      uptime: Math.random() * 5 + 95,
      freshness: Math.random() * 10 + 90,
      reachability: Math.random() * 8 + 92,
      latency: Math.random() * 300 + 50
    }

    return {
      uptime: `${baseValues.uptime.toFixed(1)}%`,
      freshness: `${baseValues.freshness.toFixed(1)}%`,
      reachability: `${baseValues.reachability.toFixed(1)}%`,
      latency: `${Math.round(baseValues.latency)}ms`
    }
  }, [])





  // Effect for demo mode - fast randomized cycling through all colors
  useEffect(() => {
    demoModeRef.current = demoMode
    
    if (!demoMode) {
      return
    }

    const generateRandomDemoData = (): KPIData => {
      // Generate random values that will trigger different colors
      const randomUptime = Math.random() * 8 + 92 // 92-100% (green, orange, red)
      const randomFreshness = Math.random() * 22 + 78 // 78-100% (green, orange, red)
      const randomReachability = Math.random() * 18 + 82 // 82-100% (green, orange, red)
      const randomLatency = Math.random() * 550 + 50 // 50-600ms (green, orange, red)

      return {
        uptime: `${randomUptime.toFixed(1)}%`,
        freshness: `${randomFreshness.toFixed(1)}%`,
        reachability: `${randomReachability.toFixed(1)}%`,
        latency: `${Math.round(randomLatency)}ms`
      }
    }

    const cycleDemoData = async () => {
      // Check if demo mode is still active using ref
      if (!demoModeRef.current) {
        return
      }
      
      const newDemoData = generateRandomDemoData()
      setKpiData(newDemoData)
      
      // Wait 800ms-1.5s before next cycle (much faster!)
      await new Promise(resolve => setTimeout(resolve, 800 + Math.random() * 700))
      
      // Continue cycling if still in demo mode
      if (demoModeRef.current) {
        cycleDemoData()
      }
    }

    cycleDemoData()
  }, [demoMode])

  // Unified data fetching function
  const fetchKPIData = useCallback(async (chainValue: string, timeWindowMinutes: number) => {
    setIsLoading(true)
    
    if (!config.apiEndpoint) {
      setKpiData({
        uptime: "Error",
        freshness: "Error",
        reachability: "Error",
        latency: "Error"
      })
      setIsLoading(false)
      return
    }

    if (!config.apiEndpoint) {
      setKpiData({
        uptime: "Error",
        freshness: "Error",
        reachability: "Error",
        latency: "Error"
      })
      setIsLoading(false)
      return
    }

    try {
      const stepSize = timeWindowMinutes <= 60 ? 1 : timeWindowMinutes <= 240 ? 5 : 15
      const timeRange = timeWindowMinutes <= 60 ? "1m" : timeWindowMinutes <= 240 ? "5m" : "15m"

      // Fetch all required metrics in parallel
      const [consumersData, providersData, freshnessData, latencyData] = await Promise.all([
        apiClient.get<PrometheusResponse>(`/api/metrics/last_minutes?query=${encodeURIComponent("lava_consumer_overall_health_breakdown")}&minutes=${timeWindowMinutes}&step=${stepSize}`),
        apiClient.get<PrometheusResponse>(`/api/metrics/last_minutes?query=${encodeURIComponent("lava_provider_overall_health_breakdown")}&minutes=${timeWindowMinutes}&step=${stepSize}`),
        apiClient.get<PrometheusResponse>(`/api/metrics/last_minutes?query=${encodeURIComponent("avg(lava_consumer_qos_metrics{qos_metric=\"sync/freshness\"})")}&minutes=${timeWindowMinutes}&step=${stepSize}`),
        apiClient.get<PrometheusResponse>(`/api/metrics/last_minutes?query=${encodeURIComponent(`avg_over_time(lava_consumer_average_latency_in_milliseconds[${timeRange}])`)}&minutes=${timeWindowMinutes}&step=${stepSize}`)
      ])

      // Calculate all KPIs
      const calculatedData: KPIData = {
        uptime: calculateUptime(consumersData, chainValue),
        freshness: calculateFreshness(freshnessData),
        reachability: calculateReachability(consumersData, providersData, chainValue),
        latency: calculateLatency(latencyData, chainValue)
      }

      setKpiData(calculatedData)
    } catch (error) {
      console.error("Error fetching KPI data:", error)
      setKpiData({
        uptime: "Error",
        freshness: "Error",
        reachability: "Error",
        latency: "Error"
      })
    } finally {
      setIsLoading(false)
    }
  }, [config.apiEndpoint, generateMockData])

  // Fetch available chains
  useEffect(() => {
    const fetchAvailableChains = async () => {
      if (!config.apiEndpoint) {
        return
      }

      setIsLoadingChains(true)
      try {
        const data: unknown = await apiClient.get(`/api/components/`)
        const configuredChains = Object.keys((data as { consumers?: Record<string, unknown> }).consumers || {})
        setAvailableChains(configuredChains)
      } catch (error) {
        console.error("Error fetching chains:", error)
        setAvailableChains(chains.map(chain => chain.value))
      } finally {
        setIsLoadingChains(false)
      }
    }

    fetchAvailableChains()
    fetchKPIData("all", timeWindow)
  }, [config.apiEndpoint, fetchKPIData, timeWindow])

  // Keyboard shortcut for demo mode
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Demo mode toggle: Ctrl+Shift+D
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === 'D') {
        event.preventDefault()
        const newDemoMode = !demoMode
        setDemoMode(newDemoMode)
        
        // If exiting demo mode, fetch real live data
        if (!newDemoMode) {
          fetchKPIData(selectedChain, timeWindow)
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [demoMode, selectedChain, timeWindow, fetchKPIData])

  // Helper functions
  const getChainLabel = (specValue: string) => {
    const chain = chains.find(c => c.value.toLowerCase() === specValue.toLowerCase())
    return chain ? chain.label : specValue
  }

  const getChainIcon = (specValue: string) => {
    const chain = chains.find(c => c.value.toLowerCase() === specValue.toLowerCase())
    return chain ? chain.icon : ''
  }

  // Event handlers
  const handleChainSelect = (chainValue: string) => {
    setSelectedChain(chainValue)
    fetchKPIData(chainValue, timeWindow)
  }

  const handleTimeWindowChange = (minutes: string) => {
    const newTimeWindow = parseInt(minutes, 10)
    setTimeWindow(newTimeWindow)
    fetchKPIData(selectedChain, newTimeWindow)
  }

  const handleRefresh = () => {
    fetchKPIData(selectedChain, timeWindow)
  }

  const handleScrollToMetrics = () => {
    const metricsSection = document.querySelector('[data-section="metrics"]')
    if (metricsSection) {
      metricsSection.scrollIntoView({ behavior: 'smooth' })
    }
  }

  return (
    <TooltipProvider>
      <Card className="mb-6">
        <CardContent className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Summary</h2>
          
          <div className="flex items-center gap-3">
            <Select
              value={selectedChain}
              onValueChange={handleChainSelect}
              disabled={isLoadingChains}
            >
              <SelectTrigger className="w-[280px]">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  {selectedChain !== "all" && (
                    <Image
                      src={getChainIcon(selectedChain)}
                      alt={getChainLabel(selectedChain)}
                      width={16}
                      height={16}
                      className="w-4 h-4 flex-shrink-0"
                    />
                  )}
                  <span className="truncate">
                    {selectedChain === "all" ? "All Chains" : getChainLabel(selectedChain)}
                  </span>
                </div>
              </SelectTrigger>
              <SelectContent className="max-h-[300px]">
                <SelectItem value="all">
                  <div className="flex items-center gap-2">
                    <Globe className="h-4 w-4" />
                    All Chains
                  </div>
                </SelectItem>
                {availableChains.map((chainValue) => (
                  <SelectItem key={chainValue} value={chainValue}>
                    <div className="flex items-center gap-2">
                      <Image
                        src={getChainIcon(chainValue)}
                        alt={getChainLabel(chainValue)}
                        width={16}
                        height={16}
                        className="w-4 h-4"
                      />
                      {getChainLabel(chainValue)}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={timeWindow.toString()}
              onValueChange={handleTimeWindowChange}
            >
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="5">5 minutes</SelectItem>
                <SelectItem value="15">15 minutes</SelectItem>
                <SelectItem value="30">30 minutes</SelectItem>
                <SelectItem value="60">1 hour</SelectItem>
                <SelectItem value="240">4 hours</SelectItem>
                <SelectItem value="1440">24 hours</SelectItem>
              </SelectContent>
            </Select>

            {demoMode && (
              <Button
                variant="default"
                size="sm"
                className="flex items-center gap-2 bg-gradient-to-r from-green-500 via-orange-500 to-red-500 text-white font-bold"
              >
                <span className="animate-pulse">⚡</span>
                Live Demo
              </Button>
            )}

            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={isLoading}
              className="p-2"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <KPICard 
              title="Uptime" 
              value={kpiData.uptime}
              color={getUptimeColor(kpiData.uptime)}
              isLoading={isLoading}
            />
            <KPICard 
              title="Reachability" 
              value={kpiData.reachability}
              color={getReachabilityColor(kpiData.reachability)}
              isLoading={isLoading}
              showInfo={true}
              tooltipText="Percentage of healthy providers available to each consumer. Unlike Uptime (consumer health), this measures provider availability. High uptime can be maintained even with lower reachability if available providers handle the load."
            />
            <KPICard
              title="Latency"
              value={kpiData.latency}
              color={getLatencyColor(kpiData.latency)}
              isLoading={isLoading}
            />
            <KPICard 
              title="Data Freshness" 
              value={kpiData.freshness}
              color={getFreshnessColor(kpiData.freshness)}
              isLoading={isLoading}
            />
          </div>
          
          <div className="flex justify-end">
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={handleScrollToMetrics}
              className="flex items-center gap-2"
            >
              <ChevronDown className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  )
}
