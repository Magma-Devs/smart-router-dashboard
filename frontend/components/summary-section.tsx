'use client';

// React imports
import { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';

// UI component imports
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ChevronDown, Info, Globe, RefreshCw } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

// Application imports
import { chains, getChainLabel, getChainIcon } from '@/app/config/chains';
import { useConfig } from '@/hooks/use-config';
import { KPIData, KPICardProps } from '@/types/metrics';
import { MetricsService, ChainMetrics } from '@/services/metricsService';
import { TIME_FRAMES, DEFAULT_TIME_FRAME } from '@/constants/timeFrames';

/**
 * Type definitions for API responses
 */

/**
 * Color determination functions for KPI metrics
 * These functions determine the visual status (green/orange/red) based on metric values
 */

/**
 * Determines color for uptime metrics based on percentage thresholds.
 * @param value - The uptime value as a string (e.g., "99.5%")
 * @returns Color classification: "green" (≥99.5%), "orange" (≥95%), "red" (<95%)
 */
const getUptimeColor = (value: string): 'green' | 'orange' | 'red' => {
  if (value === 'Error' || value === 'N/A') return 'red';
  const numericValue = parseFloat(value.replace('%', ''));
  if (isNaN(numericValue)) return 'red';
  if (numericValue >= 99.5) return 'green';
  if (numericValue >= 95) return 'orange';
  return 'red';
};

/**
 * Determines color for freshness metrics based on percentage thresholds.
 * @param value - The freshness value as a string (e.g., "95.0%")
 * @returns Color classification: "green" (≥95%), "orange" (≥85%), "red" (<85%)
 */
const getFreshnessColor = (value: string): 'green' | 'orange' | 'red' => {
  if (value === 'Error' || value === 'N/A') return 'red';
  const numericValue = parseFloat(value.replace('%', ''));
  if (isNaN(numericValue)) return 'red';
  if (numericValue >= 95) return 'green';
  if (numericValue >= 85) return 'orange';
  return 'red';
};

/**
 * Determines color for reachability metrics based on percentage thresholds.
 * @param value - The reachability value as a string (e.g., "90.0%")
 * @returns Color classification: "green" (≥95%), "orange" (≥85%), "red" (<85%)
 */
const getReachabilityColor = (value: string): 'green' | 'orange' | 'red' => {
  if (value === 'Error' || value === 'N/A') return 'red';
  const numericValue = parseFloat(value.replace('%', ''));
  if (isNaN(numericValue)) return 'red';
  if (numericValue >= 95) return 'green';
  if (numericValue >= 85) return 'orange';
  return 'red';
};

/**
 * Determines color for latency metrics based on millisecond thresholds.
 * @param value - The latency value as a string (e.g., "150ms")
 * @returns Color classification: "green" (≤200ms), "orange" (≤500ms), "red" (>500ms)
 */
const getLatencyColor = (value: string): 'green' | 'orange' | 'red' => {
  if (value === 'Error' || value === 'N/A') return 'red';
  const numericValue = parseFloat(value.replace('ms', ''));
  if (isNaN(numericValue)) return 'red';
  if (numericValue <= 200) return 'green';
  if (numericValue <= 500) return 'orange';
  return 'red';
};

/**
 * KPI Card component that displays individual metric values with color-coded status.
 *
 * @param props - KPICardProps containing title, value, color, and optional tooltip
 * @returns JSX.Element A card displaying the KPI metric
 */
