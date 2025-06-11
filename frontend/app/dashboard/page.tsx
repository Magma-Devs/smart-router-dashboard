"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { FlowVisualization } from "@/components/flow-visualization"
import { TimeSeriesGraph } from "@/components/time-series-graph"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertTriangle, Settings, RefreshCw } from "lucide-react"
import { useConfig } from "@/hooks/use-config"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import Link from "next/link"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { chains } from "@/app/config/chains"

interface DashboardData {
  flow: any; // Replace with proper type if available
  metrics: any; // Replace with proper type if available
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const { config, updateRefreshInterval } = useConfig()
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  useEffect(() => {
    console.log("Initializing dashboard with config:", config)
    if (config.apiEndpoint) {
      console.log("Fetching data with API endpoint:", config.apiEndpoint)
      fetchData()
    } else {
      console.log("No API endpoint configured")
      setError("No API endpoint configured. Please set up an API endpoint in the configuration page.")
      setLoading(false)
    }
    
    // Set up polling based on refresh interval
    const intervalMs = (config.refreshInterval || 60) * 1000
    console.log("Setting up refresh interval:", intervalMs, "ms")
    const interval = setInterval(() => {
      console.log("Auto-refreshing data")
      fetchData()
    }, intervalMs)
    
    return () => {
      console.log("Cleaning up dashboard")
      clearInterval(interval)
    }
  }, [config.apiEndpoint, config.refreshInterval])

