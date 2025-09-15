'use client';

// React imports
import { useEffect, useState } from 'react';
import Link from 'next/link';

// UI component imports
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AlertTriangle, Settings, RefreshCw, ChevronUp, ChevronDown } from 'lucide-react';

// Application component imports
import { FlowVisualization } from '@/components/flow-visualization';
import { SummarySection } from '@/components/summary-section';
import { InDepthMetrics } from '@/components/in-depth-metrics';
import { ProtectedRoute } from '@/components/protected-route';

// Hook and utility imports
import { useConfig } from '@/hooks/use-config';
import { apiClient } from '@/lib/api-client';
import { chains } from '@/app/config/chains';
import { ChainsToProvidersResponse } from '@/types/metrics';

/**
 * Type definitions for Prometheus API responses
 */

/** Represents a Prometheus metric with optional spec and dynamic properties */
interface PrometheusMetric {
  spec?: string;
  [key: string]: any;
}

/** Represents a single result from Prometheus query */
interface PrometheusResult {
  metric: PrometheusMetric;
  values?: [number, string][]; // For range queries
  value?: [number, string]; // For instant queries
  [key: string]: any;
}

/** Container for Prometheus query results */
interface PrometheusData {
  resultType: string;
  result: PrometheusResult[];
}

/** Complete Prometheus API response */
interface PrometheusResponse {
  status: 'success' | 'error';
  data?: PrometheusData;
  errorType?: string;
  error?: string;
}

/** Dashboard data structure containing flow visualization data */
interface DashboardData {
  flow: ChainsToProvidersResponse | null;
}

/**
 * Main Dashboard component that displays system metrics and health status.
 *
 * Features:
 * - Real-time metrics visualization
 * - Configurable refresh intervals
 * - System flow visualization
 * - Summary KPI section
 * - In-depth metrics analysis
 *
 * @returns JSX.Element The complete dashboard interface
 */
