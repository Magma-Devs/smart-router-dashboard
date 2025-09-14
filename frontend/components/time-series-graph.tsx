'use client';

import { useState, useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { format } from 'date-fns';
import type { ProcessedMetric } from '@/lib/types';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useRouter, useSearchParams } from 'next/navigation';
import { RefreshCw } from 'lucide-react';
import { chains, getChainLabel, getChainIcon } from '@/app/config/chains';
import { TooltipProps } from 'recharts';
import type { NameType, ValueType } from 'recharts/types/component/DefaultTooltipContent';

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

export function TimeSeriesGraph({
  data,
  onRefresh,
  title = 'Total Requests Served Per Chain',
  isLatency = false,
}: TimeSeriesGraphProps) {
  const [timeRange, setTimeRange] = useState(15);
  const [selectedSpec, setSelectedSpec] = useState<string>('all');
  const [selectedProvider, setSelectedProvider] = useState<string>('all');

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
    setSelectedProvider('all'); // Reset provider when chain changes
  };

  const handleProviderChange = (provider: string) => {
    setSelectedProvider(provider);
  };

  // Custom tooltip content component
  const CustomTooltip = ({
    active,
    payload,
    label,
    maxWidth = 440,
  }: TooltipProps<ValueType, NameType> & { maxWidth?: number }) => {
    if (!active || !payload || payload.length === 0) return null;
    // Determine if we are in provider mode (selectedSpec !== 'all' && !isLatency)
    const isProviderMode = selectedSpec !== 'all' && !isLatency;
    return (
      <div
        style={{
          backgroundColor: 'rgb(24, 24, 27)',
          border: '1px solid rgb(63, 63, 70)',
          borderRadius: '0.5rem',
          padding: '0.75rem',
          color: 'rgb(244, 244, 245)',
          width: maxWidth,
          minWidth: 320,
          maxWidth: maxWidth,
          wordBreak: 'break-all',
          whiteSpace: 'pre-line',
        }}
      >
        <div
          style={{ color: 'rgb(161, 161, 170)', marginBottom: '0.5rem', fontSize: '0.875rem' }}
        >{`Time: ${label}`}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {payload.map((entry: any) => {
            const chain = chains.find(c => c.label === entry.name);
            const icon = chain ? chain.icon : '';
            const value = entry.value;
            const formattedValue = isLatency
              ? `${value.toLocaleString()} ms`
              : `${value.toLocaleString()} requests`;
            // Use the color from colorMap if available
            const color = colorMap.get(entry.name) || 'rgb(244, 244, 245)';
            return (
              <div
                key={entry.name}
                style={{
                  display: 'grid',
                  gridTemplateColumns: isProviderMode ? '1fr 120px' : '24px 1fr 120px',
                  alignItems: 'center',
                  minWidth: 0,
                }}
              >
                {!isProviderMode && (
                  <img
                    src={icon}
                    alt={entry.name}
                    style={{ width: 16, height: 16, marginRight: 8, justifySelf: 'center' }}
                  />
                )}
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    marginRight: 8,
                    color,
                  }}
                >
                  {entry.name}
                </span>
                <span
                  style={{
                    textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums',
                    fontFeatureSettings: '"tnum"',
                    overflowWrap: 'break-word',
                    color,
                  }}
                >
                  {formattedValue}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Get unique specs for the selector
  const specs = useMemo(
    () =>
      Array.from(new Set(data?.data?.result?.map(item => item.metric.spec) ?? [])).sort((a, b) =>
        a.localeCompare(b),
      ),
    [data],
  );

  // Get unique providers for the selected spec
  const providers = useMemo(() => {
    if (!data?.data?.result) return [];
    if (selectedSpec === 'all') return [];
    const filtered = data.data.result.filter(item => item.metric.spec === selectedSpec);
    return ['all', ...Array.from(new Set(filtered.map(item => item.metric.service)))];
  }, [data, selectedSpec]);

  let chartData: any[] = [];
  let legendNames: string[] = [];
  const colorMap = new Map<string, string>();

  // Define a modern, visually appealing color palette
  const palette = [
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
    '#22D3EE', // Cyan
    '#A3E635', // Lime
    '#F87171', // Red
    '#34D399', // Green
    '#F472B6', // Fuchsia
    '#60A5FA', // Light Blue
    '#FACC15', // Gold
    '#A21CAF', // Purple
    '#0EA5E9', // Sky
    '#FDE68A', // Light Yellow
  ];

  if (isLatency) {
    // For latency, show only the selected chain if not 'all', otherwise show all chains
    const chainMap: Record<string, { [timestamp: string]: number }> = {};
    (data?.data?.result ?? []).forEach(series => {
      const spec = series.metric.spec;
      if (selectedSpec !== 'all' && spec !== selectedSpec) return;
      if (!chainMap[spec]) chainMap[spec] = {};
      series.values.forEach(([timestamp, value]) => {
        const ts = new Date(timestamp * 1000).toLocaleTimeString();
        chainMap[spec][ts] = (chainMap[spec][ts] || 0) + parseFloat(value);
      });
    });
    // Build chartData
    const allTimestamps = Array.from(
      new Set(Object.values(chainMap).flatMap(obj => Object.keys(obj))),
    ).sort();
    chartData = allTimestamps.map(ts => {
      const row: any = { timestamp: ts };
      Object.keys(chainMap).forEach(spec => {
        row[getChainLabel(spec)] = chainMap[spec][ts] || 0;
      });
      return row;
    });
    legendNames = Object.keys(chainMap).map(getChainLabel);
    legendNames.forEach((name, idx) => colorMap.set(name, palette[idx % palette.length]));
  } else if (selectedSpec === 'all') {
    // Aggregate by chain (sum all providers for each chain)
    const chainMap: Record<string, { [timestamp: string]: number }> = {};
    (data?.data?.result ?? []).forEach(series => {
      const spec = series.metric.spec;
      if (!chainMap[spec]) chainMap[spec] = {};
      series.values.forEach(([timestamp, value]) => {
        const ts = new Date(timestamp * 1000).toLocaleTimeString();
        chainMap[spec][ts] = (chainMap[spec][ts] || 0) + parseFloat(value);
      });
    });
    // Build chartData
    const allTimestamps = Array.from(
      new Set(Object.values(chainMap).flatMap(obj => Object.keys(obj))),
    ).sort();
    chartData = allTimestamps.map(ts => {
      const row: any = { timestamp: ts };
      Object.keys(chainMap).forEach(spec => {
        row[getChainLabel(spec)] = chainMap[spec][ts] || 0;
      });
      return row;
    });
    legendNames = Object.keys(chainMap).map(getChainLabel);
    legendNames.forEach((name, idx) => colorMap.set(name, palette[idx % palette.length]));
  } else {
    // Show breakdown by provider for the selected chain (requests only)
    const filtered = (data?.data?.result ?? []).filter(
      item =>
        item.metric.spec === selectedSpec &&
        (selectedProvider === 'all' || item.metric.service === selectedProvider),
    );
    legendNames = Array.from(new Set(filtered.map(item => item.metric.service)));
    legendNames.forEach((name, idx) => colorMap.set(name, palette[idx % palette.length]));
    // Build chartData
    const providerMap: Record<string, { [timestamp: string]: number }> = {};
    filtered.forEach(series => {
      const provider = series.metric.service;
      if (!providerMap[provider]) providerMap[provider] = {};
      series.values.forEach(([timestamp, value]) => {
        const ts = new Date(timestamp * 1000).toLocaleTimeString();
        providerMap[provider][ts] = parseFloat(value);
      });
    });
    const allTimestamps = Array.from(
      new Set(Object.values(providerMap).flatMap(obj => Object.keys(obj))),
    ).sort();
    chartData = allTimestamps.map(ts => {
      const row: any = { timestamp: ts };
      legendNames.forEach(provider => {
        row[provider] = providerMap[provider][ts] || 0;
      });
      return row;
    });
  }

  return (
    <Card>
      <CardHeader className='flex flex-row items-center justify-between'>
        <CardTitle>{title}</CardTitle>
        <div className='flex items-center space-x-4'>
          {selectedSpec !== 'all' && !isLatency && (
            <Select value={selectedProvider} onValueChange={handleProviderChange}>
              <SelectTrigger className='w-[180px]'>
                <SelectValue placeholder='Select Provider' />
              </SelectTrigger>
              <SelectContent>
                {providers.map(provider => (
                  <SelectItem key={provider} value={provider}>
                    {provider === 'all' ? 'All Providers' : provider}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={selectedSpec} onValueChange={handleSpecChange}>
            <SelectTrigger className='w-[240px]'>
              <SelectValue placeholder='Select Chain' />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='all'>All Chains</SelectItem>
              {specs.map(spec => (
                <SelectItem key={spec} value={spec}>
                  <div className='flex items-center gap-2'>
                    <img src={getChainIcon(spec)} alt={getChainLabel(spec)} className='w-4 h-4' />
                    {getChainLabel(spec)}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className='flex space-x-2'>
            <Button
              variant={timeRange === 5 ? 'default' : 'outline'}
              onClick={() => handleTimeRangeChange('5')}
              size='sm'
            >
              5m
            </Button>
            <Button
              variant={timeRange === 15 ? 'default' : 'outline'}
              onClick={() => handleTimeRangeChange('15')}
              size='sm'
            >
              15m
            </Button>
            <Button
              variant={timeRange === 30 ? 'default' : 'outline'}
              onClick={() => handleTimeRangeChange('30')}
              size='sm'
            >
              30m
            </Button>
            <Button
              variant={timeRange === 60 ? 'default' : 'outline'}
              onClick={() => handleTimeRangeChange('60')}
              size='sm'
            >
              1h
            </Button>
          </div>
          <Button variant='outline' size='sm' onClick={handleRefresh} className='ml-2'>
            <RefreshCw className='h-4 w-4' />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className='h-[300px]'>
          <ResponsiveContainer width='100%' height='100%'>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray='3 3' />
              <XAxis dataKey='timestamp' tick={{ fontSize: 12 }} interval='preserveStartEnd' />
              <YAxis />
              <Tooltip content={<CustomTooltip maxWidth={440} />} />
              <Legend verticalAlign='bottom' height={36} formatter={value => value} />
              {legendNames.map(name => (
                <Line
                  key={name}
                  type='monotone'
                  dataKey={name}
                  stroke={colorMap.get(name) || `hsl(${Math.random() * 360}, 70%, 50%)`}
                  dot={false}
                  name={name}
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
