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
import { chains, getChainLabel, getChainIcon } from "@/app/config/chains"
import { calculateUptime, calculateFreshness, calculateReachability, calculateLatency } from "@/utils/metricsCalculations"
import { apiClient } from "@/lib/api-client"
import { useConfig } from "@/hooks/use-config"
import { PrometheusResponse, KPIData, KPICardProps } from "@/types/metrics"


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

  const generateMockData = useCallback((chainValue: string): KPIData => {
    const baseValues = chainValue === "all" ? {
      uptime: Math.random() * 3 + 97,
      freshness: Math.random() * 8 + 92,
      reachability: Math.random() * 6 + 94,
      latency: Math.random() * 200 + 100
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


  useEffect(() => {
    demoModeRef.current = demoMode
    
    if (!demoMode) {
      return
    }

    const generateRandomDemoData = (): KPIData => {
      const randomUptime = Math.random() * 8 + 92
      const randomFreshness = Math.random() * 22 + 78
      const randomReachability = Math.random() * 18 + 82
      const randomLatency = Math.random() * 550 + 50

      return {
        uptime: `${randomUptime.toFixed(1)}%`,
        freshness: `${randomFreshness.toFixed(1)}%`,
        reachability: `${randomReachability.toFixed(1)}%`,
        latency: `${Math.round(randomLatency)}ms`
      }
    }

    const cycleDemoData = async () => {
      if (!demoModeRef.current) {
        return
      }
      
      const newDemoData = generateRandomDemoData()
      setKpiData(newDemoData)
      
      await new Promise(resolve => setTimeout(resolve, 800 + Math.random() * 700))
      
      if (demoModeRef.current) {
        cycleDemoData()
      }
    }

    cycleDemoData()
  }, [demoMode])

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

      const [consumersData, providersData, freshnessData, latencyData] = await Promise.all([
        apiClient.get<PrometheusResponse>(`/api/metrics/last_minutes?query=${encodeURIComponent("lava_consumer_overall_health_breakdown")}&minutes=${timeWindowMinutes}&step=${stepSize}`),
        apiClient.get<PrometheusResponse>(`/api/metrics/last_minutes?query=${encodeURIComponent("lava_provider_overall_health_breakdown")}&minutes=${timeWindowMinutes}&step=${stepSize}`),
        apiClient.get<PrometheusResponse>(`/api/metrics/last_minutes?query=${encodeURIComponent("avg(lava_consumer_qos_metrics{qos_metric=\"sync/freshness\"})")}&minutes=${timeWindowMinutes}&step=${stepSize}`),
        apiClient.get<PrometheusResponse>(`/api/metrics/last_minutes?query=${encodeURIComponent(`avg_over_time(lava_consumer_average_latency_in_milliseconds[${timeRange}])`)}&minutes=${timeWindowMinutes}&step=${stepSize}`)
      ])

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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === 'D') {
        event.preventDefault()
        const newDemoMode = !demoMode
        setDemoMode(newDemoMode)
        
        if (!newDemoMode) {
          fetchKPIData(selectedChain, timeWindow)
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [demoMode, selectedChain, timeWindow, fetchKPIData])

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
    const metricsSection = document.querySelector('[data-section="in-depth-metrics"]')
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
