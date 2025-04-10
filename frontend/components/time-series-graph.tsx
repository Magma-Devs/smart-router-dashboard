"use client"

import { useState } from "react"
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts"
import { format } from "date-fns"
import type { ProcessedMetric } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useRouter, useSearchParams } from "next/navigation"
import { RefreshCw } from "lucide-react"

interface TimeSeriesGraphProps {
  data: {
    status: string;
    data: {
      resultType: string;
      result: Array<{
        metric: {
          __name__: string;
          apiInterface: string;
          container: string;
          endpoint: string;
          instance: string;
          job: string;
          namespace: string;
          pod: string;
          service: string;
          spec: string;
        };
        values: Array<[number, string]>;
      }>;
    };
  } | null;
  onRefresh?: (minutes: number) => void;
  title?: string;
  isLatency?: boolean;
}

export function TimeSeriesGraph({ data, onRefresh, title = "Total Requests Served", isLatency = false }: TimeSeriesGraphProps) {
  const [timeRange, setTimeRange] = useState(15);
  const [selectedSpec, setSelectedSpec] = useState<string>("all");

  const handleTimeRangeChange = (value: string) => {
    const minutes = parseInt(value, 10);
    setTimeRange(minutes);
    if (onRefresh) {
      onRefresh(minutes);
    }
  };

  const handleRefresh = () => {
    if (onRefresh) {
      onRefresh(timeRange);
    }
  };

  const handleSpecChange = (spec: string) => {
    setSelectedSpec(spec);
  };

  const handleLegendClick = (data: any) => {
    const clickedSpec = data.value.split(' (')[0];
    setSelectedSpec(prevSpec => prevSpec === clickedSpec ? 'all' : clickedSpec);
  };

  if (!data || !data.data || !data.data.result || !Array.isArray(data.data.result)) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-[300px] flex items-center justify-center text-muted-foreground">
            No data available
          </div>
        </CardContent>
      </Card>
    );
  }

  // Get unique specs for the selector
  const specs = Array.from(new Set(data.data.result.map(item => item.metric.spec)));

  // Create a color map for all series to maintain consistent colors
  const colorMap = new Map<string, string>();
  data.data.result.forEach((series, index) => {
    const name = `${series.metric.spec} (${series.metric.apiInterface})`;
    colorMap.set(name, `hsl(${index * 30}, 70%, 50%)`);
  });

  // Filter data based on selected spec
  const filteredData = selectedSpec === 'all' 
    ? data.data.result 
    : data.data.result.filter(item => item.metric.spec === selectedSpec);

  // Transform the data into a format that Recharts can use
  const chartData = filteredData.map(series => {
    const name = `${series.metric.spec} (${series.metric.apiInterface})`;
    return {
      name,
      data: series.values.map(([timestamp, value]) => ({
        timestamp: new Date(timestamp * 1000).toLocaleTimeString(),
        value: parseFloat(value)
      }))
    };
  });

  // Create a map of all timestamps to ensure we have data points for all series at each timestamp
  const allTimestamps = new Set<string>();
  chartData.forEach(series => {
    series.data.forEach(point => {
      allTimestamps.add(point.timestamp);
    });
  });

  // Create the final chart data with all series at each timestamp
  const finalChartData = Array.from(allTimestamps).sort().map(timestamp => {
    const dataPoint: any = { timestamp };
    chartData.forEach(series => {
      const point = series.data.find(p => p.timestamp === timestamp);
      dataPoint[series.name] = point ? point.value : null;
    });
    return dataPoint;
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{title}</CardTitle>
        <div className="flex items-center space-x-4">
          <Select value={selectedSpec} onValueChange={handleSpecChange}>
            <SelectTrigger className="w-[180px]">
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
          <div className="flex space-x-2">
            <Button 
              variant={timeRange === 5 ? "default" : "outline"} 
              onClick={() => handleTimeRangeChange("5")}
              size="sm"
            >
              5m
            </Button>
            <Button 
              variant={timeRange === 15 ? "default" : "outline"} 
              onClick={() => handleTimeRangeChange("15")}
              size="sm"
            >
              15m
            </Button>
            <Button 
              variant={timeRange === 30 ? "default" : "outline"} 
              onClick={() => handleTimeRangeChange("30")}
              size="sm"
            >
              30m
            </Button>
            <Button 
              variant={timeRange === 60 ? "default" : "outline"} 
              onClick={() => handleTimeRangeChange("60")}
              size="sm"
            >
              1h
            </Button>
          </div>
          <Button 
            variant="outline" 
            size="sm" 
            onClick={handleRefresh}
            className="ml-2"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="h-[300px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={finalChartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis 
                dataKey="timestamp" 
                tick={{ fontSize: 12 }}
                interval="preserveStartEnd"
              />
              <YAxis />
              <Tooltip 
                formatter={(value: any, name: string) => {
                  if (value === null || value === undefined) return ['No data', name];
                  return isLatency 
                    ? [`${value.toLocaleString()} ms`, name]
                    : [`${value.toLocaleString()} requests`, name];
                }}
                labelFormatter={(label) => `Time: ${label}`}
              />
              <Legend 
                verticalAlign="bottom" 
                height={36}
                onClick={handleLegendClick}
                formatter={(value) => {
                  const [spec, apiInterface] = value.split(' (');
                  return `${spec} (${apiInterface.replace(')', '')})`;
                }}
              />
              {chartData.map((series) => (
                <Line
                  key={series.name}
                  type="monotone"
                  dataKey={series.name}
                  stroke={colorMap.get(series.name) || `hsl(${Math.random() * 360}, 70%, 50%)`}
                  dot={false}
                  name={series.name}
                  activeDot={{ r: 8 }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
