'use client';

import { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { RefreshCw, Globe, TrendingUp, Clock, Activity, Layers, ChevronDown, ChevronUp, XCircle } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { ProtectedRoute } from '@/components/protected-route';
import { useConfig } from '@/hooks/use-config';
import { chains, getChainLabel, getChainIcon } from '@/app/config/chains';
import { TIME_FRAMES, DEFAULT_TIME_FRAME } from '@/constants/timeFrames';
import { MetricsService, UsageMetricsResponse, ChainUsageMetrics as ApiChainUsageMetrics } from '@/services/metricsService';
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  Legend,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts';

// Data types
interface MethodUsage {
  method: string;
  requests: number;
  errors: number;
  errorRate: number;
  avgLatency: number | null;
  percentage: number;
}

interface ChainUsageData {
  chainId: string;
  network: string;
  single: {
    totalRequests: number;
    totalErrors: number;
    errorRate: number;
    avgLatency: number | null;
    methods: MethodUsage[];
    requestsOverTime: Array<{ timestamp: string; value: number }>;
  };
  batch: {
    totalRequests: number;
    totalErrors: number;
    errorRate: number;
    avgLatency: number | null;
    avgBatchSize: number;
    methods: MethodUsage[];
    requestsOverTime: Array<{ timestamp: string; value: number }>;
  };
}

// Color palette for pie chart
const COLORS = [
  '#6366F1', // Indigo
  '#10B981', // Emerald
  '#F59E42', // Orange
  '#F43F5E', // Rose
  '#3B82F6', // Blue
  '#FBBF24', // Amber
  '#8B5CF6', // Violet
  '#14B8A6', // Teal
  '#EAB308', // Yellow
  '#EC4899', // Pink
];

// Generate mock requests over time data
const generateRequestsOverTime = (baseRequests: number, points: number = 12) => {
  const data = [];
  const now = new Date();
  for (let i = points - 1; i >= 0; i--) {
    const time = new Date(now.getTime() - i * 5 * 60 * 1000);
    const variance = (Math.random() - 0.5) * baseRequests * 0.4;
    data.push({
      timestamp: time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      value: Math.max(0, Math.round(baseRequests + variance)),
    });
  }
  return data;
};

// Generate mock data for a chain
const generateMockChainData = (chainId: string, network: string): ChainUsageData => {
  const generateMethodWithErrors = (method: string, baseRequests: number, baseLatency: number): MethodUsage => {
    const requests = Math.floor(Math.random() * baseRequests) + Math.floor(baseRequests / 2);
    const errors = Math.floor(Math.random() * requests * 0.05); // 0-5% errors
    const errorRate = requests > 0 ? (errors / requests) * 100 : 0;
    return {
      method,
      requests,
      errors,
      errorRate: Math.round(errorRate * 100) / 100,
      avgLatency: Math.floor(Math.random() * baseLatency) + Math.floor(baseLatency / 2),
      percentage: 0,
    };
  };

  const singleMethods: MethodUsage[] = [
    generateMethodWithErrors('eth_blockNumber', 50000, 50),
    generateMethodWithErrors('eth_getBalance', 30000, 80),
    generateMethodWithErrors('eth_call', 40000, 100),
    generateMethodWithErrors('eth_getTransactionReceipt', 20000, 60),
    generateMethodWithErrors('eth_chainId', 15000, 30),
    generateMethodWithErrors('eth_gasPrice', 25000, 40),
  ];

  const singleTotal = singleMethods.reduce((sum, m) => sum + m.requests, 0);
  const singleTotalErrors = singleMethods.reduce((sum, m) => sum + m.errors, 0);
  singleMethods.forEach(m => {
    m.percentage = Math.round((m.requests / singleTotal) * 100);
  });
  singleMethods.sort((a, b) => b.requests - a.requests);

  // Batch methods - aggregated by normalized composition
  // Format: "2 x eth_call, 1 x getSlot" means 2 eth_call + 1 getSlot in the batch
  // All permutations are grouped together
  const batchMethods: MethodUsage[] = [
    generateMethodWithErrors('2 x eth_call, 1 x eth_blockNumber', 8000, 90),  // size 3
    generateMethodWithErrors('1 x eth_call, 1 x eth_getBalance', 6000, 85),   // size 2
    generateMethodWithErrors('3 x eth_call', 5000, 100),                       // size 3
    generateMethodWithErrors('1 x eth_blockNumber, 1 x eth_chainId', 4000, 60), // size 2
    generateMethodWithErrors('2 x eth_getBalance, 1 x eth_call', 3000, 95),   // size 3
  ];

  const batchTotal = batchMethods.reduce((sum, m) => sum + m.requests, 0);
  const batchTotalErrors = batchMethods.reduce((sum, m) => sum + m.errors, 0);
  batchMethods.forEach(m => {
    m.percentage = Math.round((m.requests / batchTotal) * 100);
  });
  batchMethods.sort((a, b) => b.requests - a.requests);

  // Calculate avg batch size from unique compositions
  // Parse "2 x eth_call, 1 x getSlot" to get batch size = 3
  const getBatchSizeFromMethod = (method: string): number => {
    const matches = method.match(/(\d+) x/g);
    if (!matches) return 1;
    return matches.reduce((sum, m) => sum + parseInt(m), 0);
  };
  // Sum of batch sizes for each unique composition / number of unique compositions
  const totalBatchSizes = batchMethods.reduce((sum, m) => sum + getBatchSizeFromMethod(m.method), 0);
  const avgBatchSize = batchMethods.length > 0 ? Math.round((totalBatchSizes / batchMethods.length) * 10) / 10 : 0;

  const avgSingleLatency = Math.round(
    singleMethods.reduce((sum, m) => sum + (m.avgLatency || 0), 0) / singleMethods.length
  );
  const avgBatchLatency = Math.round(
    batchMethods.reduce((sum, m) => sum + (m.avgLatency || 0), 0) / batchMethods.length
  );

  return {
    chainId,
    network,
    single: {
      totalRequests: singleTotal,
      totalErrors: singleTotalErrors,
      errorRate: singleTotal > 0 ? Math.round((singleTotalErrors / singleTotal) * 10000) / 100 : 0,
      avgLatency: avgSingleLatency,
      methods: singleMethods,
      requestsOverTime: generateRequestsOverTime(singleTotal / 12),
    },
    batch: {
      totalRequests: batchTotal,
      totalErrors: batchTotalErrors,
      errorRate: batchTotal > 0 ? Math.round((batchTotalErrors / batchTotal) * 10000) / 100 : 0,
      avgLatency: avgBatchLatency,
      avgBatchSize: avgBatchSize,
      methods: batchMethods,
      requestsOverTime: generateRequestsOverTime(batchTotal / 12),
    },
  };
};

// Custom tooltip for pie chart
const CustomPieTooltip = ({ active, payload }: any) => {
  if (!active || !payload || payload.length === 0) return null;
  const data = payload[0].payload;
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-3 shadow-lg max-w-xs">
      <p className="font-medium text-zinc-100 whitespace-pre-line">{data.method}</p>
      <p className="text-sm text-zinc-400 mt-2">
        Requests: <span className="text-zinc-100">{data.requests.toLocaleString()}</span>
      </p>
      <p className="text-sm text-zinc-400">
        Errors: <span className="text-zinc-100">{data.errors.toLocaleString()} ({data.errorRate}%)</span>
      </p>
      <p className="text-sm text-zinc-400">
        Share: <span className="text-zinc-100">{data.percentage}%</span>
      </p>
      <p className="text-sm text-zinc-400">
        Avg Latency: <span className="text-zinc-100">{data.avgLatency !== null ? `${data.avgLatency}ms` : '-'}</span>
      </p>
    </div>
  );
};

