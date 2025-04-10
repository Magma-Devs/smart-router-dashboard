"use client"

import { useEffect, useState } from "react"
import { useLocalStorage } from "@/hooks/use-local-storage"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { TimeSeriesGraph } from "@/components/time-series-graph"
import { FlowVisualization } from "@/components/flow-visualization"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Loader2, AlertCircle, RefreshCw, Info } from "lucide-react"
import type { MetricsResponse, ProcessedMetric } from "@/lib/types"
import { processMetricsData } from "@/lib/utils"
import { generateMockData } from "@/lib/mock"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Label } from "@/components/ui/label"

export default function Home() {
  const [apiUrl, setApiUrl] = useLocalStorage(
    "api-url",
    "http://localhost:8000/api/metrics/last_minutes?query=lava_provider_overall_health_breakdown",
  )
  const [refreshInterval, setRefreshInterval] = useLocalStorage("refresh-interval", "30")
  const [data, setData] = useState<ProcessedMetric[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [usingMockData, setUsingMockData] = useState(false)

  const fetchData = async () => {
    setLoading(true)
    setError(null)

    // Check if we're in a preview environment or using a localhost URL
    const isPreviewEnvironment = typeof window !== "undefined" && window.location.hostname !== "localhost"
    const isLocalhostUrl = apiUrl.includes("localhost") || apiUrl.includes("127.0.0.1")

    // If we're in a preview environment and using a localhost URL, use mock data immediately
    if (isPreviewEnvironment && isLocalhostUrl) {
      console.log("Preview environment with localhost URL detected. Using mock data.")
      const mockData = generateMockData()
      setData(mockData)
      setLastUpdated(new Date())
      setUsingMockData(true)
      setLoading(false)
      return
    }

    try {
      // Try to fetch from the API
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 10000) // 10 second timeout

      const response = await fetch(apiUrl, {
        signal: controller.signal,
        cache: "no-store",
        headers: {
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        },
      }).catch((err) => {
        throw new Error("Could not connect to the API endpoint")
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        throw new Error(`API returned status: ${response.status}`)
      }

      const result: MetricsResponse = await response.json()
      if (result.status !== "success") {
        throw new Error("API returned an unsuccessful status")
      }

      const processedData = processMetricsData(result)
      setData(processedData)
      setLastUpdated(new Date())
      setUsingMockData(false)
    } catch (err) {
      console.error("Error fetching data:", err)

      // Use mock data as fallback
      console.log("Using mock data as fallback")
      const mockData = generateMockData()
      setData(mockData)
      setLastUpdated(new Date())
      setUsingMockData(true)

      // Set a more user-friendly error message
      if (err instanceof Error) {
        setError(err.message)
      } else {
        setError("An unknown error occurred")
      }
    } finally {
      setLoading(false)
    }
  }

  // Manual refresh handler
  const handleManualRefresh = () => {
    fetchData()
  }

  // Handle refresh interval change
  const handleRefreshIntervalChange = (value: string) => {
    setRefreshInterval(value)
  }

  useEffect(() => {
    // Initial fetch
    fetchData()

    // Set up polling based on the selected interval
    const intervalInSeconds = Number.parseInt(refreshInterval, 10)
    const intervalId = setInterval(fetchData, intervalInSeconds * 1000)

    return () => clearInterval(intervalId)
  }, [apiUrl, refreshInterval])

  return (
    <div className="container mx-auto px-4 py-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6">
        <h1 className="text-3xl font-bold">Infrastructure Health Dashboard</h1>

        <div className="flex flex-col sm:flex-row items-end sm:items-center gap-4 mt-4 sm:mt-0">
          <div className="flex flex-col space-y-1">
            <Label htmlFor="refresh-interval">Refresh Interval</Label>
            <Select value={refreshInterval} onValueChange={handleRefreshIntervalChange}>
              <SelectTrigger id="refresh-interval" className="w-[140px]">
                <SelectValue placeholder="Select interval" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">1 second</SelectItem>
                <SelectItem value="5">5 seconds</SelectItem>
                <SelectItem value="10">10 seconds</SelectItem>
                <SelectItem value="30">30 seconds</SelectItem>
                <SelectItem value="60">1 minute</SelectItem>
                <SelectItem value="300">5 minutes</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Button variant="outline" size="icon" onClick={handleManualRefresh} disabled={loading} title="Refresh data">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {lastUpdated && (
        <p className="text-sm text-muted-foreground mb-4">Last updated: {lastUpdated.toLocaleTimeString()}</p>
      )}

      {usingMockData && (
        <Alert className="mb-6">
          <Info className="h-4 w-4" />
          <AlertTitle>Using Demo Data</AlertTitle>
          <AlertDescription>
            {apiUrl.includes("localhost")
              ? "Localhost URLs are not accessible in preview environments. Using demonstration data instead."
              : "Could not connect to the API endpoint. Using demonstration data instead."}
          </AlertDescription>
        </Alert>
      )}

      {error && !usingMockData && (
        <Alert variant="destructive" className="mb-6">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading && data.length === 0 ? (
        <div className="flex justify-center items-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <span className="ml-2">Loading data...</span>
        </div>
      ) : (
        <>
          <Card className="mb-6">
            <CardHeader>
              <CardTitle>System Flow Visualization</CardTitle>
              <CardDescription>Visualizing the health status between Users, Consumers, and Providers</CardDescription>
            </CardHeader>
            <CardContent className="p-0 overflow-hidden">
              <div className="h-[400px] w-full overflow-auto">
                <FlowVisualization data={data} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Health Metrics Over Time</CardTitle>
              <CardDescription>Time series data showing provider health status</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-[400px] w-full">
                <TimeSeriesGraph data={data} />
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