  const fetchData = async () => {
    console.log("Starting data fetch")
    setLoading(true)
    setError(null)
    
    try {
      if (!config.apiEndpoint) {
        setError("No API endpoint configured. Please set up an API endpoint in the configuration page.")
        setLoading(false)
        return
      }
      
      // Fetch flow visualization data using the metrics endpoint
      const flowEndpoint = `${config.apiEndpoint}/api/metrics/last_minutes?query=lava_provider_overall_health_breakdown&minutes=1&step=1`
      console.log("Fetching flow data from:", flowEndpoint)
      const flowResponse = await fetch(flowEndpoint)
      
      if (!flowResponse.ok) {
        throw new Error(`API returned status ${flowResponse.status}`)
      }
      
      const flowData = await flowResponse.json()
      console.log("Flow data received:", flowData)

      // Map the chain labels if we have valid data
      if (flowData?.status === 'success' && flowData.data?.result) {
        flowData.data.result = flowData.data.result.map((result: any) => {
          if (result.metric?.spec) {
            const chain = chains.find(c => c.value.toLowerCase() === result.metric.spec.toLowerCase())
            if (chain) {
              return {
                ...result,
                metric: {
                  ...result.metric,
                  label: chain.label, // Add the label to the metric
                  icon: chain.icon // Add the icon to the metric
                }
              }
            }
          }
          return result
        })
      }
      
      // Fetch metrics data
      console.log("Fetching metrics data")
      await fetchMetricsData()
      
      setData(prevData => ({
        flow: flowData,
        metrics: prevData?.metrics || null
      }))
    } catch (err) {
      console.error("Error fetching data:", err)
      setError(`Failed to connect to API: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setLoading(false)
    }
  }

  const fetchMetricsData = async (minutes: number = 15) => {
    try {
      if (!config.apiEndpoint) {
        console.error("No API endpoint configured")
        return
      }

      // Fetch total requests data
      const query = encodeURIComponent('sum(lava_provider_total_relays_serviced) by (spec, service)')
      const requestsEndpoint = `${config.apiEndpoint}/api/metrics/last_minutes?query=${query}&minutes=${minutes}&step=1s`
      console.log("Fetching requests data from:", requestsEndpoint)
      const requestsResponse = await fetch(requestsEndpoint)
      
      if (!requestsResponse.ok) {
        throw new Error(`Requests API returned status ${requestsResponse.status}`)
      }
      
      const requestsData = await requestsResponse.json()
      console.log("Requests data received:", requestsData)

      // Fetch average latency data
      const latencyEndpoint = `${config.apiEndpoint}/api/metrics/last_minutes?query=lava_consumer_average_latency_in_milliseconds&minutes=${minutes}&step=1s`
      console.log("Fetching latency data from:", latencyEndpoint)
      const latencyResponse = await fetch(latencyEndpoint)
      
      if (!latencyResponse.ok) {
        throw new Error(`Latency API returned status ${latencyResponse.status}`)
      }
      
      const latencyData = await latencyResponse.json()
      console.log("Latency data received:", latencyData)
      
      setData(prevData => ({
        flow: prevData?.flow || null,
        metrics: {
          requests: requestsData,
          latency: latencyData
        }
      }))
      setLastUpdated(new Date())
    } catch (err) {
      console.error("Error fetching metrics data:", err)
    }
  }

  // Handle refresh interval change
  const handleRefreshIntervalChange = (value: string) => {
    const numValue = parseInt(value, 10)
    updateRefreshInterval(numValue)
  }

  // Handle manual refresh
  const handleManualRefresh = () => {
    fetchData()
  }

  // Loading and error content for visualization components
  const renderContent = (height = "h-96") => {
    if (loading) {
      return (
        <div className={`flex items-center justify-center ${height}`}>
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
        </div>
      )
    }
    
    if (!data) {
      return (
        <div className={`flex flex-col items-center justify-center ${height} gap-4 text-center`}>
          <AlertTriangle className="h-12 w-12 text-muted-foreground" />
          <div className="max-w-md">
            <h3 className="text-lg font-semibold mb-2">No data available</h3>
            <p className="text-muted-foreground mb-4">
              {error || "Check your API endpoint configuration or ensure the API server is running."}
            </p>
            <Link href="/configuration">
              <Button variant="outline" size="sm">
                <Settings className="mr-2 h-4 w-4" />
                Go to Configuration
              </Button>
            </Link>
          </div>
        </div>
      )
    }
    
    return null
  }

  return (
    <div className="container mx-auto px-4 py-6 max-w-7xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Dashboard</h1>
          {lastUpdated && (
            <p className="text-sm text-muted-foreground mt-1">
              Last updated: {lastUpdated.toLocaleTimeString()}
            </p>
          )}
      </div>
      <div className="flex flex-wrap items-end justify-between mb-6 gap-4">
        <div className="flex flex-col">


        </div>
        
        <div className="flex items-center gap-2">
          <Select 
            value={config.refreshInterval.toString()} 
            onValueChange={handleRefreshIntervalChange}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Auto-refresh every" />
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
          
          <Button 
            variant="outline" 
            size="icon" 
            onClick={handleManualRefresh} 
            disabled={loading}
            title="Refresh now"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>
      
      {error && (
        <Alert variant="destructive" className="mb-6">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>System Flow Visualization</CardTitle>
            <CardDescription>
              Visualizing the health status between Users, Chains, and Providers
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0 overflow-hidden">
            {renderContent() || (data?.flow && <FlowVisualization key="flow-visualization" data={data.flow} />)}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Metrics</CardTitle>
            <CardDescription>
              Time series data showing system performance metrics
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="requests" className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="requests">Total Requests Served</TabsTrigger>
                <TabsTrigger value="latency">Average Latency</TabsTrigger>
              </TabsList>
              <TabsContent value="requests" className="mt-4">
                <div className="h-[400px] w-full">
                  {renderContent("h-[400px]") || (data?.metrics?.requests && (
                    <TimeSeriesGraph 
                      data={data.metrics.requests} 
                      onRefresh={fetchMetricsData} 
                      title="Total Requests Served"
                    />
                  ))}
                </div>
              </TabsContent>
              <TabsContent value="latency" className="mt-4">
                <div className="h-[400px] w-full">
                  {renderContent("h-[400px]") || (data?.metrics?.latency && (
                    <TimeSeriesGraph 
                      data={data.metrics.latency} 
                      onRefresh={fetchMetricsData} 
                      title="Average Latency"
                      isLatency={true}
                    />
                  ))}
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  )
} 