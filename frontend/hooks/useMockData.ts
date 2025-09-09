import { useMemo, useState, useCallback } from "react"
import { ProviderMetrics, ChainMetrics, MetricsData } from "@/types/metrics"
import { getChainLabel } from "@/app/config/chains"

interface UseMockDataProps {
  availableChains?: string[]
  availableProviders?: string[]
  getChainLabel?: (chainValue: string) => string
}

export function useMockData({ 
  availableChains = ["Bitcoin", "Ethereum", "Solana", "Hyperliquid", "Arbitrum", "Polygon"],
  availableProviders = ["In-house", "Alchemy", "Quicknode", "Lava", "Infura", "Ankr"],
  getChainLabel: customGetChainLabel = getChainLabel
}: UseMockDataProps = {}) {
  const [refreshKey, setRefreshKey] = useState(0)
  const generateMockProviderData = (provider: string): ProviderMetrics => {
    const baseTraffic = Math.floor(Math.random() * 10000000) + 1000000 // 1M-11M req/day
    const baseUptime = Math.floor(Math.random() * 40) + 60 // 60-100%
    const baseLatency = Math.floor(Math.random() * 200) + 50 // 50-250ms
    const baseSync = Math.floor(Math.random() * 30) + 70 // 70-100%

    return {
      provider,
      traffic: `${(baseTraffic / 1000000).toFixed(1)}M req/day`,
      uptime: `${baseUptime}%`,
      latency: `${baseLatency}ms`,
      sync: `${baseSync}%`
    }
  }

  const generateMockChainData = (chainValue: string): ChainMetrics => {
    const baseTraffic = Math.floor(Math.random() * 10000000) + 1000000 // 1M-11M req/day
    const baseUptime = Math.random() * 40 + 60 // 60-100% (float)
    const baseLatency = Math.floor(Math.random() * 200) + 50 // 50-250ms
    const baseFreshness = Math.random() * 30 + 70 // 70-100% (float)

    return {
      chain: customGetChainLabel(chainValue), // Use the label instead of raw value
      traffic: `${(baseTraffic / 1000000).toFixed(1)}M req/day`,
      uptime: `${baseUptime.toFixed(1)}%`,
      latency: `${baseLatency}ms`,
      freshness: `${baseFreshness.toFixed(1)}%`
    }
  }

  const generateMockData = useMemo((): MetricsData => {
    console.log("useMockData: generating data with chains:", availableChains, "providers:", availableProviders)
    const result = {
      providers: availableProviders.map(provider => generateMockProviderData(provider)),
      chains: availableChains.map(chain => generateMockChainData(chain)),
      selectedChain: "All Chains",
      selectedProvider: "All Providers",
      timeFrame: "15m"
    }
    console.log("useMockData: generated result:", result)
    return result
  }, [refreshKey, availableChains, availableProviders])

  const refreshMockData = useCallback(() => {
    setRefreshKey(prev => prev + 1)
  }, [])

  return {
    generateMockProviderData,
    generateMockChainData,
    generateMockData,
    refreshMockData
  }
}
