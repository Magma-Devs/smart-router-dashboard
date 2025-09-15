'use client';

// React imports
import { useState, useEffect, useCallback } from 'react';
import Image from 'next/image';

// UI component imports
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ChevronDown, Info, Globe, RefreshCw, ArrowDown } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

// Application imports
import { chains, getChainLabel, getChainIcon } from '@/app/config/chains';
import { useConfig } from '@/hooks/use-config';
import { KPIData, KPICardProps } from '@/types/metrics';
import { MetricsService, ChainMetrics } from '@/services/metricsService';
import { TIME_FRAMES, DEFAULT_TIME_FRAME } from '@/constants/timeFrames';
import { getUptimeColorName, getReachabilityColorName, getLatencyColorName } from '@/utils/colors';

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
 * - Real-time KPI metrics (uptime, reachability, latency)
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
          reachability: MetricsService.formatPercentage(chainMetrics.reachability), // Now using real provider reachability
          latency: MetricsService.formatLatency(chainMetrics.latency_in_ms),
        });
      } catch (error) {
        console.error('Error fetching KPI data:', error);
        setKpiData({
          uptime: 'Error',
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
      // Add visual feedback with a slight delay for better UX
      const button = document.querySelector('[data-scroll-button="metrics"]');
      if (button) {
        button.classList.add('animate-pulse');
        setTimeout(() => button.classList.remove('animate-pulse'), 1000);
      }
      
      // Enhanced scroll with better easing
      metricsSection.scrollIntoView({ 
        behavior: 'smooth',
        block: 'start',
        inline: 'nearest'
      });
    }
  };

  return (
    <TooltipProvider>
      <Card className='mb-6'>
        <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-4'>
          <CardTitle>Summary</CardTitle>
          <div className='flex flex-wrap items-center gap-2'>
              {/* Chain Selection */}
              <Select
                value={selectedChain}
                onValueChange={handleChainSelect}
                disabled={isLoadingChains}
              >
                <SelectTrigger className='w-[200px] bg-background border-border hover:bg-accent'>
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
                <SelectTrigger className='w-[140px] bg-background border-border hover:bg-accent'>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className='max-h-[15rem]'>
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
                className='bg-background border-border hover:bg-accent'
              >
                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              </Button>
          </div>
        </CardHeader>
        <CardContent className='p-6'>
          <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-4'>
            <KPICard
              title='Uptime'
              value={kpiData.uptime}
              color={getUptimeColorName(kpiData.uptime)}
              isLoading={isLoading}
            />
            <KPICard
              title='Reachability'
              value={kpiData.reachability}
              color={getReachabilityColorName(kpiData.reachability)}
              isLoading={isLoading}
              showInfo={true}
              tooltipText='Percentage of healthy providers available to each consumer. Unlike Uptime (consumer health), this measures provider availability. High uptime can be maintained even with lower reachability if available providers handle the load.'
            />
            <KPICard
              title='Latency'
              value={kpiData.latency}
              color={getLatencyColorName(kpiData.latency)}
              isLoading={isLoading}
            />
          </div>

          <div className='flex justify-end'>
            <Button
              variant='outline'
              size='sm'
              onClick={handleScrollToMetrics}
              data-scroll-button='metrics'
              className='flex items-center gap-2 bg-background border-border hover:bg-accent hover:border-primary/50 transition-all duration-200'
            >
              <ArrowDown className='h-4 w-4' />
              <span className='text-sm font-medium'>In-Depth Metrics</span>
            </Button>
          </div>
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