// Custom tooltip for line chart (requests over time)
const CustomLineTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-3 shadow-lg">
      <p className="text-sm text-zinc-400">{label}</p>
      <p className="font-medium text-zinc-100">{Math.round(payload[0].value).toLocaleString()} requests</p>
    </div>
  );
};

export default function UsagePage() {
  const { config } = useConfig();
  const [selectedChain, setSelectedChain] = useState<string>('all');
  const [selectedTimeFrame, setSelectedTimeFrame] = useState<string>(DEFAULT_TIME_FRAME);
  const [isLoading, setIsLoading] = useState(false);
  const [usageData, setUsageData] = useState<ChainUsageData | null>(null);
  const [availableChains, setAvailableChains] = useState<Array<{ id: string; network: string }>>([]);
  const [singleExpanded, setSingleExpanded] = useState(true);
  const [batchExpanded, setBatchExpanded] = useState(true);

  // Fetch available chains from API
  useEffect(() => {
    const fetchAvailableChains = async () => {
      try {
        // Fetch chains from the chains-metrics endpoint (minimal time window)
        const chainsResponse = await MetricsService.fetchMetricsForAllChains(1, 1);
        
        // Extract chain data with both ID and network for icon lookup
        const chainsData = Object.entries(chainsResponse.chains).map(
          ([chainId, chainMetrics]: [string, any]) => ({
            id: chainId,
            network: chainMetrics.network || chainId,
          }),
        );
        
        if (chainsData.length > 0) {
          setAvailableChains(chainsData);
        } else {
          // Fallback to mock chains if API returns empty
          setAvailableChains([
            { id: 'eth1-router-1', network: 'eth1' },
            { id: 'arbitrum-router-1', network: 'arbitrum' },
            { id: 'polygon-router-1', network: 'polygon' },
            { id: 'base-router-1', network: 'base' },
            { id: 'solana-router-1', network: 'solana' },
          ]);
        }
      } catch (error) {
        // Fallback to mock chains on error
        setAvailableChains([
          { id: 'eth1-router-1', network: 'eth1' },
          { id: 'arbitrum-router-1', network: 'arbitrum' },
          { id: 'polygon-router-1', network: 'polygon' },
          { id: 'base-router-1', network: 'base' },
          { id: 'solana-router-1', network: 'solana' },
        ]);
      }
    };

    fetchAvailableChains();
  }, [config.apiEndpoint]);

  // Convert API response to local format
  const convertApiToLocalFormat = (apiData: ApiChainUsageMetrics): ChainUsageData => {
    return {
      chainId: apiData.chain_id,
      network: apiData.network,
      single: {
        totalRequests: apiData.single.total_requests,
        totalErrors: apiData.single.total_errors,
        errorRate: apiData.single.error_rate,
        avgLatency: apiData.single.avg_latency_ms,
        methods: apiData.single.methods.map(m => ({
          method: m.method,
          requests: m.requests,
          errors: m.errors,
          errorRate: m.error_rate,
          avgLatency: m.avg_latency_ms,
          percentage: m.percentage,
        })),
        requestsOverTime: apiData.single.requests_over_time.map(d => ({
          timestamp: d.timestamp,
          value: d.value,
        })),
      },
      batch: {
        totalRequests: apiData.batch.total_requests,
        totalErrors: apiData.batch.total_errors,
        errorRate: apiData.batch.error_rate,
        avgLatency: apiData.batch.avg_latency_ms,
        avgBatchSize: apiData.batch.avg_batch_size,
        methods: apiData.batch.methods.map(m => ({
          method: m.method,
          requests: m.requests,
          errors: m.errors,
          errorRate: m.error_rate,
          avgLatency: m.avg_latency_ms,
          percentage: m.percentage,
        })),
        requestsOverTime: apiData.batch.requests_over_time.map(d => ({
          timestamp: d.timestamp,
          value: d.value,
        })),
      },
    };
  };

  // Aggregate multiple chain data into one
  const aggregateChainData = (chainsData: ChainUsageData[]): ChainUsageData => {
    if (chainsData.length === 0) {
      return generateMockChainData('all', 'all');
    }
    if (chainsData.length === 1) {
      return { ...chainsData[0], chainId: 'all', network: 'all' };
    }

    // Aggregate methods across all chains
    const singleMethodsMap = new Map<string, { requests: number; errors: number; latencySum: number; latencyCount: number }>();
    const batchMethodsMap = new Map<string, { requests: number; errors: number; latencySum: number; latencyCount: number }>();
    
    let totalSingleRequests = 0;
    let totalSingleErrors = 0;
    let singleLatencySum = 0;
    let singleLatencyCount = 0;
    let batchLatencySum = 0;
    let batchLatencyCount = 0;

    for (const chain of chainsData) {
      totalSingleRequests += chain.single.totalRequests;
      totalSingleErrors += chain.single.totalErrors;
      if (chain.single.avgLatency !== null) {
        singleLatencySum += chain.single.avgLatency * chain.single.totalRequests;
        singleLatencyCount += chain.single.totalRequests;
      }
      if (chain.batch.avgLatency !== null) {
        batchLatencySum += chain.batch.avgLatency * chain.batch.totalRequests;
        batchLatencyCount += chain.batch.totalRequests;
      }

      for (const method of chain.single.methods) {
        const existing = singleMethodsMap.get(method.method) || { requests: 0, errors: 0, latencySum: 0, latencyCount: 0 };
        existing.requests += method.requests;
        existing.errors += method.errors;
        if (method.avgLatency !== null) {
          existing.latencySum += method.avgLatency * method.requests;
          existing.latencyCount += method.requests;
        }
        singleMethodsMap.set(method.method, existing);
      }

      for (const method of chain.batch.methods) {
        const existing = batchMethodsMap.get(method.method) || { requests: 0, errors: 0, latencySum: 0, latencyCount: 0 };
        existing.requests += method.requests;
        existing.errors += method.errors;
        if (method.avgLatency !== null) {
          existing.latencySum += method.avgLatency * method.requests;
          existing.latencyCount += method.requests;
        }
        batchMethodsMap.set(method.method, existing);
      }
    }

    const singleMethods: MethodUsage[] = Array.from(singleMethodsMap.entries()).map(([method, data]) => {
      const errorRate = data.requests > 0 ? (data.errors / data.requests) * 100 : 0;
      const avgLatency = data.latencyCount > 0 ? Math.round(data.latencySum / data.latencyCount) : null;
      return {
        method,
        requests: data.requests,
        errors: data.errors,
        errorRate: Math.round(errorRate * 100) / 100,
        avgLatency,
        percentage: totalSingleRequests > 0 ? Math.round((data.requests / totalSingleRequests) * 100) : 0,
      };
    }).sort((a, b) => b.requests - a.requests);

    // First create batch methods without percentage (we need to calculate total first)
    const batchMethodsRaw = Array.from(batchMethodsMap.entries()).map(([method, data]) => {
      const errorRate = data.requests > 0 ? (data.errors / data.requests) * 100 : 0;
      const avgLatency = data.latencyCount > 0 ? Math.round(data.latencySum / data.latencyCount) : null;
      return {
        method,
        requests: data.requests,
        errors: data.errors,
        errorRate: Math.round(errorRate * 100) / 100,
        avgLatency,
        percentage: 0,
      };
    });

    // Calculate total batch requests from aggregated methods (this is the correct total)
    const aggregatedBatchTotal = batchMethodsRaw.reduce((sum, m) => sum + m.requests, 0);
    
    // Now set percentages and sort
    const batchMethods: MethodUsage[] = batchMethodsRaw.map(m => ({
      ...m,
      percentage: aggregatedBatchTotal > 0 ? Math.round((m.requests / aggregatedBatchTotal) * 100) : 0,
    })).sort((a, b) => b.requests - a.requests);

    const avgSingleLatency = singleLatencyCount > 0 ? Math.round(singleLatencySum / singleLatencyCount) : null;
    const avgBatchLatency = batchLatencyCount > 0 ? Math.round(batchLatencySum / batchLatencyCount) : null;
    
    // Aggregate requests over time by summing values at each timestamp across all chains
    const aggregateRequestsOverTime = (
      chainsData: ChainUsageData[],
      getTimeSeries: (c: ChainUsageData) => Array<{ timestamp: string; value: number }>
    ): Array<{ timestamp: string; value: number }> => {
      const timestampMap = new Map<string, number>();
      
      for (const chain of chainsData) {
        for (const point of getTimeSeries(chain)) {
          const current = timestampMap.get(point.timestamp) || 0;
          timestampMap.set(point.timestamp, current + point.value);
        }
      }
      
      // Sort by timestamp and return
      return Array.from(timestampMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([timestamp, value]) => ({ timestamp, value }));
    };
    
    const singleRequestsOverTime = aggregateRequestsOverTime(chainsData, c => c.single.requestsOverTime);
    const batchRequestsOverTime = aggregateRequestsOverTime(chainsData, c => c.batch.requestsOverTime);

    // Calculate aggregated batch errors from methods
    const aggregatedBatchErrors = batchMethods.reduce((sum, m) => sum + m.errors, 0);

    // Calculate avg batch size from unique compositions
    const getBatchSizeFromMethod = (method: string): number => {
      const matches = method.match(/(\d+) x/g);
      if (!matches) return 1;
      return matches.reduce((sum, m) => sum + parseInt(m), 0);
    };
    const totalBatchSizes = batchMethods.reduce((sum, m) => sum + getBatchSizeFromMethod(m.method), 0);
    const avgBatchSize = batchMethods.length > 0 ? Math.round((totalBatchSizes / batchMethods.length) * 10) / 10 : 0;

    return {
      chainId: 'all',
      network: 'all',
      single: {
        totalRequests: totalSingleRequests,
        totalErrors: totalSingleErrors,
        errorRate: totalSingleRequests > 0 ? Math.round((totalSingleErrors / totalSingleRequests) * 10000) / 100 : 0,
        avgLatency: avgSingleLatency,
        methods: singleMethods,
        requestsOverTime: singleRequestsOverTime,
      },
      batch: {
        totalRequests: aggregatedBatchTotal,
        totalErrors: aggregatedBatchErrors,
        errorRate: aggregatedBatchTotal > 0 ? Math.round((aggregatedBatchErrors / aggregatedBatchTotal) * 10000) / 100 : 0,
        avgLatency: avgBatchLatency,
        avgBatchSize: avgBatchSize,
        methods: batchMethods,
        requestsOverTime: batchRequestsOverTime,
      },
    };
  };

  const fetchUsageData = useCallback(async () => {
    setIsLoading(true);
    
    try {
      // Convert time frame to minutes
      const timeWindowMinutes = MetricsService.convertTimeFrameToMinutes(selectedTimeFrame);
      
      // Fetch usage metrics from API (same pattern as Dashboard: /usage/{chain_id})
      const chainIdParam = selectedChain === 'all' ? undefined : selectedChain;
      const response: UsageMetricsResponse = await MetricsService.fetchUsageMetrics(
        timeWindowMinutes,
        chainIdParam
      );

      // Convert API response to local format
      const chainsArray = Object.values(response.chains).map(convertApiToLocalFormat);
      
      if (chainsArray.length === 0) {
        // No data from API, use mock data
        if (selectedChain === 'all') {
          setUsageData(generateMockChainData('all', 'all'));
        } else {
          const chainInfo = availableChains.find(c => c.id === selectedChain);
          setUsageData(generateMockChainData(selectedChain, chainInfo?.network || selectedChain));
        }
      } else if (selectedChain === 'all') {
        // Aggregate all chains
        setUsageData(aggregateChainData(chainsArray));
      } else {
        // Single chain
        setUsageData(chainsArray[0]);
      }
    } catch (error) {
      // Fallback to mock data on error
      if (selectedChain === 'all') {
        setUsageData(generateMockChainData('all', 'all'));
      } else {
        const chainInfo = availableChains.find(c => c.id === selectedChain);
        setUsageData(generateMockChainData(selectedChain, chainInfo?.network || selectedChain));
      }
    }
    
    setIsLoading(false);
  }, [selectedChain, selectedTimeFrame, availableChains]);

  useEffect(() => {
    fetchUsageData();
  }, [fetchUsageData]);

  const handleChainSelect = (value: string) => {
    setSelectedChain(value);
  };

  const handleTimeFrameChange = (value: string) => {
    setSelectedTimeFrame(value);
  };

  const handleRefresh = () => {
    fetchUsageData();
  };

  const formatNumber = (num: number): string => {
    if (num >= 1000000) {
      return `${(num / 1000000).toFixed(1)}M`;
    } else if (num >= 1000) {
      return `${(num / 1000).toFixed(1)}K`;
    }
    return num.toString();
  };

  return (
    <ProtectedRoute>
      <div className="container mx-auto px-4 py-6 max-w-7xl">
        <div className="mb-8">
          <h1 className="text-3xl font-bold">Usage</h1>
          <p className="text-muted-foreground">
            Monitor request usage and latency metrics per chain.
          </p>
        </div>

        {/* Controls */}
        <Card className="mb-6">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
            <CardTitle>Usage Overview</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              {/* Chain Selection */}
              <Select value={selectedChain} onValueChange={handleChainSelect}>
                <SelectTrigger className="w-[240px] bg-background border-border hover:bg-accent">
                  <SelectValue placeholder="Select chain" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    <div className="flex items-center gap-2">
                      <Globe className="h-4 w-4" />
                      All Networks
                    </div>
                  </SelectItem>
                  {availableChains.map(chain => {
                    const chainConfig = chains.find(c => c.value === chain.network);
                    const label = chainConfig ? chainConfig.label : getChainLabel(chain.network);
                    const icon = chainConfig ? chainConfig.icon : getChainIcon(chain.network);
                    return (
                      <SelectItem key={chain.id} value={chain.id}>
                        <div className="flex items-center gap-2">
                          {icon && (
                            <Image
                              src={icon}
                              alt={label}
                              width={16}
                              height={16}
                              className="rounded-full"
                            />
                          )}
                          {label}
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>

              {/* Time Frame Selection */}
              <Select value={selectedTimeFrame} onValueChange={handleTimeFrameChange}>
                <SelectTrigger className="w-[140px] bg-background border-border hover:bg-accent">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-[15rem]">
                  {TIME_FRAMES.map(timeFrame => (
                    <SelectItem key={timeFrame.value} value={timeFrame.value}>
                      {timeFrame.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Refresh Button */}
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={isLoading}
                title="Refresh data"
                className="bg-background border-border hover:bg-accent"
              >
                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </CardHeader>
        </Card>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
            <span className="ml-4 text-lg text-muted-foreground">Loading usage data...</span>
          </div>
        ) : usageData ? (
          <div className="space-y-6">
            {/* Requests Over Time Graph */}
            <Card>
              <CardHeader>
                <CardTitle>Requests Over Time</CardTitle>
              </CardHeader>
              <CardContent>
                {usageData.single.requestsOverTime.length > 0 ? (
                  <div className="h-[250px]">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={usageData.single.requestsOverTime}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                        <XAxis
                          dataKey="timestamp"
                          tick={{ fontSize: 12, fill: '#9CA3AF' }}
                          tickLine={{ stroke: '#374151' }}
                        />
                        <YAxis
                          tick={{ fontSize: 12, fill: '#9CA3AF' }}
                          tickLine={{ stroke: '#374151' }}
                          tickFormatter={(value) => {
                            if (value >= 1000000000) return `${(value / 1000000000).toFixed(1)}B`;
                            if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
                            if (value >= 1000) return `${(value / 1000).toFixed(0)}k`;
                            return value;
                          }}
                        />
                        <Tooltip content={<CustomLineTooltip />} />
                        <Line
                          type="monotone"
                          dataKey="value"
                          stroke="#6366F1"
                          strokeWidth={2}
                          dot={false}
                          activeDot={{ r: 6 }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <div className="h-[250px] flex items-center justify-center border rounded-lg bg-muted/20">
                    <div className="text-center text-muted-foreground">
                      <TrendingUp className="h-8 w-8 mx-auto mb-2" />
                      <p>No request data available</p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Regular Requests Section */}
            <Collapsible open={singleExpanded} onOpenChange={setSingleExpanded}>
              <Card>
                <CollapsibleTrigger asChild>
                  <CardHeader className="cursor-pointer">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Activity className="h-5 w-5 text-primary" />
                        <CardTitle>Regular Requests</CardTitle>
                        <span className="text-sm text-muted-foreground ml-2">
                          ({formatNumber(usageData.single.totalRequests)} total)
                        </span>
                      </div>
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                        {singleExpanded ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </CardHeader>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <CardContent>
                    {/* Summary Stats */}
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
                      <Card className="bg-muted/50">
                        <CardContent className="p-4">
                          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                            <TrendingUp className="h-4 w-4" />
                            Total Requests
                          </div>
                          <div className="text-2xl font-bold">
                            {formatNumber(usageData.single.totalRequests)}
                          </div>
                        </CardContent>
                      </Card>
                      <Card className="bg-muted/50">
                        <CardContent className="p-4">
                          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                            <XCircle className="h-4 w-4" />
                            Errors
                          </div>
                          <div className="text-2xl font-bold">
                            {formatNumber(usageData.single.totalErrors)} ({usageData.single.errorRate}%)
                          </div>
                        </CardContent>
                      </Card>
                      <Card className="bg-muted/50">
                        <CardContent className="p-4">
                          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                            <Clock className="h-4 w-4" />
                            Avg Latency
                          </div>
                          <div className="text-2xl font-bold">
                            {usageData.single.avgLatency !== null ? (
                              `${usageData.single.avgLatency}ms`
                            ) : (
                              <span className="text-muted-foreground text-lg">-</span>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                      <Card className="bg-muted/50">
                        <CardContent className="p-4">
                          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                            <Layers className="h-4 w-4" />
                            Unique Methods
                          </div>
                          <div className="text-2xl font-bold">
                            {usageData.single.methods.length}
                          </div>
                        </CardContent>
                      </Card>
                    </div>

                    {/* Table and Pie Chart */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                      {/* Methods Table */}
                      <div className="border rounded-lg overflow-hidden">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Method</TableHead>
                              <TableHead className="text-right">Requests</TableHead>
                              <TableHead className="text-right">Errors</TableHead>
                              <TableHead className="text-right">Avg Latency</TableHead>
                              <TableHead className="text-right">Share</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {usageData.single.methods.map((method, index) => (
                              <TableRow key={method.method}>
                                <TableCell className="font-mono text-sm">
                                  <div className="flex items-center gap-2">
                                    <div
                                      className="w-3 h-3 rounded-full"
                                      style={{ backgroundColor: COLORS[index % COLORS.length] }}
                                    />
                                    {method.method}
                                  </div>
                                </TableCell>
                                <TableCell className="text-right">
                                  {formatNumber(method.requests)}
                                </TableCell>
                                <TableCell className="text-right">
                                  {formatNumber(method.errors)} ({method.errorRate}%)
                                </TableCell>
                                <TableCell className="text-right">
                                  {method.avgLatency !== null ? `${method.avgLatency}ms` : '-'}
                                </TableCell>
                                <TableCell className="text-right">{method.percentage}%</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>

                      {/* Pie Chart */}
                      <div className="h-[300px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie
                              data={usageData.single.methods}
                              dataKey="requests"
                              nameKey="method"
                              cx="50%"
                              cy="50%"
                              outerRadius={100}
                            >
                              {usageData.single.methods.map((entry, index) => (
                                <Cell key={entry.method} fill={COLORS[index % COLORS.length]} />
                              ))}
                            </Pie>
                            <Tooltip content={<CustomPieTooltip />} />
                            <Legend
                              formatter={(value) => (
                                <span className="text-xs text-muted-foreground">{value}</span>
                              )}
                            />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                  </CardContent>
                </CollapsibleContent>
              </Card>
            </Collapsible>

            {/* Batch Requests Section */}
            <Collapsible open={batchExpanded} onOpenChange={setBatchExpanded}>
              <Card>
                <CollapsibleTrigger asChild>
                  <CardHeader className="cursor-pointer">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Layers className="h-5 w-5 text-primary" />
                        <CardTitle>Batch Requests</CardTitle>
                        <span className="text-sm text-muted-foreground ml-2">
                          ({formatNumber(usageData.batch.totalRequests)} batches)
                        </span>
                      </div>
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                        {batchExpanded ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </CardHeader>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <CardContent>
                    {/* Summary Stats */}
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
                      <Card className="bg-muted/50">
                        <CardContent className="p-4">
                          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                            <TrendingUp className="h-4 w-4" />
                            Total Batches
                          </div>
                          <div className="text-2xl font-bold">
                            {formatNumber(usageData.batch.totalRequests)}
                          </div>
                        </CardContent>
                      </Card>
                      <Card className="bg-muted/50">
                        <CardContent className="p-4">
                          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                            <XCircle className="h-4 w-4" />
                            Errors
                          </div>
                          <div className="text-2xl font-bold">
                            {formatNumber(usageData.batch.totalErrors)} ({usageData.batch.errorRate}%)
                          </div>
                        </CardContent>
                      </Card>
                      <Card className="bg-muted/50">
                        <CardContent className="p-4">
                          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                            <Clock className="h-4 w-4" />
                            Avg Latency
                          </div>
                          <div className="text-2xl font-bold">
                            {usageData.batch.avgLatency !== null ? (
                              `${usageData.batch.avgLatency}ms`
                            ) : (
                              <span className="text-muted-foreground text-lg">-</span>
                            )}
                          </div>
                        </CardContent>
                      </Card>
                      <Card className="bg-muted/50">
                        <CardContent className="p-4">
                          <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                            <Layers className="h-4 w-4" />
                            Avg Batch Size
                          </div>
                          <div className="text-2xl font-bold">
                            {usageData.batch.avgBatchSize} reqs
                          </div>
                        </CardContent>
                      </Card>
                    </div>

                    {/* Table and Pie Chart */}
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                      {/* Methods Table */}
                      <div className="border rounded-lg overflow-hidden">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Batch Composition</TableHead>
                              <TableHead className="text-right">Requests</TableHead>
                              <TableHead className="text-right">Errors</TableHead>
                              <TableHead className="text-right">Avg Latency</TableHead>
                              <TableHead className="text-right">Share</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {usageData.batch.methods.map((method, index) => (
                              <TableRow key={method.method}>
                                <TableCell className="font-mono text-sm">
                                  <div className="flex items-start gap-2">
                                    <div
                                      className="w-3 h-3 rounded-full mt-1 flex-shrink-0"
                                      style={{ backgroundColor: COLORS[index % COLORS.length] }}
                                    />
                                    <div className="whitespace-pre-line">
                                      {method.method}
                                    </div>
                                  </div>
                                </TableCell>
                                <TableCell className="text-right">
                                  {formatNumber(method.requests)}
                                </TableCell>
                                <TableCell className="text-right">
                                  {formatNumber(method.errors)} ({method.errorRate}%)
                                </TableCell>
                                <TableCell className="text-right">
                                  {method.avgLatency !== null ? `${method.avgLatency}ms` : '-'}
                                </TableCell>
                                <TableCell className="text-right">{method.percentage}%</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>

                      {/* Pie Chart */}
                      <div className="h-[300px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie
                              data={usageData.batch.methods}
                              dataKey="requests"
                              nameKey="method"
                              cx="50%"
                              cy="50%"
                              outerRadius={100}
                            >
                              {usageData.batch.methods.map((entry, index) => (
                                <Cell key={entry.method} fill={COLORS[index % COLORS.length]} />
                              ))}
                            </Pie>
                            <Tooltip content={<CustomPieTooltip />} />
                            <Legend
                              formatter={(value) => (
                                <span className="text-xs text-muted-foreground whitespace-pre-line" title={value}>
                                  {value}
                                </span>
                              )}
                            />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                    </div>

                  </CardContent>
                </CollapsibleContent>
              </Card>
            </Collapsible>
          </div>
        ) : (
          <Card>
            <CardContent className="py-12 text-center">
              <p className="text-muted-foreground">No usage data available.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </ProtectedRoute>
  );
}
