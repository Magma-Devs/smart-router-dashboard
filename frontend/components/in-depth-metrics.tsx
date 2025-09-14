'use client';

// React imports
import { useState, useEffect, useCallback } from 'react';

// UI component imports
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RefreshCw, AlertTriangle } from 'lucide-react';

// Application component imports
import { MetricsTable } from '@/components/MetricsTable';
import { TabNavigation } from '@/components/TabNavigation';

// Hook and utility imports
import { useConfig } from '@/hooks/use-config';
import { useSorting } from '@/hooks/useSorting';
import { useDataFetching } from '@/hooks/useDataFetching';
import { getChainLabel } from '@/app/config/chains';

// Type and service imports
import { MetricsData } from '@/types/metrics';
import { MetricsService } from '@/services/metricsService';
import { TIME_FRAMES, DEFAULT_TIME_FRAME } from '@/constants/timeFrames';

/**
 * Type definitions for component API responses
 */

/** Component props interface */
interface InDepthMetricsProps {}

/**
 * In-Depth Metrics component that provides detailed metrics analysis for chains and providers.
 *
 * Features:
 * - Tabbed interface (Chains/Providers)
 * - Sortable data tables
 * - Time frame selection
 * - Real-time data fetching
 * - Automatic data refresh on tab/time frame changes
 *
 * @returns JSX.Element The complete in-depth metrics interface
 */
