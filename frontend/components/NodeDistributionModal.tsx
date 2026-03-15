'use client';

import { useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { MetricsService } from '@/services/metricsService';
import { PieChart } from '@mui/x-charts/PieChart';

export interface NodeDistributionItem {
  provider: string;
  requests: number;
  successful: number;
  failed: number;
  successRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p90LatencyMs: number;
  p95LatencyMs: number;
  trafficShare: number;
}

/** @deprecated Use NodeDistributionItem */
export type ProviderDistributionItem = NodeDistributionItem;

interface NodeDistributionModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chainId: string;
  responses: Array<{
    status_code: number;
    latency_ms: number;
    success: boolean;
    headers?: Record<string, string>;
  }>;
  allNodes: string[]; // all nodes configured for this router
}

export function NodeDistributionModal({
  open,
  onOpenChange,
  chainId,
  responses,
  allNodes,
}: NodeDistributionModalProps) {
  const PIE_CHART_COLORS = [
    '#3b82f6', // Blue
    '#10b981', // Green
    '#f59e0b', // Orange
    '#8b5cf6', // Purple
    '#ef4444', // Red
    '#06b6d4', // Cyan
    '#eab308', // Yellow
    '#ec4899', // Pink
  ];
  const [sortKey, setSortKey] = useState<
    'trafficShare' | 'successRate' | 'avgLatencyMs' | 'requests'
  >('trafficShare');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const items = useMemo<NodeDistributionItem[]>(() => {
    const grouped = MetricsService.groupLoadTestByProvider(responses);

    // Show only providers that actually responded (no zero-filling)
    return grouped.sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1;
      if (sortKey === 'avgLatencyMs') return (a.avgLatencyMs - b.avgLatencyMs) * dir;
      if (sortKey === 'successRate') return (a.successRate - b.successRate) * dir;
      if (sortKey === 'requests') return (a.requests - b.requests) * dir;
      return (a.trafficShare - b.trafficShare) * dir;
    });
  }, [responses, sortKey, sortDir]);

  // Prepare data for MUI X PieChart
  const chartData = useMemo(() => {
    return items.map((item, idx) => ({
      id: idx,
      value: item.trafficShare,
      label: item.provider,
    }));
  }, [items]);

  const headerCell = (label: string, key: typeof sortKey) => (
    <TableHead
      className='cursor-pointer select-none'
      onClick={() => {
        if (sortKey === key) setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'));
        else {
          setSortKey(key);
          setSortDir('desc');
        }
      }}
    >
      {label} {sortKey === key ? (sortDir === 'asc' ? '▲' : '▼') : ''}
    </TableHead>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-6xl w-[1100px]'>
        <DialogHeader>
          <DialogTitle>Node distribution – {chainId}</DialogTitle>
        </DialogHeader>

        {/* Donut chart for traffic share */}
        <div className='space-y-2 mb-6'>
          <div className='text-sm text-muted-foreground'>Traffic share distribution</div>
          <div className='h-80 w-full flex items-center justify-center'>
            <PieChart
              series={[
                {
                  data: chartData,
                  innerRadius: 0,
                  outerRadius: 120,
                  paddingAngle: 1,
                  highlightScope: { fade: 'global', highlight: 'item' },
                  faded: { innerRadius: 0, additionalRadius: -10 },
                  valueFormatter: (value: any) => {
                    // Extract the actual numeric value from the data object
                    const numValue =
                      typeof value === 'object' && value?.value ? value.value : value;
                    const numericValue = Number(numValue);
                    if (isNaN(numericValue)) {
                      console.warn('NaN value detected in pie chart:', value);
                      return '0%';
                    }
                    return `${numericValue.toFixed(1)}%`;
                  },
                },
              ]}
              colors={PIE_CHART_COLORS}
              slotProps={{
                legend: {
                  position: { vertical: 'middle', horizontal: 'end' },
                },
              }}
              sx={{
                '& .MuiChartsLegend-label': { color: '#ffffff' },
                '& .MuiChartsLegend-root': { color: '#ffffff' },
              }}
              width={600}
              height={320}
            />
          </div>
        </div>

        {/* Cached counted as provider "cached"; no separate summary */}

        <div className='border rounded-md'>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Node</TableHead>
                {headerCell('Requests', 'requests')}
                {headerCell('Success %', 'successRate')}
                {headerCell('Avg latency', 'avgLatencyMs')}
                <TableHead>P50</TableHead>
                <TableHead>P90</TableHead>
                <TableHead>P95</TableHead>
                {headerCell('Traffic %', 'trafficShare')}
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map(item => (
                <TableRow key={item.provider}>
                  <TableCell className='font-medium'>{item.provider}</TableCell>
                  <TableCell>{item.requests}</TableCell>
                  <TableCell>{MetricsService.formatPercentage(item.successRate)}</TableCell>
                  <TableCell>{MetricsService.formatLatency(item.avgLatencyMs)}</TableCell>
                  <TableCell>{MetricsService.formatLatency(item.p50LatencyMs)}</TableCell>
                  <TableCell>{MetricsService.formatLatency(item.p90LatencyMs)}</TableCell>
                  <TableCell>{MetricsService.formatLatency(item.p95LatencyMs)}</TableCell>
                  <TableCell>{item.trafficShare.toFixed(1)}%</TableCell>
                </TableRow>
              ))}
              {items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className='text-center text-muted-foreground'>
                    No data
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** @deprecated Use NodeDistributionModal */
export const ProviderDistributionModal = NodeDistributionModal;

export default NodeDistributionModal;