export default function Dashboard() {
  // State management
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [flowExpanded, setFlowExpanded] = useState(false);

  // Configuration hook
  const { config, updateRefreshInterval } = useConfig();

  /**
   * Effect to initialize data fetching and set up automatic refresh polling.
   * Runs when API endpoint or refresh interval changes.
   */
  useEffect(() => {
    if (config.apiEndpoint) {
      fetchData();
    } else {
      setError(
        'No API endpoint configured. Please set up an API endpoint in the configuration page.',
      );
      setLoading(false);
    }

    // Set up polling based on refresh interval
    const intervalMs = (config.refreshInterval || 60) * 1000;
    const interval = setInterval(() => {
      fetchData();
    }, intervalMs);

    return () => {
      clearInterval(interval);
    };
  }, [config.apiEndpoint, config.refreshInterval]);

  /**
   * Fetches dashboard data from the API endpoint.
   * Handles flow visualization data and maps chain labels.
   */
  const fetchData = async () => {
    setLoading(true);
    setError(null);

    try {
      if (!config.apiEndpoint) {
        setError(
          'No API endpoint configured. Please set up an API endpoint in the configuration page.',
        );
        setLoading(false);
        return;
      }

      // Fetch flow visualization data using the new chains-to-providers endpoint
      const flowEndpoint = `/api/metrics/chains-to-providers?minutes=1&step=1`;
      const flowData = await apiClient.get<ChainsToProvidersResponse>(flowEndpoint);

      setData({
        flow: flowData,
      });
      setLastUpdated(new Date());
    } catch (err) {
      console.error('Error fetching data:', err);
      setError(`Failed to connect to API: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Handles refresh interval change from the UI select component.
   * @param value - The new refresh interval in seconds as a string
   */
  const handleRefreshIntervalChange = (value: string) => {
    const numValue = parseInt(value, 10);
    updateRefreshInterval(numValue);
  };

  /**
   * Handles manual refresh button click.
   * Triggers immediate data fetch.
   */
  const handleManualRefresh = () => {
    fetchData();
  };

  /**
   * Renders loading, error, or empty states for visualization components.
   * @param height - CSS height class for the container
   * @returns JSX.Element | null
   */
  const renderContent = (height = 'h-96') => {
    if (loading) {
      return (
        <div className={`flex items-center justify-center ${height}`}>
          <div className='animate-spin rounded-full h-12 w-12 border-b-2 border-primary'></div>
        </div>
      );
    }

    if (!data) {
      return (
        <div className={`flex flex-col items-center justify-center ${height} gap-4 text-center`}>
          <AlertTriangle className='h-12 w-12 text-muted-foreground' />
          <div className='max-w-md'>
            <h3 className='text-lg font-semibold mb-2'>No data available</h3>
            <p className='text-muted-foreground mb-4'>
              {error ||
                'Check your API endpoint configuration or ensure the API server is running.'}
            </p>
            <Link href='/configuration'>
              <Button variant='outline' size='sm'>
                <Settings className='mr-2 h-4 w-4' />
                Go to Configuration
              </Button>
            </Link>
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <ProtectedRoute>
      <div className='container mx-auto px-4 py-6 max-w-7xl'>
        <div className='mb-8'>
          <h1 className='text-3xl font-bold'>Dashboard</h1>
          {lastUpdated && (
            <p className='text-sm text-muted-foreground mt-1'>
              Last updated: {lastUpdated.toLocaleTimeString()}
            </p>
          )}
        </div>

        {error && (
          <Alert variant='destructive' className='mb-6'>
            <AlertTriangle className='h-4 w-4' />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className='space-y-6'>
          <SummarySection />


          <Card>
            <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-4'>
              <div>
                <CardTitle>System Flow Visualization</CardTitle>
                <CardDescription>
                  Visualizing the health status between Users, Chains, and Providers
                </CardDescription>
              </div>
              <div className='flex flex-wrap items-center gap-2'>
                {/* Auto-refresh Interval Selection */}
                <Select value={config.refreshInterval.toString()} onValueChange={handleRefreshIntervalChange}>
                  <SelectTrigger className='w-[180px] bg-background border-border hover:bg-accent'>
                    <SelectValue placeholder='Auto-refresh every' />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='1'>1 second</SelectItem>
                    <SelectItem value='5'>5 seconds</SelectItem>
                    <SelectItem value='10'>10 seconds</SelectItem>
                    <SelectItem value='30'>30 seconds</SelectItem>
                    <SelectItem value='60'>1 minute</SelectItem>
                    <SelectItem value='300'>5 minutes</SelectItem>
                  </SelectContent>
                </Select>

                {/* Refresh Button */}
                <Button
                  variant='outline'
                  size='sm'
                  onClick={handleManualRefresh}
                  disabled={loading}
                  title='Refresh flow data'
                  className='bg-background border-border hover:bg-accent'
                >
                  <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                </Button>

                {/* Expand All Button */}
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => setFlowExpanded(prev => !prev)}
                  title={flowExpanded ? 'Collapse all providers' : 'Expand all providers'}
                  className='bg-background border-border hover:bg-accent'
                >
                  {flowExpanded ? (
                    <>
                      <ChevronUp className='h-4 w-4 mr-1' />
                      <span>Collapse All</span>
                    </>
                  ) : (
                    <>
                      <ChevronDown className='h-4 w-4 mr-1' />
                      <span>Expand All</span>
                    </>
                  )}
                </Button>
              </div>
            </CardHeader>
            <CardContent className='p-0 overflow-hidden'>
              {renderContent() ||
                (data?.flow?.chains && (
                  <FlowVisualization key='flow-visualization' data={data.flow} isAllExpanded={flowExpanded} />
                ))}
            </CardContent>
          </Card>

          <InDepthMetrics />
        </div>
      </div>
    </ProtectedRoute>
  );
}
