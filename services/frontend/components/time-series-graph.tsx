"use client"

import { useState } from "react"
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts"
import { format } from "date-fns"
import type { ProcessedMetric } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Label } from "@/components/ui/label"

interface TimeSeriesGraphProps {
  data: ProcessedMetric[]
}

export function TimeSeriesGraph({ data }: TimeSeriesGraphProps) {
  const [timeRange, setTimeRange] = useState("1h")
  const [selectedSpec, setSelectedSpec] = useState<string | "all">("all")

  // At the beginning of the TimeSeriesGraph function, add this check:
  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">No data available to display</p>
      </div>
    )
  }

  // Get unique specs for filtering
  const specs = Array.from(new Set(data.map((item) => item.spec)))

  // Filter data based on selected spec
  const filteredData = selectedSpec === "all" ? data : data.filter((item) => item.spec === selectedSpec)

  // Prepare data for the chart
  const chartData = prepareChartData(filteredData, timeRange)

  // Generate colors for each metric
  const colors = generateColors(filteredData.length)

  return (
    <div className="w-full h-full">
      <div className="flex flex-wrap gap-4 mb-4 items-end">
        <div className="space-y-2">
          <Label htmlFor="spec-filter">Filter by Spec</Label>
          <Select value={selectedSpec} onValueChange={(value) => setSelectedSpec(value)}>
            <SelectTrigger id="spec-filter" className="w-[180px]">
              <SelectValue placeholder="Select Spec" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Specs</SelectItem>
              {specs.map((spec) => (
                <SelectItem key={spec} value={spec}>
                  {spec}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex space-x-2 ml-auto">
          <Button variant={timeRange === "1h" ? "default" : "outline"} onClick={() => setTimeRange("1h")} size="sm">
            1h
          </Button>
          <Button variant={timeRange === "6h" ? "default" : "outline"} onClick={() => setTimeRange("6h")} size="sm">
            6h
          </Button>
          <Button variant={timeRange === "24h" ? "default" : "outline"} onClick={() => setTimeRange("24h")} size="sm">
            24h
          </Button>
        </div>
      </div>

      <div className="h-[350px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="timestamp" tickFormatter={(timestamp) => format(new Date(timestamp), "HH:mm")} />
            <YAxis domain={[0, 1]} ticks={[0, 0.5, 1]} />
            <Tooltip
              labelFormatter={(timestamp) => format(new Date(timestamp), "yyyy-MM-dd HH:mm:ss")}
              formatter={(value, name) => [value === 1 ? "Healthy" : "Unhealthy", name]}
            />
            <Legend />
            {filteredData.map((metric, index) => (
              <Line
                key={`${metric.spec}-${metric.apiInterface}`}
                type="monotone"
                dataKey={`${metric.spec}-${metric.apiInterface}`}
                name={`${metric.spec} (${metric.apiInterface})`}
                stroke={colors[index % colors.length]}
                activeDot={{ r: 8 }}
                strokeWidth={2}
                dot={{ r: 3 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

// Helper function to prepare data for the chart
function prepareChartData(metrics: ProcessedMetric[], timeRange: string): any[] {
  if (!metrics.length) return []

  // Determine time filter based on selected range
  const now = Date.now()
  const timeFilter = {
    "1h": now - 60 * 60 * 1000,
    "6h": now - 6 * 60 * 60 * 1000,
    "24h": now - 24 * 60 * 60 * 1000,
  }[timeRange]

  // Collect all timestamps across all metrics
  const allTimestamps = new Set<number>()
  metrics.forEach((metric) => {
    metric.values.forEach((point) => {
      if (point.timestamp >= timeFilter) {
        allTimestamps.add(point.timestamp)
      }
    })
  })

  // Sort timestamps
  const sortedTimestamps = Array.from(allTimestamps).sort((a, b) => a - b)

  // Create data points for each timestamp
  return sortedTimestamps.map((timestamp) => {
    const dataPoint: any = { timestamp }

    metrics.forEach((metric) => {
      const key = `${metric.spec}-${metric.apiInterface}`
      const point = metric.values.find((p) => p.timestamp === timestamp)
      dataPoint[key] = point ? point.value : null
    })

    return dataPoint
  })
}

// Generate colors for the chart lines
function generateColors(count: number): string[] {
  const baseColors = [
    "#FF6B6B",
    "#4ECDC4",
    "#45B7D1",
    "#FFA5AB",
    "#98D8C8",
    "#F9C846",
    "#A06CD5",
    "#3BCEAC",
    "#FF8C42",
    "#6A67CE",
  ]

  if (count <= baseColors.length) {
    return baseColors.slice(0, count)
  }

  // If we need more colors, repeat the base colors
  const repeatedColors = []
  for (let i = 0; i < Math.ceil(count / baseColors.length); i++) {
    repeatedColors.push(...baseColors)
  }

  return repeatedColors.slice(0, count)
}