export function InDepthMetrics({}: InDepthMetricsProps) {
  // Configuration and core state
  const { config } = useConfig();
  const [activeTab, setActiveTab] = useState<'chains' | 'providers'>('chains');
  const [selectedTimeFrame, setSelectedTimeFrame] = useState(DEFAULT_TIME_FRAME);

  // Available options state
  const [availableChains, setAvailableChains] = useState<string[]>([]);
  const [availableProviders, setAvailableProviders] = useState<string[]>([]);
  const [isLoadingComponents, setIsLoadingComponents] = useState(false);

  // Custom hooks for data management
  const { sortField, sortDirection, handleSort, sortData } = useSorting();
  const { data, loading, error, fetchData } = useDataFetching<MetricsData>();

  /**
   * Fetches available chains and providers from the metrics APIs.
   * This populates the dropdown options with chains/providers that have actual metrics data.
   * More efficient and accurate than using the components API.
   */
  const fetchComponents = async () => {
    if (!config.apiEndpoint) {
      return;
    }

    setIsLoadingComponents(true);
    try {
      // Use minimal time windows (1 minute) just to get available chains and providers
      const [chainsResponse, providersResponse] = await Promise.all([
        MetricsService.fetchMetricsForAllChains(1, 1),
        MetricsService.fetchMetricsForAllProviders(1, 1),
      ]);

      // Extract available chains and providers from metrics responses
      const chainKeys = Object.keys(chainsResponse.chains);
      const providerKeys = Object.keys(providersResponse.providers);

      setAvailableChains(chainKeys);
      setAvailableProviders(providerKeys);
    } catch (error) {
      console.error('Error fetching available chains and providers:', error);
      setAvailableChains([]);
      setAvailableProviders([]);
    } finally {
      setIsLoadingComponents(false);
    }
  };

  /**
   * Fetches metrics data based on current selections (time frame, available chains/providers).
   * Handles both real API data and error states.
   */
  const handleFetchData = useCallback(async () => {
    await fetchData(async () => {
      try {
        // Convert time frame to minutes for API calls
        const timeFrameMinutes = MetricsService.convertTimeFrameToMinutes(selectedTimeFrame);
        const stepSize = Math.max(1, Math.floor(timeFrameMinutes / 60)); // 1 minute steps for up to 1 hour, then scale up

        // Fetch real metrics using the new simplified backend APIs
        const [chainsResponse, providersResponse] = await Promise.all([
          MetricsService.fetchMetricsForAllChains(timeFrameMinutes, stepSize),
          MetricsService.fetchMetricsForAllProviders(timeFrameMinutes, stepSize),
        ]);

        // Get available chains and providers from API responses
        const chainsFromApi = Object.keys(chainsResponse.chains);
        const providersFromApi = Object.keys(providersResponse.providers);

        // Build the response data structure
        const realData = {
          chains: chainsFromApi.map(chainValue => ({
            chain: getChainLabel(chainValue),
            latest_block: MetricsService.formatLatestBlock(
              chainsResponse.chains[chainValue].latest_block,
            ),
            traffic: MetricsService.formatTraffic(
              chainsResponse.chains[chainValue].requests_per_day,
            ),
            uptime: MetricsService.formatPercentage(chainsResponse.chains[chainValue].uptime),
            latency: MetricsService.formatLatency(chainsResponse.chains[chainValue].latency_in_ms),
          })),
          providers: providersFromApi.map(providerValue => ({
            provider: providerValue,
            latest_block: MetricsService.formatLatestBlock(
              providersResponse.providers[providerValue].latest_block,
            ),
            traffic: MetricsService.formatTraffic(
              providersResponse.providers[providerValue].requests_per_day,
            ),
            uptime: MetricsService.formatPercentage(
              providersResponse.providers[providerValue].uptime,
            ),
            latency: MetricsService.formatLatency(
              providersResponse.providers[providerValue].latency_in_ms,
            ),
            sync: MetricsService.formatPercentage(
              providersResponse.providers[providerValue].uptime,
            ), // Using uptime as proxy for sync
          })),
          selectedChain: 'All Chains',
          selectedProvider: 'All Providers',
          timeFrame: selectedTimeFrame,
        };

        return realData;
      } catch (error) {
        console.error('Error fetching metrics data:', error);
        // Return empty data structure on error
        return {
          chains: [],
          providers: [],
          selectedChain: 'All Chains',
          selectedProvider: 'All Providers',
          timeFrame: selectedTimeFrame,
        };
      }
    });
  }, [selectedTimeFrame, fetchData]);

  /**
   * Effect to fetch components data on initial mount.
   * This runs once when the component is first rendered.
   */
  useEffect(() => {
    fetchComponents();
    // Fetch data immediately on mount, even before components are loaded
    handleFetchData();
  }, []);

  /**
   * Effect to refetch data when time frame or active tab changes.
   * This ensures fresh data when user changes selections.
   */
  useEffect(() => {
    // Refetch data when time frame or active tab changes
    handleFetchData();
  }, [selectedTimeFrame, activeTab, handleFetchData]);

  /**
   * Handles manual refresh button click.
   * Refreshes both component data and metrics data.
   */
  const handleRefresh = () => {
    fetchComponents();
    handleFetchData();
  };

  /**
   * Handles time frame selection change.
   * @param value - The selected time frame string (e.g., "1h", "24h")
   */
  const handleTimeFrameChange = (value: string) => {
    setSelectedTimeFrame(value);
  };

  /**
   * Renders error state when data fetching fails.
   * @returns JSX.Element Error display with retry option
   */
  if (error) {
    return (
      <Card>
        <CardContent className='p-6'>
          <div className='flex flex-col items-center justify-center text-center space-y-4'>
            <AlertTriangle className='h-12 w-12 text-destructive' />
            <div>
              <h3 className='text-lg font-semibold'>Error Loading Data</h3>
              <p className='text-muted-foreground mt-1'>{error}</p>
            </div>
            <Button onClick={handleRefresh} variant='outline'>
              <RefreshCw className='mr-2 h-4 w-4' />
              Try Again
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-section='metrics'>
      <CardHeader>
        <div className='flex items-center justify-between'>
          <div>
            <CardTitle>In-Depth Metrics</CardTitle>
            <CardDescription>Detailed performance metrics for chains and providers</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className='flex items-center justify-between mb-6'>
          <TabNavigation activeTab={activeTab} onTabChange={setActiveTab} />

          <div className='flex items-center gap-4'>
            {/* Time Frame Selection */}
            <Select value={selectedTimeFrame} onValueChange={handleTimeFrameChange}>
              <SelectTrigger className='w-[140px]'>
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
              disabled={loading}
              title='Refresh data'
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>

        {/* Metrics Table */}
        {data && (data.providers.length > 0 || data.chains.length > 0) ? (
          <MetricsTable
            data={activeTab === 'providers' ? sortData(data.providers) : sortData(data.chains)}
            type={activeTab}
            sortField={sortField}
            sortDirection={sortDirection}
            onSort={handleSort}
          />
        ) : loading ? (
          <div className='flex items-center justify-center py-12'>
            <div className='animate-spin rounded-full h-8 w-8 border-b-2 border-primary'></div>
            <span className='ml-3 text-muted-foreground'>Loading metrics...</span>
          </div>
        ) : (
          <div className='flex flex-col items-center justify-center py-12 text-center'>
            <AlertTriangle className='h-8 w-8 text-muted-foreground mb-2' />
            <p className='text-muted-foreground'>No data available for the selected time frame.</p>
            <Button variant='outline' size='sm' onClick={handleRefresh} className='mt-3'>
              <RefreshCw className='mr-2 h-4 w-4' />
              Refresh
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
