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
import { MetricsService, ChainMetrics, DashboardSummaryMetrics } from '@/services/metricsService';
import { TIME_FRAMES, DEFAULT_TIME_FRAME } from '@/constants/timeFrames';
import {
  getUptimeColorName,
  getReachabilityColorName,
  getLatencyColorName,
  getCacheHitColorName,
  getErrorRecoveryColorName,
  getRequestsColorName,
} from '@/utils/colors';

/**
 * KPI Card component that displays individual metric values with color-coded status.
 *
 * @param props - KPICardProps containing title, value, color, and optional tooltip
 * @returns JSX.Element A card displaying the KPI metric
 */
function KPICard({ title, value, color, tooltip, isLoading, showInfo, tooltipText }: KPICardProps) {
  const colorClasses: Record<string, string> = {
    green: 'text-green-600',
    orange: 'text-orange-600',
    red: 'text-red-600',
    grey: 'text-muted-foreground',
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
 * KPI Card component for displaying recovered/total errors with subscript format.
 * Shows the recovered count prominently with total as a smaller subscript.
 */
interface RecoveredErrorsKPICardProps {
  title: string;
  data: { recovered: string; total: string } | string;
  color: 'green' | 'orange' | 'red' | 'grey';
  isLoading?: boolean;
  showInfo?: boolean;
  tooltipText?: string;
}

function RecoveredErrorsKPICard({
  title,
  data,
  color,
  isLoading,
  showInfo,
  tooltipText,
}: RecoveredErrorsKPICardProps) {
  const colorClasses: Record<string, string> = {
    green: 'text-green-600',
    orange: 'text-orange-600',
    red: 'text-red-600',
    grey: 'text-muted-foreground',
  };

  const isObject = typeof data === 'object' && data !== null;

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
          ) : isObject ? (
            <span className='text-2xl font-bold'>
              <span className={colorClasses[color]}>{data.recovered}</span>
              <span className='text-muted-foreground'> / </span>
              <span className={colorClasses[color]}>{data.total}</span>
            </span>
          ) : (
            <span className={`text-2xl font-bold ${colorClasses[color]}`}>{data}</span>
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
  const [availableRouters, setAvailableRouters] = useState<Array<{ id: string; network: string }>>(
    [],
  );
  const [selectedRouter, setSelectedRouter] = useState<string>('all');
  const [selectedNetwork, setSelectedNetwork] = useState<string>('all');
  const [isLoadingRouters, setIsLoadingRouters] = useState(false);
  const [kpiData, setKpiData] = useState<KPIData>({
    uptime: 'N/A',
    reachability: 'N/A',
    latency: 'N/A',
    totalRequests: 'N/A',
    cacheHitRate: 'N/A',
    recoveredNodeErrors: 'N/A',
  });
  const [isLoading, setIsLoading] = useState(false);
  const [selectedTimeFrame, setSelectedTimeFrame] = useState<string>(DEFAULT_TIME_FRAME);

  /**
   * Fetches KPI data for the specified router and time frame.
   * Handles both individual router data and aggregated "all routers" data.
   *
   * @param routerValue - The router identifier or "all" for aggregated data
   * @param timeFrame - Time frame string (e.g., "1h", "30m") for the metrics query
   * @param networkValue - Optional network/spec to filter dashboard summary metrics
   */
  const fetchKPIData = useCallback(
    async (routerValue: string, timeFrame: string, networkValue?: string) => {
      setIsLoading(true);

      if (!config.apiEndpoint) {
        setKpiData({
          uptime: 'Error',
          reachability: 'Error',
          latency: 'Error',
          totalRequests: 'Error',
          cacheHitRate: 'Error',
          recoveredNodeErrors: 'Error',
        });
        setIsLoading(false);
        return;
      }

      try {
        // Convert time frame string to minutes
        const timeWindowMinutes = MetricsService.convertTimeFrameToMinutes(timeFrame);
        const stepSize = timeWindowMinutes <= 60 ? 1 : timeWindowMinutes <= 240 ? 5 : 15;

        // Determine the network filter for dashboard summary
        // Use the specific network if provided, otherwise undefined for all networks
        const networkFilter = networkValue && networkValue !== 'all' ? networkValue : undefined;

        // Fetch router metrics and dashboard summary in parallel
        const [routerMetricsResult, dashboardSummary] = await Promise.all([
          (async () => {
            let chainMetrics: ChainMetrics;
            if (routerValue === 'all') {
              // For "all routers", use the avg data from the backend
              const chainsResponse = await MetricsService.fetchMetricsForAllChains(
                timeWindowMinutes,
                stepSize,
              );
              chainMetrics = chainsResponse.avg;
            } else {
              // For specific router, fetch individual router data
              const chainResponse = await MetricsService.fetchMetricsForChain(
                routerValue,
                timeWindowMinutes,
                stepSize,
              );
              chainMetrics = chainResponse;
            }
            return chainMetrics;
          })(),
          MetricsService.fetchDashboardSummary(timeWindowMinutes, networkFilter).catch(err => {
            console.warn('Failed to fetch dashboard summary:', err);
            return null;
          }),
        ]);

        // Update KPI data with formatted values
        setKpiData({
          uptime: MetricsService.formatPercentage(routerMetricsResult.uptime),
          reachability: MetricsService.formatPercentage(routerMetricsResult.reachability),
          latency: MetricsService.formatLatency(routerMetricsResult.latency_in_ms),
          totalRequests: dashboardSummary
            ? MetricsService.formatTraffic(dashboardSummary.total_requests)
            : 'N/A',
          cacheHitRate: dashboardSummary
            ? MetricsService.formatCacheHitRate(dashboardSummary.cache_hit_rate)
            : 'N/A',
          recoveredNodeErrors: dashboardSummary
            ? MetricsService.formatRecoveredNodeErrors(
                dashboardSummary.error_recovery.recovered_requests,
                dashboardSummary.error_recovery.total_node_errors,
              )
            : 'N/A',
        });
      } catch (error) {
        console.error('Error fetching KPI data:', error);
        setKpiData({
          uptime: 'Error',
          reachability: 'Error',
          latency: 'Error',
          totalRequests: 'Error',
          cacheHitRate: 'Error',
          recoveredNodeErrors: 'Error',
        });
      } finally {
        setIsLoading(false);
      }
    },
    [config.apiEndpoint],
  );

  /**
   * Fetches available routers from the metrics API on mount.
   * Populates the router selection dropdown with routers that have actual metrics data.
   * This is more efficient and accurate than using the components API.
   */
  useEffect(() => {
    const fetchAvailableRouters = async () => {
      if (!config.apiEndpoint) {
        return;
      }

      setIsLoadingRouters(true);
      try {
        // Use a minimal time window (1 minute) just to get available routers
        const chainsResponse = await MetricsService.fetchMetricsForAllChains(1, 1);

        // Extract router data with both ID and network for icon lookup
        const routersData = Object.entries(chainsResponse.chains).map(
          ([chainId, chainMetrics]: [string, any]) => ({
            id: chainId,
            network: chainMetrics.network,
          }),
        );
        setAvailableRouters(routersData);

        // Default network selection to 'all' only on initial load
        setSelectedNetwork('all');
      } catch (error) {
        console.error('Error fetching available routers:', error);
        setAvailableRouters([]);
      } finally {
        setIsLoadingRouters(false);
      }
    };

    fetchAvailableRouters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.apiEndpoint]);

  /**
   * Effect to trigger data fetch when parameters change.
   */
  useEffect(() => {
    fetchKPIData(selectedRouter, selectedTimeFrame, selectedNetwork);
  }, [selectedRouter, selectedTimeFrame, selectedNetwork, fetchKPIData]);

  /**
   * Handles router selection change from the dropdown.
   * @param routerValue - The selected router identifier
   */
  const handleRouterSelect = (routerValue: string) => {
    setSelectedRouter(routerValue);
    fetchKPIData(routerValue, selectedTimeFrame, selectedNetwork);
  };

  // When network changes, show routers selector when there are multiple routers for this network.
  const handleNetworkSelect = (networkValue: string) => {
    setSelectedNetwork(networkValue);
    if (networkValue === 'all') {
      // Keep backend behavior the same: aggregate over all routers
      setSelectedRouter('all');
      fetchKPIData('all', selectedTimeFrame, 'all');
      return;
    }
    const routersForNetwork = availableRouters.filter(c => c.network === networkValue);
    if (routersForNetwork.length === 0) {
      setSelectedRouter('all');
      fetchKPIData('all', selectedTimeFrame, networkValue);
    } else if (routersForNetwork.length === 1) {
      // Auto-select the single router
      setSelectedRouter(routersForNetwork[0].id);
      fetchKPIData(routersForNetwork[0].id, selectedTimeFrame, networkValue);
    } else {
      // Multiple routers: default to 'all' (backend aggregates all routers)
      setSelectedRouter('all');
      // Additionally fetch router metrics filtered by chosen network to aggregate KPIs
      (async () => {
        try {
          const minutes = MetricsService.convertTimeFrameToMinutes(selectedTimeFrame);
          const step = minutes <= 60 ? 1 : minutes <= 240 ? 5 : 15;
          const [chainsResponse, dashboardSummary] = await Promise.all([
            MetricsService.fetchMetricsForAllChains(minutes, step, networkValue),
            MetricsService.fetchDashboardSummary(minutes, networkValue).catch(err => {
              console.warn('Failed to fetch dashboard summary:', err);
              return null;
            }),
          ]);
          const chainMetrics = chainsResponse.avg;
          setKpiData({
            uptime: MetricsService.formatPercentage(chainMetrics.uptime),
            reachability: MetricsService.formatPercentage(chainMetrics.reachability),
            latency: MetricsService.formatLatency(chainMetrics.latency_in_ms),
            totalRequests: dashboardSummary
              ? MetricsService.formatTraffic(dashboardSummary.total_requests)
              : 'N/A',
            cacheHitRate: dashboardSummary
              ? MetricsService.formatCacheHitRate(dashboardSummary.cache_hit_rate)
              : 'N/A',
            recoveredNodeErrors: dashboardSummary
              ? MetricsService.formatRecoveredNodeErrors(
                  dashboardSummary.error_recovery.recovered_requests,
                  dashboardSummary.error_recovery.total_node_errors,
                )
              : 'N/A',
          });
        } catch (e) {
          fetchKPIData('all', selectedTimeFrame, networkValue);
        }
      })();
    }
  };

  /**
   * Handles time frame selection change.
   * @param value - The selected time frame string (e.g., "1h", "30m")
   */
  const handleTimeFrameChange = (value: string) => {
    setSelectedTimeFrame(value);
    fetchKPIData(selectedRouter, value, selectedNetwork);
  };

  /**
   * Handles manual refresh button click.
   * Triggers immediate data refresh for current selection.
   */
  const handleRefresh = () => {
    fetchKPIData(selectedRouter, selectedTimeFrame, selectedNetwork);
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
        inline: 'nearest',
      });
    }
  };

  return (
    <TooltipProvider>
      <Card className='mb-6'>
        <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-4'>
          <CardTitle>Summary</CardTitle>
          <div className='flex flex-wrap items-center gap-2'>
            {/* Router Selection (appears when a network with multiple routers is chosen) */}
            {selectedNetwork !== 'all' &&
              availableRouters.filter(c => c.network === selectedNetwork).length > 1 && (
                <Select
                  value={selectedRouter}
                  onValueChange={handleRouterSelect}
                  disabled={isLoadingRouters}
                >
                  <SelectTrigger className='w-[200px] bg-background border-border hover:bg-accent'>
                    <SelectValue placeholder={isLoadingRouters ? 'Loading...' : 'Select router'} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='all'>
                      <div className='flex items-center gap-2'>
                        {(() => {
                          const chainConfig = chains.find(c => c.value === selectedNetwork);
                          const icon = chainConfig
                            ? chainConfig.icon
                            : getChainIcon(selectedNetwork);
                          const label = chainConfig
                            ? chainConfig.label
                            : getChainLabel(selectedNetwork);
                          return icon ? (
                            <Image
                              src={icon}
                              alt={label}
                              width={16}
                              height={16}
                              className='rounded-full'
                            />
                          ) : (
                            <Globe className='h-4 w-4' />
                          );
                        })()}
                        All Routers
                      </div>
                    </SelectItem>
                    {availableRouters
                      .filter(router => router.network === selectedNetwork)
                      .map(router => (
                        <SelectItem key={router.id} value={router.id}>
                          <div className='flex items-center gap-2'>
                            {(() => {
                              const chainConfig = chains.find(c => c.value === selectedNetwork);
                              const icon = chainConfig
                                ? chainConfig.icon
                                : getChainIcon(selectedNetwork);
                              const label = chainConfig
                                ? chainConfig.label
                                : getChainLabel(selectedNetwork);
                              return icon ? (
                                <Image
                                  src={icon}
                                  alt={label}
                                  width={16}
                                  height={16}
                                  className='rounded-full'
                                />
                              ) : null;
                            })()}
                            <span className='text-sm'>{router.id}</span>
                          </div>
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              )}

            {/* Network Selection (aggregated) */}
            <Select
              value={selectedNetwork}
              onValueChange={handleNetworkSelect}
              disabled={isLoadingRouters}
            >
              <SelectTrigger className='w-[200px] bg-background border-border hover:bg-accent'>
                <SelectValue placeholder={isLoadingRouters ? 'Loading...' : 'Select network'} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='all'>
                  <div className='flex items-center gap-2'>
                    <Globe className='h-4 w-4' />
                    All Networks
                  </div>
                </SelectItem>
                {Array.from(new Set(availableRouters.map(c => c.network))).map(network => {
                  const chainConfig = chains.find(c => c.value === network);
                  const label = chainConfig ? chainConfig.label : getChainLabel(network);
                  const icon = chainConfig ? chainConfig.icon : getChainIcon(network);
                  return (
                    <SelectItem key={network} value={network}>
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
            {/* Row 1 */}
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
              tooltipText='Percentage of healthy nodes available to each router. Unlike Uptime (router health), this measures node availability. High uptime can be maintained even with lower reachability if available nodes handle the load.'
            />
            <KPICard
              title='Total Requests'
              value={kpiData.totalRequests || 'N/A'}
              color={getRequestsColorName(kpiData.totalRequests)}
              isLoading={isLoading}
            />
            {/* Row 2 */}
            <KPICard
              title='Cache Hit Rate'
              value={selectedNetwork !== 'all' ? 'N/A' : kpiData.cacheHitRate || 'N/A'}
              color={getCacheHitColorName(
                selectedNetwork !== 'all' ? undefined : kpiData.cacheHitRate,
              )}
              isLoading={isLoading}
            />
            <RecoveredErrorsKPICard
              title='Recovered / Node Errors'
              data={kpiData.recoveredNodeErrors || 'N/A'}
              color={getErrorRecoveryColorName(kpiData.recoveredNodeErrors)}
              isLoading={isLoading}
              showInfo={true}
              tooltipText='Number of node errors successfully recovered vs total node errors received from nodes. Higher recovery means better fault tolerance.'
            />
            <KPICard
              title='Latency'
              value={kpiData.latency}
              color={getLatencyColorName(kpiData.latency)}
              isLoading={isLoading}
              showInfo={true}
              tooltipText='p50 (median) latency across all requests in the selected time window.'
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