function KPICard({ title, value, color, tooltip, isLoading, showInfo, tooltipText }: KPICardProps) {
  const colorClasses = {
    green: 'text-green-600',
    orange: 'text-orange-600',
    red: 'text-red-600',
  };

  return (
    <Card className='flex-1'>
      <CardContent className='p-4'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <span className='text-sm font-medium text-muted-foreground'>{title}</span>
            {showInfo && tooltipText && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className='h-3 w-3 text-muted-foreground' />
                </TooltipTrigger>
                <TooltipContent>
                  <p className='max-w-xs text-xs'>{tooltipText}</p>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
        <div className='mt-2'>
          {isLoading ? (
            <div className='h-8 w-16 bg-muted animate-pulse rounded' />
          ) : (
            <span className={`text-2xl font-bold ${colorClasses[color]}`}>{value}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Component props interface
 */
interface SummarySectionProps {}

/**
 * Summary Section component that displays key performance indicators (KPIs) for the selected chain.
 *
 * Features:
 * - Chain selection dropdown
 * - Real-time KPI metrics (uptime, freshness, reachability, latency)
 * - Time window selection
 * - Automatic data refresh
 * - Color-coded status indicators
 *
 * @returns JSX.Element The complete summary section with KPI cards
 */
export function SummarySection({}: SummarySectionProps) {
  // Configuration and state management
  const { config } = useConfig();
  const [availableChains, setAvailableChains] = useState<string[]>([]);
  const [selectedChain, setSelectedChain] = useState<string>('all');
  const [isLoadingChains, setIsLoadingChains] = useState(false);
  const [kpiData, setKpiData] = useState<KPIData>({
    uptime: 'N/A',
    freshness: 'N/A',
    reachability: 'N/A',
    latency: 'N/A',
  });
  const [isLoading, setIsLoading] = useState(false);
  const [selectedTimeFrame, setSelectedTimeFrame] = useState<string>(DEFAULT_TIME_FRAME);

  /**
   * Fetches KPI data for the specified chain and time frame.
   * Handles both individual chain data and aggregated "all chains" data.
   *
   * @param chainValue - The chain identifier or "all" for aggregated data
   * @param timeFrame - Time frame string (e.g., "1h", "30m") for the metrics query
   */
  const fetchKPIData = useCallback(
    async (chainValue: string, timeFrame: string) => {
      setIsLoading(true);

      if (!config.apiEndpoint) {
        setKpiData({
          uptime: 'Error',
          freshness: 'Error',
          reachability: 'Error',
          latency: 'Error',
        });
        setIsLoading(false);
        return;
      }

      try {
        // Convert time frame string to minutes
        const timeWindowMinutes = MetricsService.convertTimeFrameToMinutes(timeFrame);
        const stepSize = timeWindowMinutes <= 60 ? 1 : timeWindowMinutes <= 240 ? 5 : 15;

        let chainMetrics: ChainMetrics;

        if (chainValue === 'all') {
          // For "all chains", use the avg data from the backend
          const chainsResponse = await MetricsService.fetchMetricsForAllChains(
            timeWindowMinutes,
            stepSize,
          );
          chainMetrics = chainsResponse.avg;
        } else {
          // For specific chain, fetch individual chain data
          const chainResponse = await MetricsService.fetchMetricsForChain(
            chainValue,
            timeWindowMinutes,
            stepSize,
          );
          chainMetrics = chainResponse;
        }

        // Update KPI data with formatted values
        setKpiData({
          uptime: MetricsService.formatPercentage(chainMetrics.uptime),
          freshness: MetricsService.formatPercentage(chainMetrics.freshness),
          reachability: MetricsService.formatPercentage(chainMetrics.reachability), // Now using real provider reachability
          latency: MetricsService.formatLatency(chainMetrics.latency_in_ms),
        });
      } catch (error) {
        console.error('Error fetching KPI data:', error);
        setKpiData({
          uptime: 'Error',
          freshness: 'Error',
          reachability: 'Error',
          latency: 'Error',
        });
      } finally {
        setIsLoading(false);
      }
    },
    [config.apiEndpoint],
  );

  /**
   * Fetches available chains from the metrics API.
   * Populates the chain selection dropdown with chains that have actual metrics data.
   * This is more efficient and accurate than using the components API.
   */
  useEffect(() => {
    const fetchAvailableChains = async () => {
      if (!config.apiEndpoint) {
        return;
      }

      setIsLoadingChains(true);
      try {
        // Use a minimal time window (1 minute) just to get available chains
        const chainsResponse = await MetricsService.fetchMetricsForAllChains(1, 1);
        const chainKeys = Object.keys(chainsResponse.chains);
        setAvailableChains(chainKeys);
      } catch (error) {
        console.error('Error fetching available chains:', error);
        setAvailableChains([]);
      } finally {
        setIsLoadingChains(false);
      }
    };

    fetchAvailableChains();
    fetchKPIData('all', selectedTimeFrame);
  }, [config.apiEndpoint, fetchKPIData, selectedTimeFrame]);

  /**
   * Effect to trigger data fetch when parameters change.
   */
  useEffect(() => {
    fetchKPIData(selectedChain, selectedTimeFrame);
  }, [selectedChain, selectedTimeFrame, fetchKPIData]);

  /**
   * Handles chain selection change from the dropdown.
   * @param chainValue - The selected chain identifier
   */
  const handleChainSelect = (chainValue: string) => {
    setSelectedChain(chainValue);
    fetchKPIData(chainValue, selectedTimeFrame);
  };

  /**
   * Handles time frame selection change.
   * @param value - The selected time frame string (e.g., "1h", "30m")
   */
  const handleTimeFrameChange = (value: string) => {
    setSelectedTimeFrame(value);
    fetchKPIData(selectedChain, value);
  };

  /**
   * Handles manual refresh button click.
   * Triggers immediate data refresh for current selection.
   */
  const handleRefresh = () => {
    fetchKPIData(selectedChain, selectedTimeFrame);
  };

  const handleScrollToMetrics = () => {
    const metricsSection = document.querySelector('[data-section="metrics"]');
    if (metricsSection) {
      metricsSection.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <TooltipProvider>
      <Card className='mb-6'>
        <CardContent className='p-6'>
          <div className='flex items-center justify-between mb-4'>
            <h2 className='text-lg font-semibold'>Summary</h2>

            <div className='flex flex-wrap items-center gap-2'>
              {/* Chain Selection */}
              <Select
                value={selectedChain}
                onValueChange={handleChainSelect}
                disabled={isLoadingChains}
              >
                <SelectTrigger className='w-[200px]'>
                  <SelectValue placeholder={isLoadingChains ? 'Loading...' : 'Select chain'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value='all'>
                    <div className='flex items-center gap-2'>
                      <Globe className='h-4 w-4' />
                      All Chains
                    </div>
                  </SelectItem>
                  {availableChains.map(chainValue => {
                    const chainConfig = chains.find(c => c.value === chainValue);
                    const label = chainConfig ? chainConfig.label : getChainLabel(chainValue);
                    const icon = chainConfig ? chainConfig.icon : getChainIcon(chainValue);

                    return (
                      <SelectItem key={chainValue} value={chainValue}>
                        <div className='flex items-center gap-2'>
                          {icon && (
                            <Image
                              src={icon}
                              alt={label}
                              width={16}
                              height={16}
                              className='rounded-full'
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
                <SelectTrigger className='w-[140px]'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIME_FRAMES.map(timeFrame => (
                    <SelectItem key={timeFrame.value} value={timeFrame.value}>
                      {timeFrame.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Refresh Button */}
              <Button
                variant='outline'
                size='sm'
                onClick={handleRefresh}
                disabled={isLoading}
                title='Refresh metrics'
              >
                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>

          <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4'>
            <KPICard
              title='Uptime'
              value={kpiData.uptime}
              color={getUptimeColor(kpiData.uptime)}
              isLoading={isLoading}
            />
            <KPICard
              title='Reachability'
              value={kpiData.reachability}
              color={getReachabilityColor(kpiData.reachability)}
              isLoading={isLoading}
              showInfo={true}
              tooltipText='Percentage of healthy providers available to each consumer. Unlike Uptime (consumer health), this measures provider availability. High uptime can be maintained even with lower reachability if available providers handle the load.'
            />
            <KPICard
              title='Latency'
              value={kpiData.latency}
              color={getLatencyColor(kpiData.latency)}
              isLoading={isLoading}
            />
            <KPICard
              title='Data Freshness'
              value={kpiData.freshness}
              color={getFreshnessColor(kpiData.freshness)}
              isLoading={isLoading}
            />
          </div>

          <div className='flex justify-end'>
            <Button
              variant='ghost'
              size='sm'
              onClick={handleScrollToMetrics}
              className='flex items-center gap-2'
            >
              <ChevronDown className='h-4 w-4' />
            </Button>
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
