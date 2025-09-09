"use client"

import { useState, useEffect, useCallback } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { RefreshCw, AlertTriangle } from "lucide-react"
import { getChainLabel } from "@/app/config/chains"
import { apiClient } from "@/lib/api-client"
import { useConfig } from "@/hooks/use-config"
import { MetricsData } from "@/types/metrics"
import { MetricsTable } from "@/components/MetricsTable"
import { TabNavigation } from "@/components/TabNavigation"
import { useSorting } from "@/hooks/useSorting"
import { useMockData } from "@/hooks/useMockData"
import { useDataFetching } from "@/hooks/useDataFetching"
import { TIME_FRAMES, DEFAULT_TIME_FRAME } from "@/constants/timeFrames"
import { MetricsService } from "@/services/metricsService"

interface ComponentsApiResponse {
  consumers: {
    [chainName: string]: {
      interfaces: Array<{
        name: string
        port: number
        addons: string[]
        providers: Array<{
          name: string
          url: string
          addons: string[]
          nodes: Array<{
            endpoint: string
            type: string
            addons: string[]
          }>
        }>
      }>
    }
  }
  resource_limits: {
    server: { cpu: number; memory: number }
    per_consumer: { cpu: number; memory: number }
    per_provider: { cpu: number; memory: number }
  }
}


export function InDepthMetrics() {
  const { config } = useConfig()
  const [activeTab, setActiveTab] = useState<"chains" | "providers">("chains")
  const [selectedTimeFrame, setSelectedTimeFrame] = useState(DEFAULT_TIME_FRAME)
  const [availableChains, setAvailableChains] = useState<string[]>([])
  const [availableProviders, setAvailableProviders] = useState<string[]>([])
  const [isLoadingComponents, setIsLoadingComponents] = useState(false)

  // Custom hooks
  const { sortField, sortDirection, handleSort, sortData } = useSorting()
  const { generateMockData, refreshMockData } = useMockData({ 
    availableChains, 
    availableProviders
  })
  const { data, loading, error, fetchData } = useDataFetching<MetricsData>()

  // Fetch components (chains and providers) from API
  const fetchComponents = async () => {
    setIsLoadingComponents(true)
    try {
      const response = await apiClient.get("/api/components/")
      
      // The response might be the data directly, or wrapped in a data property
      const data = (response as any).data || response
      
      if (!data) {
        throw new Error("No data received from API")
      }
      
      if (!data.consumers) {
        throw new Error("No consumers found in API response")
      }
      
      // Extract chains from consumers
      const chains = Object.keys(data.consumers)
      setAvailableChains(chains)
      
      // Extract providers - they are nested inside each consumer's interfaces
      const allProviders = new Set<string>()
      Object.values(data.consumers).forEach((consumer: any) => {
        if (consumer.interfaces) {
          consumer.interfaces.forEach((interfaceItem: any) => {
            if (interfaceItem.providers) {
              interfaceItem.providers.forEach((provider: any) => {
                allProviders.add(provider.name)
              })
            }
          })
        }
      })
      setAvailableProviders(Array.from(allProviders))
      
    } catch (error) {
      console.error("Error fetching components:", error)
      // Fallback to default chains if API fails
      setAvailableChains(["Bitcoin", "Ethereum", "Solana", "Hyperliquid", "Arbitrum", "Polygon"])
      setAvailableProviders(["In-house", "Alchemy", "Quicknode", "Lava", "Infura", "Ankr"])
    } finally {
      setIsLoadingComponents(false)
    }
  }

  const handleFetchData = useCallback(async () => {
    console.log("handleFetchData called with chains:", availableChains, "providers:", availableProviders)
    await fetchData(async () => {
      try {
        // Convert time frame to minutes
        const timeFrameMinutes = parseInt(selectedTimeFrame.replace(/[^\d]/g, ''), 10)
        const stepSize = Math.max(1, Math.floor(timeFrameMinutes / 60)) // 1 minute steps for up to 1 hour, then scale up
        
        // Fetch real metrics for all chains and providers
        const [chainMetrics, providerMetrics] = await Promise.all([
          MetricsService.fetchMetricsForAllChains(
            availableChains,
            timeFrameMinutes,
            stepSize
          ),
          MetricsService.fetchMetricsForAllProviders(
            availableProviders,
            timeFrameMinutes,
            stepSize
          )
        ])
        
        
        const realData: MetricsData = {
          chains: availableChains.map(chainValue => ({
            chain: getChainLabel(chainValue),
            traffic: chainMetrics[chainValue]?.traffic || "N/A",
            uptime: chainMetrics[chainValue]?.uptime || "N/A",
            latency: chainMetrics[chainValue]?.latency || "N/A",
            freshness: chainMetrics[chainValue]?.freshness || "N/A"
          })),
          providers: availableProviders.map(provider => ({
            provider,
            traffic: providerMetrics[provider]?.traffic || "N/A",
            uptime: providerMetrics[provider]?.uptime || "N/A",
            latency: providerMetrics[provider]?.latency || "N/A",
            sync: providerMetrics[provider]?.freshness || "N/A"
          })),
          selectedChain: "All Chains",
          selectedProvider: "All Providers",
          timeFrame: selectedTimeFrame
        }
        
        return realData
      } catch (error) {
        console.error("Error fetching real metrics, falling back to mock data:", error)
        refreshMockData()
        const mockData = generateMockData
        return mockData
      }
    })
  }, [availableChains, availableProviders, selectedTimeFrame, fetchData, refreshMockData, generateMockData])

  useEffect(() => {
    fetchComponents()
  }, [])

  useEffect(() => {
    if (availableChains.length > 0 && availableProviders.length > 0) {
      handleFetchData()
    }
  }, [availableChains, availableProviders, selectedTimeFrame])

  const handleRefresh = () => {
    fetchComponents()
    handleFetchData()
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>In-Depth Metrics</CardTitle>
          <CardDescription>
            Detailed performance metrics by chain and provider
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <AlertTriangle className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">Error loading metrics</h3>
            <p className="text-muted-foreground mb-4">{error}</p>
            <Button onClick={handleRefresh} variant="outline">
              <RefreshCw className="mr-2 h-4 w-4" />
              Try Again
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (isLoadingComponents) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>In-Depth Metrics</CardTitle>
          <CardDescription>
            Detailed performance metrics by chain and provider
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            <span className="ml-2">Loading components...</span>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card data-section="in-depth-metrics">
      <CardHeader>
        <CardTitle>In-Depth Metrics</CardTitle>
        <CardDescription>
          Detailed performance metrics by chain and provider
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between mb-6">
          <TabNavigation 
            activeTab={activeTab} 
            onTabChange={setActiveTab} 
          />

          <div className="flex items-center gap-4">
            <Select value={selectedTimeFrame} onValueChange={setSelectedTimeFrame}>
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIME_FRAMES.map((tf) => (
                  <SelectItem key={tf.value} value={tf.value}>
                    {tf.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button 
              onClick={handleRefresh} 
              disabled={loading}
              variant="outline"
              size="sm"
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        {data ? (
          <MetricsTable
            data={activeTab === "providers" ? sortData(data.providers) : sortData(data.chains)}
            type={activeTab}
            sortField={sortField}
            sortDirection={sortDirection}
            onSort={handleSort}
            loading={loading}
          />
        ) : (
          <div className="flex items-center justify-center py-12 text-center">
            <div>
              <h3 className="text-lg font-semibold mb-2">No data available</h3>
              <p className="text-muted-foreground">Try refreshing the data.</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
