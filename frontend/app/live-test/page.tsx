'use client';

import { useState, useEffect, useMemo } from 'react';
import { useConfig } from '@/hooks/use-config';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/use-toast';
import { Toaster } from '@/components/ui/toaster';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Copy,
  Loader2,
  BarChart3,
  Play,
  Check,
  Shield,
  Server,
  Timer,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Circle,
  Layers,
  Plus,
  Trash2,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { chains } from '@/app/config/chains';
import { cn } from '@/lib/utils';
import { chainTypes } from '@/app/config/chain-types';
import { ProtectedRoute } from '@/components/protected-route';
import { apiClient } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { getChainIcon, getChainLabel } from '@/app/config/chains';
import { MetricsService } from '@/services/metricsService';
import ProviderDistributionModal from '@/components/ProviderDistributionModal';
import {
  makeTestRequest,
  makeLoadTestRequests,
  calculateLoadTestStats,
  makeBatchRequest,
  makeBatchLoadTestRequests,
  calculateBatchLoadTestStats,
  generateBatchCurlCommand,
  BatchRequestItem,
  BatchResponse,
} from '@/lib/test-client';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface ApiResponse {
  consumers: {
    [key: string]: {
      network: string;
      interfaces: string[];
      providers: Array<{
        name: string;
        endpoints: Array<{
          url: string;
          interface: string;
          addons: string[];
        }>;
        auth_config?: any;
      }>;
    };
  };
  resource_limits: {
    server: { cpu: number; memory: number };
    per_consumer: { cpu: number; memory: number };
    per_provider: { cpu: number; memory: number };
  };
}

interface LiveTestResult {
  success_rate: number;
  total_requests: number;
  successful_requests: number;
  failed_requests: number;
  latency_stats: {
    min: number;
    max: number;
    avg: number;
    p50: number;
    p90: number;
    p95: number;
  };
  cached_count?: number;
  non_cached_count?: number;
  provider_distribution?: Record<string, number>;
  responses: Array<{
    status_code: number;
    latency_ms: number;
    success: boolean;
    response_data?: any;
    error?: string;
    headers?: Record<string, string>;
  }>;
}

export default function LiveTestPage() {
  const { config } = useConfig();
  const { isAuthenticated, loading: authLoading } = useAuth();
  // id + network of real chains with metrics
  const [availableChains, setAvailableChains] = useState<Array<{ id: string; network: string }>>(
    [],
  );

  // Helper function to get network from chain ID
  const getNetworkFromChainId = (chainId: string): string | null => {
    if (!apiData?.consumers?.[chainId]) return null;
    return apiData.consumers[chainId].network;
  };
  const [selectedNetwork, setSelectedNetwork] = useState<string>('');
  const [selectedChain, setSelectedChain] = useState<string>('');
  const [selectedInterface, setSelectedInterface] = useState<string>('');
  const [selectedRequestType, setSelectedRequestType] = useState<
    'regular' | 'archive' | 'debug' | 'trace'
  >('regular');
  const [response, setResponse] = useState<string>('');
  const [singleTestStatus, setSingleTestStatus] = useState<number | null>(null);
  const [singleTestLatency, setSingleTestLatency] = useState<number | null>(null);
  const [singleTestProvider, setSingleTestProvider] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [curlCommand, setCurlCommand] = useState<string>('');
  const [crossValidationCurlCommand, setCrossValidationCurlCommand] = useState<string>('');
  const [endpointUrl, setEndpointUrl] = useState<string>('');
  const [configuredInterfaces, setConfiguredInterfaces] = useState<string[]>([]);
  const [configuredRequestTypes, setConfiguredRequestTypes] = useState<string[]>([]);
  const [apiData, setApiData] = useState<ApiResponse | null>(null);

  // Load test state
  const [numberOfRequests, setNumberOfRequests] = useState<number>(50);
  const [concurrency, setConcurrency] = useState<number>(5);
  const [isLoadTesting, setIsLoadTesting] = useState(false);
  const [loadTestResult, setLoadTestResult] = useState<LiveTestResult | null>(null);
  const [copiedResponseIndex, setCopiedResponseIndex] = useState<number | null>(null);
  const [copiedEndpoint, setCopiedEndpoint] = useState(false);
  const [copiedCurl, setCopiedCurl] = useState(false);
  const [copiedSingleResponse, setCopiedSingleResponse] = useState(false);
  const [copiedSummary, setCopiedSummary] = useState(false);
  const [responseFilter, setResponseFilter] = useState<'successful' | 'failed'>('successful');
  const [skipCache, setSkipCache] = useState<boolean>(false);
  const [isDistributionOpen, setIsDistributionOpen] = useState(false);
  const [singleTestHeaders, setSingleTestHeaders] = useState<Record<string, string> | null>(null);
  const [singleHeadersExpanded, setSingleHeadersExpanded] = useState<boolean>(false);
  const [singleResponseTruncated, setSingleResponseTruncated] = useState<boolean>(false);

  // Load test headers state - track which responses have expanded headers
  const [loadTestExpandedHeaders, setLoadTestExpandedHeaders] = useState<Set<number>>(new Set());

  // Cross validation headers state
  const [crossValidationHeadersExpanded, setCrossValidationHeadersExpanded] =
    useState<boolean>(false);
  const [crossValidationResponseTruncated, setCrossValidationResponseTruncated] =
    useState<boolean>(false);

  const tryPrettifyJsonString = (input: string, maxParseChars: number = 200_000): string => {
    if (typeof input !== 'string') return String(input);
    if (input.length > maxParseChars) return input;
    try {
      const parsed = JSON.parse(input);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return input;
    }
  };

  const getSafeResponseCaps = (type: 'regular' | 'archive' | 'debug' | 'trace') => {
    // Trace/debug can return very large payloads; keep caps tighter to protect the UI.
    if (type === 'trace' || type === 'debug') {
      return { maxResponseBytes: 128 * 1024, maxResponseChars: 100_000 };
    }
    return { maxResponseBytes: 512 * 1024, maxResponseChars: 250_000 };
  };

  // Helper: prettify header values that contain JSON or escaped JSON
  const parseHeaderValue = (val: string): any => {
    if (typeof val !== 'string') return val;
    
    // Keep numeric strings as strings to avoid precision loss with large integers
    if (/^-?\d+$/.test(val)) {
      return val;
    }
    
    const tryParse = (s: string) => {
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    };
    // Try direct JSON
    const direct = tryParse(val);
    if (direct !== null) return direct;
    // Try unescaped JSON (values sometimes come double-escaped)
    const unescaped = val.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const unescapedParsed = tryParse(unescaped);
    return unescapedParsed !== null ? unescapedParsed : val;
  };
  const prettifyHeaders = (headers?: Record<string, string> | null) => {
    if (!headers) return null;
    const parsed: Record<string, any> = {};
    for (const [k, v] of Object.entries(headers)) parsed[k] = parseHeaderValue(v);
    return parsed;
  };

  // Helper: combine body + headers (as "headers") when expanded
  const buildMergedResponse = (
    body: string,
    headers?: Record<string, string> | null,
    includeHeaders?: boolean,
  ) => {
    let bodyValue: any = body;
    if (typeof body === 'string') {
      try {
        bodyValue = JSON.parse(body);
      } catch {
        /* keep as-is */
      }
    }
    if (!includeHeaders) {
      return typeof bodyValue === 'string' ? bodyValue : JSON.stringify(bodyValue, null, 2);
    }
    const prettyHeaders = prettifyHeaders(headers);
    if (bodyValue && typeof bodyValue === 'object') {
      const merged: any = { ...bodyValue };
      if (prettyHeaders) merged.headers = prettyHeaders;
      return JSON.stringify(merged, null, 2);
    }
    const wrapped: any = { body: bodyValue };
    if (prettyHeaders) wrapped.headers = prettyHeaders;
    return JSON.stringify(wrapped, null, 2);
  };

  const getStatusIcon = (status: number) => {
    if (status >= 200 && status < 300) return <CheckCircle2 className='h-4 w-4 text-green-600' />;
    if (status >= 400 && status < 500) return <AlertTriangle className='h-4 w-4 text-yellow-600' />;
    if (status >= 500) return <XCircle className='h-4 w-4 text-red-600' />;
    return <Circle className='h-4 w-4 text-slate-400' />;
  };

  const getStatusColor = (status: number) => {
    if (status >= 200 && status < 300) return 'text-green-600';
    if (status >= 400 && status < 500) return 'text-yellow-600';
    if (status >= 500) return 'text-red-600';
    return 'text-slate-400';
  };

  const renderInlineJson = (
    body: string,
    isExpanded: boolean,
    onExpand: () => void,
    headers?: Record<string, string> | null,
  ) => {
    let base = '';
    try {
      const obj = JSON.parse(body);
      const bodyStr = JSON.stringify(obj, null, 2);
      base = bodyStr;
    } catch {
      const bodyStr = JSON.stringify({ body }, null, 2);
      base = bodyStr;
    }

    return (
      <div className='space-y-4'>
        {/* Response Body */}
        <div>
          <div className='text-sm font-medium text-muted-foreground mb-2'>Response Body</div>
          <pre className='rounded-lg bg-muted p-4 font-mono text-sm overflow-x-auto whitespace-pre-wrap break-all'>
            <code>{base}</code>
          </pre>
        </div>

        {/* Response Headers */}
        {headers && Object.keys(headers).length > 0 && (
          <div>
            <div className='text-sm font-medium text-muted-foreground mb-2'>Response Headers</div>
            <pre className='rounded-lg bg-muted p-4 font-mono text-sm overflow-x-auto whitespace-pre-wrap break-all'>
              <code>
                {isExpanded ? (
                  JSON.stringify(prettifyHeaders(headers), null, 2)
                ) : (
                  <>
                    <span
                      className='cursor-pointer'
                      onClick={onExpand}
                      title='Click to expand headers'
                    >
                      {`{ … }`}
                    </span>
                  </>
                )}
              </code>
            </pre>
          </div>
        )}
      </div>
    );
  };

  // Cross validation state
  const [crossValidationMin, setCrossValidationMin] = useState<number>(1);
  const [crossValidationMax, setCrossValidationMax] = useState<number>(5);
  const [crossValidationRate, setCrossValidationRate] = useState<number>(1.0);
  const [isCrossValidating, setIsCrossValidating] = useState(false);
  const [crossValidationResponse, setCrossValidationResponse] = useState<string>('');
  const [crossValidationStatus, setCrossValidationStatus] = useState<number | null>(null);
  const [crossValidationLatency, setCrossValidationLatency] = useState<number | null>(null);
  const [crossValidationProvider, setCrossValidationProvider] = useState<string | null>(null);
  const [crossValidationHeaders, setCrossValidationHeaders] = useState<Record<
    string,
    string
  > | null>(null);

  // Tab state
  const [activeTab, setActiveTab] = useState<'single' | 'load' | 'batch' | 'cross'>('single');

  // Batch test state
  const [batchMode, setBatchMode] = useState<'single' | 'load'>('single');
  const [batchRequests, setBatchRequests] = useState<BatchRequestItem[]>([
    { id: 1, method: '', params: [] },
  ]);

  // Reset batch requests when chain changes
  const resetBatchRequests = () => {
    setBatchRequests([{ id: 1, method: '', params: [] }]);
    setBatchResult(null);
    setBatchLoadTestResult(null);
  };
  const [isBatchTesting, setIsBatchTesting] = useState(false);
  const [batchResult, setBatchResult] = useState<BatchResponse | null>(null);
  const [batchLoadTestResult, setBatchLoadTestResult] = useState<ReturnType<typeof calculateBatchLoadTestStats> | null>(null);
  const [numberOfBatches, setNumberOfBatches] = useState<number>(50);
  const [batchConcurrency, setBatchConcurrency] = useState<number>(5);
  const [batchCurlCommand, setBatchCurlCommand] = useState<string>('');
  const [batchEndpointUrl, setBatchEndpointUrl] = useState<string>('');
  const [copiedBatchCurl, setCopiedBatchCurl] = useState(false);
  const [copiedBatchEndpoint, setCopiedBatchEndpoint] = useState(false);
  const [expandedBatchResponses, setExpandedBatchResponses] = useState<Set<number>>(new Set());
  const [isBatchDistributionOpen, setIsBatchDistributionOpen] = useState(false);

  // Helper function to get the base interface for command lookup
  const getCommandLookupInterface = (interfaceType: string): string => {
    if (interfaceType === 'jsonrpc/wss') return 'jsonrpc';
    if (interfaceType === 'tendermintrpc/wss') return 'tendermintrpc';
    return interfaceType;
  };

  // Derived counts: cached vs non-cached from response headers
  const { cachedCount, nonCachedCount } = useMemo(() => {
    if (!loadTestResult) return { cachedCount: 0, nonCachedCount: 0 };

    // Prefer backend-provided aggregate counts when available
    if (
      typeof loadTestResult.cached_count === 'number' &&
      typeof loadTestResult.non_cached_count === 'number'
    ) {
      return {
        cachedCount: loadTestResult.cached_count,
        nonCachedCount: loadTestResult.non_cached_count,
      };
    }

    let cached = 0;
    let nonCached = 0;

    for (const r of loadTestResult.responses) {
      if (!r.headers) {
        nonCached += 1;
        continue;
      }

      // case-insensitive header key lookup
      const headerKey = Object.keys(r.headers).find(
        k => k.toLowerCase() === 'lava-provider-address',
      );

      const value = headerKey ? r.headers[headerKey] : undefined;
      if (value && String(value).toLowerCase() === 'cached') {
        cached += 1;
      } else {
        nonCached += 1;
      }
    }

    return { cachedCount: cached, nonCachedCount: nonCached };
  }, [loadTestResult]);

  // Get the maximum number of providers across all routers in the selected network
  const maxProvidersForNetwork = useMemo(() => {
    if (!selectedNetwork || !apiData?.consumers) {
      return 10; // Default fallback
    }

    // Find all chains/routers in the selected network
    const routersInNetwork = availableChains.filter(c => c.network === selectedNetwork);

    // Find the maximum number of providers across all routers in this network
    let maxProviders = 1;
    for (const router of routersInNetwork) {
      const providers = apiData.consumers[router.id]?.providers || [];
      maxProviders = Math.max(maxProviders, providers.length);
    }

    return maxProviders;
  }, [selectedNetwork, apiData, availableChains]);

  // Get the maximum number of providers for the selected chain
  const maxProvidersForChain = useMemo(() => {
    if (!selectedChain || !apiData?.consumers?.[selectedChain]) {
      return 10; // Default fallback
    }
    const providers = apiData.consumers[selectedChain].providers || [];
    return Math.max(providers.length, 1); // At least 1
  }, [selectedChain, apiData]);

  // Check if batch is supported for the current chain (requires jsonrpc interface with batch config)
  const batchConfig = useMemo(() => {
    if (!selectedChain || !apiData?.consumers?.[selectedChain]) return null;
    
    const network = apiData.consumers[selectedChain].network;
    const chain = chains.find(c => c.value === network);
    if (!chain) return null;
    
    const chainType = chainTypes.find(t => t.value === chain.type);
    if (!chainType) return null;
    
    const jsonrpcInterface = chainType.interfaces.jsonrpc;
    if (!jsonrpcInterface?.batch) return null;
    
    return jsonrpcInterface.batch;
  }, [selectedChain, apiData]);

  // hasBatchSupport is for the currently selected chain
  const hasBatchSupport = batchConfig !== null;

  // Helper function to check if a chain ID supports batch requests
  const chainSupportsBatch = (chainId: string): boolean => {
    if (!apiData?.consumers?.[chainId]) return false;
    
    const network = apiData.consumers[chainId].network;
    const chain = chains.find(c => c.value === network);
    if (!chain) return false;
    
    const chainType = chainTypes.find(t => t.value === chain.type);
    if (!chainType) return false;
    
    return chainType.interfaces.jsonrpc?.batch != null;
  };

  // Filter chains that support batch
  const batchSupportedChains = useMemo(() => {
    return availableChains.filter(c => chainSupportsBatch(c.id));
  }, [availableChains, apiData]);

  // Networks that have at least one batch-supported chain
  const batchSupportedNetworks = useMemo(() => {
    return Array.from(new Set(batchSupportedChains.map(c => c.network)));
  }, [batchSupportedChains]);

  // Routers for selected network that support batch
  const batchRoutersForSelectedNetwork = useMemo(() => {
    return batchSupportedChains.filter(c => c.network === selectedNetwork);
  }, [batchSupportedChains, selectedNetwork]);

  // Whether the Batch Test tab should be shown (if ANY chain supports batch)
  const showBatchTab = batchSupportedChains.length > 0;

  // Generate batch endpoint URL and curl command
  useEffect(() => {
    if (!selectedChain || !hasBatchSupport || !config.endpointDomain || !config.endpointPort) {
      setBatchEndpointUrl('');
      setBatchCurlCommand('');
      return;
    }

    const domain = config.endpointDomain;
    const port = config.endpointPort;
    const chainIdLower = selectedChain.toLowerCase();
    const curlHost = `${chainIdLower}-jsonrpc.${domain}`;
    const endpoint = `https://${curlHost}:${port}`;
    setBatchEndpointUrl(endpoint);

    // Only generate curl if we have valid batch requests
    const validRequests = batchRequests.filter(r => r.method.trim() !== '');
    if (validRequests.length > 0) {
      const curl = generateBatchCurlCommand(
        chainIdLower,
        domain,
        port,
        validRequests,
        skipCache,
      );
      setBatchCurlCommand(curl);
    } else {
      setBatchCurlCommand('');
    }
  }, [selectedChain, hasBatchSupport, config.endpointDomain, config.endpointPort, batchRequests, skipCache]);

  useEffect(() => {
    const fetchChains = async () => {
      // Don't fetch if not authenticated or still loading auth
      if (authLoading || !isAuthenticated) {
        setIsFetching(false);
        return;
      }

      if (!config.apiEndpoint) {
        setIsFetching(false);
        return;
      }

      let componentsData: ApiResponse | null = null;

      // 1) Fetch components/interfaces data first - this is required
      try {
        componentsData = await apiClient.get<ApiResponse>(`/api/components/`);
        setApiData(componentsData);
      } catch (error) {
        console.error('Failed to fetch components:', error);
        setError(error instanceof Error ? error.message : 'Failed to fetch components');
        setIsFetching(false);
        return;
      }

      // 2) Try to get chains from metrics API, but fall back to components if it fails
      let chainsData: Array<{ id: string; network: string }> = [];

      try {
        const chainsResponse = await MetricsService.fetchMetricsForAllChains(1, 1);
        chainsData = Object.entries(chainsResponse.chains).map(
          ([chainId, chainMetrics]: [string, any]) => ({
            id: chainId,
            network: chainMetrics.network,
          }),
        );
      } catch (metricsError) {
        // Metrics API failed - fall back to using components data
        console.warn('Metrics API failed, falling back to components data:', metricsError);
        
        // Build chains list from components/consumers
        if (componentsData?.consumers) {
          chainsData = Object.entries(componentsData.consumers).map(
            ([chainId, consumer]) => ({
              id: chainId,
              network: consumer.network,
            }),
          );
        }
      }

      setAvailableChains(chainsData);

      // Default select first network if any
      if (chainsData.length > 0) {
        setSelectedNetwork(chainsData[0].network);
        const routers = chainsData.filter(c => c.network === chainsData[0].network);
        if (routers.length === 1) {
          setSelectedChain(routers[0].id);
        } else {
          setSelectedChain('');
        }
      }

      setIsFetching(false);
    };

    fetchChains();
  }, [config.apiEndpoint, isAuthenticated, authLoading]);

  // Update cross validation max/min when the network changes and provider count changes
  useEffect(() => {
    // Set max to the network's max providers when network changes
    setCrossValidationMax(maxProvidersForNetwork);

    // Adjust min if it exceeds the network's max providers
    if (crossValidationMin > maxProvidersForNetwork) {
      setCrossValidationMin(maxProvidersForNetwork);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxProvidersForNetwork]);

  // Update interfaces when chain selection changes (without refetching)
  useEffect(() => {
    if (selectedChain && apiData && apiData.consumers && apiData.consumers[selectedChain]) {
      const interfaces = apiData.consumers[selectedChain].interfaces;
      setConfiguredInterfaces(interfaces);

      // Determine available request types based on configured addons
      const availableRequestTypes = ['regular']; // regular is always available

      // Get all addons from all providers for this chain
      const allAddons = new Set<string>();
      apiData.consumers[selectedChain].providers.forEach(provider => {
        provider.endpoints.forEach(endpoint => {
          if (endpoint.addons) {
            endpoint.addons.forEach(addon => allAddons.add(addon));
          }
        });
      });

      // Add request types based on available addons
      if (allAddons.has('archive')) availableRequestTypes.push('archive');
      if (allAddons.has('debug')) availableRequestTypes.push('debug');
      if (allAddons.has('trace')) availableRequestTypes.push('trace');

      setConfiguredRequestTypes(availableRequestTypes);

      // Reset selected request type if it's not available
      if (!availableRequestTypes.includes(selectedRequestType)) {
        setSelectedRequestType('regular');
      }
    } else {
      setConfiguredInterfaces([]);
      setConfiguredRequestTypes(['regular']);
      setSelectedRequestType('regular');
    }
  }, [selectedChain, apiData, selectedRequestType]);

  useEffect(() => {
    if (selectedChain && selectedInterface && apiData && config.endpointDomain && config.endpointPort) {
      // Get the network from the API data instead of parsing chain ID
      const selectedChainData = apiData.consumers[selectedChain];
      if (!selectedChainData || !selectedChainData.network) return;

      const baseNetwork = selectedChainData.network;
      const chain = chains.find(c => c.value === baseNetwork);
      if (!chain) return;

      const chainType = chainTypes.find(t => t.value === chain.type);
      if (!chainType) return;

      // For WebSocket interfaces, use the base interface for command lookup
      const commandLookupInterface = getCommandLookupInterface(selectedInterface);
      const interfaceCommands = chainType.interfaces[commandLookupInterface];
      if (!interfaceCommands) return;

      const interfaceCommand = interfaceCommands[selectedRequestType];
      if (!interfaceCommand) return;

      const domain = config.endpointDomain;
      const port = config.endpointPort;
      const chainIdLower = selectedChain.toLowerCase();

      const curlHost = `${chainIdLower}-${commandLookupInterface}.${domain}`;
      // Use wss:// protocol with /websocket path for WebSocket connections
      const endpoint = selectedInterface.includes('/wss')
        ? `wss://${curlHost}:${port}/websocket`
        : `https://${curlHost}:${port}`;
      setEndpointUrl(endpoint);

      const headers = skipCache ? `-H "lava-force-cache-refresh: true"` : '';

      // Add lava-extension header if request type is archive, trace, or debug
      const extensionHeader =
        selectedRequestType && ['archive', 'trace', 'debug'].includes(selectedRequestType)
          ? `-H "lava-extension: ${selectedRequestType}"`
          : '';

      const allHeaders = [headers, extensionHeader].filter(Boolean).join(' ');

      let cmd: string;
      if (selectedInterface.includes('/wss')) {
        // WebSocket command
        cmd = `wscat -c wss://${curlHost}:${port}/websocket -x '${interfaceCommand}'`;
      } else if (selectedInterface === 'rest') {
        const commandData = JSON.parse(interfaceCommand);
        if (commandData.path) {
          // REST GET with path (e.g., Aptos, TON, TRON)
          cmd = `curl -X GET ${allHeaders} https://${curlHost}:${port}${commandData.path}`;
        } else {
          // REST POST with JSON body (e.g., XRP)
          cmd = `curl -X POST ${allHeaders} -H "Content-Type: application/json" https://${curlHost}:${port} -d '${interfaceCommand}'`;
        }
      } else {
        // Other interfaces (jsonrpc, tendermintrpc, etc.)
        cmd = `curl -X POST ${allHeaders} -H "Content-Type: application/json" https://${curlHost}:${port} -d '${interfaceCommand}'`;
      }
      setCurlCommand(cmd);
    }
  }, [
    selectedChain,
    selectedInterface,
    selectedRequestType,
    config.endpointDomain,
    config.endpointPort,
    skipCache,
    apiData,
  ]);

  // Generate cross-validation specific curl command with quorum headers
  useEffect(() => {
    if (selectedChain && selectedInterface && apiData && config.endpointDomain && config.endpointPort) {

      // Get the network from the API data instead of parsing chain ID
      const selectedChainData = apiData.consumers[selectedChain];
      if (!selectedChainData || !selectedChainData.network) return;

      const baseNetwork = selectedChainData.network;
      const chain = chains.find(c => c.value === baseNetwork);
      if (!chain) return;

      const chainType = chainTypes.find(t => t.value === chain.type);
      if (!chainType) return;

      // For WebSocket interfaces, use the base interface for command lookup
      const commandLookupInterface = getCommandLookupInterface(selectedInterface);
      const interfaceCommands = chainType.interfaces[commandLookupInterface];
      if (!interfaceCommands) return;

      const interfaceCommand = interfaceCommands[selectedRequestType];
      if (!interfaceCommand) return;

      const domain = config.endpointDomain;
      const port = config.endpointPort;
      const chainIdLower = selectedChain.toLowerCase();

      const curlHost = `${chainIdLower}-${commandLookupInterface}.${domain}`;

      const headers = skipCache ? `-H "lava-force-cache-refresh: true"` : '';

      // Add lava-extension header if request type is archive, trace, or debug
      const extensionHeader =
        selectedRequestType && ['archive', 'trace', 'debug'].includes(selectedRequestType)
          ? `-H "lava-extension: ${selectedRequestType}"`
          : '';

      // Add quorum headers for cross-validation
      const quorumHeaders = [
        `-H "lava-quorum-min: ${crossValidationMin}"`,
        `-H "lava-quorum-max: ${crossValidationMax}"`,
        `-H "lava-quorum-rate: ${crossValidationRate}"`,
      ].join(' ');

      const allHeaders = [headers, extensionHeader, quorumHeaders].filter(Boolean).join(' ');

      let cmd: string;
      if (selectedInterface.includes('/wss')) {
        // WebSocket command - note: quorum headers may not be supported for WebSocket
        cmd = `wscat -c wss://${curlHost}:${port}/websocket -x '${interfaceCommand}'`;
      } else if (selectedInterface === 'rest') {
        const commandData = JSON.parse(interfaceCommand);
        if (commandData.path) {
          // REST GET with path (e.g., Aptos, TON, TRON)
          cmd = `curl -X GET ${allHeaders} https://${curlHost}:${port}${commandData.path}`;
        } else {
          // REST POST with JSON body (e.g., XRP)
          cmd = `curl -X POST ${allHeaders} -H "Content-Type: application/json" https://${curlHost}:${port} -d '${interfaceCommand}'`;
        }
      } else {
        // Other interfaces (jsonrpc, tendermintrpc, etc.)
        cmd = `curl -X POST ${allHeaders} -H "Content-Type: application/json" https://${curlHost}:${port} -d '${interfaceCommand}'`;
      }
      setCrossValidationCurlCommand(cmd);
    }
  }, [
    selectedChain,
    selectedInterface,
    selectedRequestType,
    config.apiEndpoint,
    skipCache,
    apiData,
    crossValidationMin,
    crossValidationMax,
    crossValidationRate,
    config.endpointDomain,
    config.endpointPort,
  ]);

  const handleLoadTest = async () => {
    if (!selectedChain || !selectedInterface) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Please select network, router and interface',
      });
      return;
    }

    if (numberOfRequests < 1 || numberOfRequests > 500) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Number of requests must be between 1 and 500',
      });
      return;
    }

    if (concurrency < 1 || concurrency > 100) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Concurrency must be between 1 and 100',
      });
      return;
    }

    // Safety limits: debug/trace payloads are large and can crash the browser if load-tested too hard.
    if (
      (selectedRequestType === 'debug' || selectedRequestType === 'trace') &&
      numberOfRequests > 100
    ) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description:
          'For debug/trace requests, please limit the load test to 100 requests (payloads are large).',
      });
      return;
    }
    if ((selectedRequestType === 'debug' || selectedRequestType === 'trace') && concurrency > 10) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description:
          'For debug/trace requests, please limit concurrency to 10 (payloads are large).',
      });
      return;
    }

    if (!config.endpointDomain || !config.endpointPort) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Endpoint configuration is missing. Please configure domain and port in Settings.',
      });
      return;
    }

    setIsLoadTesting(true);
    setLoadTestResult(null);
    setLoadTestExpandedHeaders(new Set());

    try {
      const baseNetwork = getNetworkFromChainId(selectedChain);
      if (!baseNetwork) throw new Error('Network not found for chain');
      const chain = chains.find(c => c.value === baseNetwork);
      if (!chain) throw new Error('Chain not found');

      const chainType = chainTypes.find(t => t.value === chain.type);
      if (!chainType) throw new Error('Chain type not found');

      // For WebSocket interfaces, use the base interface for command lookup
      const commandLookupInterface = getCommandLookupInterface(selectedInterface);
      const interfaceCommands = chainType.interfaces[commandLookupInterface];
      if (!interfaceCommands) throw new Error('Interface not found');

      const interfaceCommand = interfaceCommands[selectedRequestType];
      if (!interfaceCommand) throw new Error('Request type command not found');

      // Use configured domain and port
      const domain = config.endpointDomain;
      const port = config.endpointPort;

      if (!domain || !port) {
        throw new Error('Endpoint configuration is incomplete. Please configure domain and port in Settings.');
      }

      const caps = getSafeResponseCaps(selectedRequestType);

      const responses = await makeLoadTestRequests(
        {
          chainId: selectedChain,
          interface: selectedInterface, // Pass the original interface (jsonrpc/wss)
          interfaceCommand,
          domain,
          port,
          skipCache,
          requestType: selectedRequestType,
          ...caps,
        },
        numberOfRequests,
        concurrency,
      );

      // Calculate statistics from responses
      const loadTestResult = calculateLoadTestStats(responses);
      setLoadTestResult(loadTestResult);

      const successRate = loadTestResult.success_rate;
      const formattedSuccessRate =
        successRate % 1 === 0 ? `${successRate.toFixed(0)}%` : `${successRate.toFixed(1)}%`;

      toast({
        title: 'Load test completed',
        description: `Success rate: ${formattedSuccessRate} (${loadTestResult.successful_requests}/${loadTestResult.total_requests} requests)`,
      });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to execute load test',
      });
    } finally {
      setIsLoadTesting(false);
    }
  };

  const handleCrossValidation = async () => {
    if (!selectedChain || !selectedInterface) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Please select network, router and interface',
      });
      return;
    }

    if (!config.endpointDomain || !config.endpointPort) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Endpoint configuration is missing. Please configure domain and port in Settings.',
      });
      return;
    }

    setIsCrossValidating(true);
    setCrossValidationResponse('');
    setCrossValidationStatus(null);
    setCrossValidationLatency(null);
    setCrossValidationProvider(null);
    setCrossValidationHeaders(null);
    setCrossValidationHeadersExpanded(false);
    setCrossValidationResponseTruncated(false);

    try {
      const baseNetwork = getNetworkFromChainId(selectedChain);
      if (!baseNetwork) throw new Error('Network not found for chain');
      const chain = chains.find(c => c.value === baseNetwork);
      if (!chain) throw new Error('Chain not found');

      const chainType = chainTypes.find(t => t.value === chain.type);
      if (!chainType) throw new Error('Chain type not found');

      // For WebSocket interfaces, use the base interface for command lookup
      const commandLookupInterface = getCommandLookupInterface(selectedInterface);
      const interfaceCommands = chainType.interfaces[commandLookupInterface];
      if (!interfaceCommands) throw new Error('Interface not found');

      const interfaceCommand = interfaceCommands[selectedRequestType];
      if (!interfaceCommand) throw new Error('Request type command not found');

      // Use configured domain and port
      const domain = config.endpointDomain;
      const port = config.endpointPort;

      if (!domain || !port) {
        throw new Error('Endpoint configuration is incomplete. Please configure domain and port in Settings.');
      }

      const caps = getSafeResponseCaps(selectedRequestType);

      const response = await makeTestRequest({
        chainId: selectedChain,
        interface: selectedInterface, // Pass the original interface (jsonrpc/wss)
        interfaceCommand,
        domain,
        port,
        skipCache,
        requestType: selectedRequestType,
        quorumMin: crossValidationMin,
        quorumMax: crossValidationMax,
        quorumRate: crossValidationRate,
        ...caps,
      });

      const raw = response.response_data;
      const responseText =
        typeof raw === 'string' ? tryPrettifyJsonString(raw) : JSON.stringify(raw, null, 2);

      setCrossValidationResponse(responseText);
      setCrossValidationStatus(response.status_code);
      setCrossValidationLatency(response.latency_ms);
      setCrossValidationResponseTruncated(!!response.truncated);

      // Extract provider information from headers
      const headers = response.headers || {};
      setCrossValidationHeaders(headers);

      // Cross validation uses quorum logic, so only check for lava-quorum-all-providers
      const quorumProvidersHeader = headers['lava-quorum-all-providers'];

      if (quorumProvidersHeader) {
        // Remove brackets and format providers separated by commas
        let formattedProviders = quorumProvidersHeader
          .replace(/[\[\]]/g, '') // Remove brackets
          .trim();

        // Handle both comma-separated and space-separated providers
        if (formattedProviders.includes(',')) {
          // If already comma-separated, just clean up spacing
          formattedProviders = formattedProviders
            .split(',')
            .map((provider: string) => provider.trim())
            .join(', ');
        } else if (formattedProviders.includes(' ')) {
          // If space-separated, convert to comma-separated
          formattedProviders = formattedProviders
            .split(/\s+/) // Split by one or more spaces
            .filter((provider: string) => provider.length > 0)
            .join(', ');
        }

        setCrossValidationProvider(formattedProviders);
      }

      toast({
        title: 'Cross validation completed',
        description: 'Cross validation test completed successfully',
      });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to execute cross validation',
      });
    } finally {
      setIsCrossValidating(false);
    }
  };

  const handleTest = async () => {
    if (!selectedChain || !selectedInterface) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Please select network, router and interface',
      });
      return;
    }

    if (!config.endpointDomain || !config.endpointPort) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Endpoint configuration is missing. Please configure domain and port in Settings.',
      });
      return;
    }

    setIsLoading(true);
    setSingleTestStatus(null);
    setSingleTestLatency(null);
    setSingleTestProvider(null);
    setSingleTestHeaders(null);
    setSingleHeadersExpanded(false);
    setSingleResponseTruncated(false);
    try {
      const baseNetwork = getNetworkFromChainId(selectedChain);
      if (!baseNetwork) throw new Error('Network not found for chain');
      const chain = chains.find(c => c.value === baseNetwork);
      if (!chain) throw new Error('Chain not found');

      const chainType = chainTypes.find(t => t.value === chain.type);
      if (!chainType) throw new Error('Chain type not found');

      // For WebSocket interfaces, use the base interface for command lookup
      const commandLookupInterface = getCommandLookupInterface(selectedInterface);
      const interfaceCommands = chainType.interfaces[commandLookupInterface];
      if (!interfaceCommands) throw new Error('Interface not found');

      const interfaceCommand = interfaceCommands[selectedRequestType];
      if (!interfaceCommand) throw new Error('Request type command not found');

      // Use configured domain and port
      const domain = config.endpointDomain;
      const port = config.endpointPort;

      if (!domain || !port) {
        throw new Error('Endpoint configuration is incomplete. Please configure domain and port in Settings.');
      }

      const caps = getSafeResponseCaps(selectedRequestType);

      const response = await makeTestRequest({
        chainId: selectedChain,
        interface: selectedInterface, // Pass the original interface (jsonrpc/wss)
        interfaceCommand,
        domain,
        port,
        skipCache,
        requestType: selectedRequestType,
        ...caps,
      });

      setSingleTestStatus(response.status_code);
      setSingleTestLatency(response.latency_ms);

      // Extract provider information from headers
      const headers = response.headers || {};
      setSingleTestHeaders(headers);
      const providerHeader = Object.keys(headers).find(
        key => key.toLowerCase() === 'lava-provider-address',
      );
      const providerValue = providerHeader ? headers[providerHeader] : null;

      if (providerValue) {
        setSingleTestProvider(providerValue.toLowerCase() === 'cached' ? 'cached' : providerValue);
      }

      const raw = response.response_data;
      const responseText =
        typeof raw === 'string' ? tryPrettifyJsonString(raw) : JSON.stringify(raw, null, 2);
      setResponse(responseText);
      setSingleResponseTruncated(!!response.truncated);
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to execute test',
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Batch request handlers
  const addBatchRequest = () => {
    const maxId = Math.max(...batchRequests.map(r => r.id), 0);
    setBatchRequests([...batchRequests, { id: maxId + 1, method: '', params: [] }]);
  };

  const removeBatchRequest = (id: number) => {
    if (batchRequests.length <= 1) return;
    setBatchRequests(batchRequests.filter(r => r.id !== id));
  };

  const updateBatchRequest = (id: number, updates: Partial<BatchRequestItem>) => {
    setBatchRequests(batchRequests.map(r => (r.id === id ? { ...r, ...updates } : r)));
  };

  const handleBatchTest = async () => {
    const validRequests = batchRequests.filter(r => r.method.trim() !== '');
    
    if (validRequests.length === 0) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Please add at least one request with a method',
      });
      return;
    }

    if (!selectedChain) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Please select a network and router',
      });
      return;
    }

    if (!config.endpointDomain || !config.endpointPort) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Endpoint configuration is missing. Please configure domain and port in Settings.',
      });
      return;
    }

    setIsBatchTesting(true);
    setBatchResult(null);
    setBatchLoadTestResult(null);
    setExpandedBatchResponses(new Set());

    try {
      const domain = config.endpointDomain;
      const port = config.endpointPort;

      if (batchMode === 'single') {
        // Single batch request
        const result = await makeBatchRequest(
          {
            chainId: selectedChain,
            domain,
            port,
            skipCache,
          },
          validRequests,
        );
        setBatchResult(result);

        const successCount = result.responses.filter(r => r.success).length;
        toast({
          title: 'Batch request completed',
          description: `${successCount}/${result.responses.length} requests successful (${result.latency_ms.toFixed(1)}ms)`,
        });
      } else {
        // Batch load test
        if (numberOfBatches < 1 || numberOfBatches > 500) {
          toast({
            variant: 'destructive',
            title: 'Error',
            description: 'Number of batches must be between 1 and 500',
          });
          setIsBatchTesting(false);
          return;
        }

        const results = await makeBatchLoadTestRequests(
          {
            chainId: selectedChain,
            domain,
            port,
            skipCache,
          },
          validRequests,
          numberOfBatches,
          batchConcurrency,
        );

        const methods = validRequests.map(r => r.method);
        const stats = calculateBatchLoadTestStats(results, methods);
        setBatchLoadTestResult(stats);

        const successRate = stats.batch_success_rate;
        const formattedSuccessRate =
          successRate % 1 === 0 ? `${successRate.toFixed(0)}%` : `${successRate.toFixed(1)}%`;

        toast({
          title: 'Batch load test completed',
          description: `Success rate: ${formattedSuccessRate} (${stats.successful_batches}/${stats.total_batches} batches)`,
        });
      }
    } catch (error) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to execute batch test',
      });
    } finally {
      setIsBatchTesting(false);
    }
  };

  const copyToClipboard = (text: string, message?: string) => {
    navigator.clipboard.writeText(text).then(() => {
      toast({
        title: 'Copied to clipboard',
        description: message || 'The command has been copied to your clipboard',
      });
    });
  };

  // Helpers for UI lists
  const networks = Array.from(new Set(availableChains.map(c => c.network)));
  const routersForSelectedNetwork = availableChains.filter(c => c.network === selectedNetwork);

  return (
    <ProtectedRoute>
      <div className='min-h-screen bg-background p-6'>
        <div className='mx-auto max-w-[1200px] space-y-6'>
          <div className='space-y-2'>
            <h1 className='text-3xl font-bold tracking-tight'>Live Test</h1>
            <p className='text-muted-foreground'>
              Test your chain configuration with live requests
            </p>
          </div>

          {error && (
            <div className='rounded-lg bg-destructive/10 p-4 text-destructive'>{error}</div>
          )}

          <Tabs
            value={activeTab}
            onValueChange={value => setActiveTab(value as 'single' | 'load' | 'batch' | 'cross')}
            className='w-full'
          >
            <TabsList className={cn('grid w-full', showBatchTab ? 'grid-cols-4' : 'grid-cols-3')}>
              <TabsTrigger value='single' className='flex items-center gap-2'>
                <Play className='h-4 w-4' />
                Single Test
              </TabsTrigger>
              <TabsTrigger value='load' className='flex items-center gap-2'>
                <BarChart3 className='h-4 w-4' />
                Load Test
              </TabsTrigger>
              {showBatchTab && (
                <TabsTrigger value='batch' className='flex items-center gap-2'>
                  <Layers className='h-4 w-4' />
                  Batch Test
                </TabsTrigger>
              )}
              <TabsTrigger value='cross' className='flex items-center gap-2'>
                <Shield className='h-4 w-4' />
                Cross Validation
              </TabsTrigger>
            </TabsList>

            <TabsContent value='single' className='mt-6'>
              <div className='grid gap-6'>
                <Card className='border-2 border-primary/20 bg-gradient-to-br from-card/50 to-card shadow-lg hover:shadow-xl transition-all duration-200'>
                  <CardHeader className='border-b border-border/20 bg-gradient-to-r from-primary/10 to-background pb-4'>
                    <CardTitle className='text-xl font-bold bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent'>
                      Configuration
                    </CardTitle>
                    <CardDescription>
                      Select a network, router and interface to test
                    </CardDescription>
                  </CardHeader>
                  <CardContent className='space-y-6 pt-6'>
                    {isFetching ? (
                      <div className='flex items-center justify-center py-8'>
                        <Loader2 className='h-6 w-6 animate-spin text-primary' />
                      </div>
                    ) : (
                      <>
                        <div className='space-y-4'>
                          <Label className='text-sm font-medium'>Network</Label>
                          <div className='flex flex-wrap gap-3'>
                            {networks.map(net => {
                              const conf = chains.find(c => c.value === net);
                              const label = conf ? conf.label : getChainLabel(net);
                              const icon = conf ? conf.icon : getChainIcon(net);
                              const selected = selectedNetwork === net;
                              return (
                                <button
                                  key={net}
                                  onClick={() => {
                                    if (selectedNetwork === net) return;
                                    setSelectedNetwork(net);
                                    const routers = availableChains.filter(c => c.network === net);
                                    if (routers.length === 1) {
                                      setSelectedChain(routers[0].id);
                                    } else {
                                      setSelectedChain('');
                                    }
                                    setSelectedInterface('');
                                    setResponse('');
                                  }}
                                  className={cn(
                                    'flex items-center gap-3 p-3 rounded-lg border-2 transition-all duration-200 hover:border-primary/50 hover:bg-primary/5',
                                    selected
                                      ? 'border-primary bg-primary/10 shadow-lg'
                                      : 'border-border/50 bg-card',
                                  )}
                                >
                                  <div className='flex-shrink-0 w-8 h-8 rounded-full bg-background/50 p-1.5'>
                                    {icon && (
                                      <img
                                        src={icon}
                                        alt={label}
                                        className='w-full h-full object-contain'
                                      />
                                    )}
                                  </div>
                                  <span className='font-medium'>{label}</span>
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {selectedNetwork && routersForSelectedNetwork.length > 1 && (
                          <div className='space-y-4'>
                            <Label className='text-sm font-medium'>Router</Label>
                            <div className='flex flex-wrap gap-3'>
                              {routersForSelectedNetwork.map(router => {
                                const selected = selectedChain === router.id;
                                const conf = chains.find(c => c.value === selectedNetwork);
                                const label = conf ? conf.label : getChainLabel(selectedNetwork);
                                const icon = conf ? conf.icon : getChainIcon(selectedNetwork);
                                return (
                                  <button
                                    key={router.id}
                                    onClick={() => {
                                      setSelectedChain(router.id);
                                      setSelectedInterface('');
                                      setResponse('');
                                    }}
                                    className={cn(
                                      'flex items-center gap-3 p-3 rounded-lg border-2 transition-all duration-200 hover:border-primary/50 hover:bg-primary/5',
                                      selected
                                        ? 'border-primary bg-primary/10 shadow-lg'
                                        : 'border-border/50 bg-card',
                                    )}
                                  >
                                    <div className='flex-shrink-0 w-8 h-8 rounded-full bg-background/50 p-1.5'>
                                      {icon && (
                                        <img
                                          src={icon}
                                          alt={label}
                                          className='w-full h-full object-contain'
                                        />
                                      )}
                                    </div>
                                    <span className='font-medium'>{router.id}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {selectedChain && (
                          <div className='space-y-4'>
                            <Label className='text-sm font-medium'>Interface</Label>
                            <div className='flex flex-wrap gap-2'>
                              {configuredInterfaces.map(iface => {
                                const displayName =
                                  iface === 'jsonrpc'
                                    ? 'JSON-RPC'
                                    : iface === 'tendermintrpc'
                                      ? 'TendermintRPC'
                                      : iface === 'rest'
                                        ? 'REST'
                                        : iface === 'grpc'
                                          ? 'gRPC'
                                          : iface;
                                return (
                                  <Button
                                    key={iface}
                                    variant={selectedInterface === iface ? 'default' : 'outline'}
                                    size='sm'
                                    className={cn(
                                      selectedInterface === iface &&
                                        (iface === 'jsonrpc'
                                          ? 'bg-blue-500 hover:bg-blue-600'
                                          : iface === 'tendermintrpc'
                                            ? 'bg-green-500 hover:bg-green-600'
                                            : iface === 'rest'
                                              ? 'bg-purple-500 hover:bg-purple-600'
                                              : iface === 'grpc'
                                                ? 'bg-orange-500 hover:bg-orange-600'
                                                : ''),
                                      'hover:opacity-90',
                                    )}
                                    onClick={() => {
                                      setSelectedInterface(iface);
                                      setSelectedRequestType('regular');
                                      setResponse('');
                                    }}
                                  >
                                    {displayName}
                                  </Button>
                                );
                              })}
                              {/* Add JSON-RPC/WSS option for chains with hasWss */}
                              {configuredInterfaces.includes('jsonrpc') &&
                                (() => {
                                  const baseNetwork = getNetworkFromChainId(selectedChain);
                                  const chain = chains.find(c => c.value === baseNetwork);
                                  return chain?.hasWss ? (
                                    <Button
                                      key='jsonrpc/wss'
                                      variant={
                                        selectedInterface === 'jsonrpc/wss' ? 'default' : 'outline'
                                      }
                                      size='sm'
                                      className={cn(
                                        selectedInterface === 'jsonrpc/wss' &&
                                          'bg-cyan-500 hover:bg-cyan-600',
                                        'hover:opacity-90',
                                      )}
                                      onClick={() => {
                                        setSelectedInterface('jsonrpc/wss');
                                        setSelectedRequestType('regular');
                                        setResponse('');
                                      }}
                                    >
                                      JSON-RPC/WSS
                                    </Button>
                                  ) : null;
                                })()}
                              {/* Add TendermintRPC/WSS option for chains with hasWss */}
                              {configuredInterfaces.includes('tendermintrpc') &&
                                (() => {
                                  const baseNetwork = getNetworkFromChainId(selectedChain);
                                  const chain = chains.find(c => c.value === baseNetwork);
                                  return chain?.hasWss ? (
                                    <Button
                                      key='tendermintrpc/wss'
                                      variant={
                                        selectedInterface === 'tendermintrpc/wss'
                                          ? 'default'
                                          : 'outline'
                                      }
                                      size='sm'
                                      className={cn(
                                        selectedInterface === 'tendermintrpc/wss' &&
                                          'bg-teal-500 hover:bg-teal-600',
                                        'hover:opacity-90',
                                      )}
                                      onClick={() => {
                                        setSelectedInterface('tendermintrpc/wss');
                                        setSelectedRequestType('regular');
                                        setResponse('');
                                      }}
                                    >
                                      TendermintRPC/WSS
                                    </Button>
                                  ) : null;
                                })()}
                            </div>
                          </div>
                        )}

                        {/* Skip Cache Option */}
                        <div className='space-y-4'>
                          <div className='flex items-center space-x-2'>
                            <input
                              type='checkbox'
                              id='skip-cache-single'
                              checked={skipCache}
                              onChange={e => setSkipCache(e.target.checked)}
                              className='h-4 w-4 text-primary focus:ring-primary border-gray-300 rounded'
                            />
                            <Label htmlFor='skip-cache-single' className='text-sm font-medium'>
                              Skip Cache
                            </Label>
                          </div>
                        </div>

                        {/* Request Type Selection */}
                        {selectedChain &&
                          selectedInterface &&
                          (() => {
                            const baseNetwork = getNetworkFromChainId(selectedChain);
                            if (!baseNetwork) throw new Error('Network not found for chain');
                            const chain = chains.find(c => c.value === baseNetwork);
                            if (!chain) return null;

                            const chainType = chainTypes.find(t => t.value === chain.type);
                            if (!chainType) return null;

                            const interfaceCommands = chainType.interfaces[selectedInterface];
                            if (!interfaceCommands) return null;

                            const availableTypes = configuredRequestTypes
                              .filter(type => type !== 'regular')
                              .filter(
                                type =>
                                  interfaceCommands[type as keyof typeof interfaceCommands] !==
                                  null,
                              );

                            if (availableTypes.length === 0) return null;

                            return (
                              <div className='space-y-4'>
                                <Label className='text-sm font-medium'>Request Type</Label>
                                <div className='flex flex-wrap gap-2'>
                                  {availableTypes.map(type => {
                                    const displayName =
                                      type.charAt(0).toUpperCase() + type.slice(1);
                                    return (
                                      <Button
                                        key={type}
                                        variant={
                                          selectedRequestType === type ? 'default' : 'outline'
                                        }
                                        size='sm'
                                        className={cn(
                                          selectedRequestType === type &&
                                            (type === 'regular'
                                              ? 'bg-blue-500 hover:bg-blue-600'
                                              : type === 'archive'
                                                ? 'bg-green-500 hover:bg-green-600'
                                                : type === 'debug'
                                                  ? 'bg-orange-500 hover:bg-orange-600'
                                                  : type === 'trace'
                                                    ? 'bg-purple-500 hover:bg-purple-600'
                                                    : ''),
                                          'hover:opacity-90',
                                        )}
                                        onClick={() => {
                                          // Toggle logic: if clicking the same type, reset to regular
                                          const newType =
                                            selectedRequestType === type ? 'regular' : type;
                                          setSelectedRequestType(
                                            newType as 'regular' | 'archive' | 'debug' | 'trace',
                                          );
                                          setResponse('');
                                          setSingleTestStatus(null);
                                          setSingleTestLatency(null);
                                          setSingleTestProvider(null);
                                        }}
                                      >
                                        {displayName}
                                      </Button>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })()}
                      </>
                    )}
                  </CardContent>
                </Card>

                {selectedChain && selectedInterface && (
                  <Card className='border-muted bg-card/50'>
                    <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                      <CardTitle className='text-lg font-medium'>Endpoint</CardTitle>
                      <Button
                        variant='ghost'
                        size='icon'
                        onClick={() => {
                          setCopiedEndpoint(true);
                          copyToClipboard(endpointUrl, 'Copied endpoint URL');
                          setTimeout(() => setCopiedEndpoint(false), 1200);
                        }}
                      >
                        {copiedEndpoint ? (
                          <Check className='h-4 w-4 text-green-500' />
                        ) : (
                          <Copy className='h-4 w-4' />
                        )}
                      </Button>
                    </CardHeader>
                    <CardContent>
                      <div className='rounded-lg bg-muted p-4 font-mono text-sm overflow-x-auto whitespace-pre-wrap break-all'>
                        {endpointUrl}
                      </div>
                    </CardContent>
                  </Card>
                )}

                {selectedChain && selectedInterface && (
                  <Card className='border-muted bg-card/50'>
                    <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                      <CardTitle className='text-lg font-medium'>Test Command</CardTitle>
                      <Button
                        variant='ghost'
                        size='icon'
                        onClick={() => {
                          setCopiedCurl(true);
                          copyToClipboard(curlCommand, 'Copied curl command');
                          setTimeout(() => setCopiedCurl(false), 1200);
                        }}
                      >
                        {copiedCurl ? (
                          <Check className='h-4 w-4 text-green-500' />
                        ) : (
                          <Copy className='h-4 w-4' />
                        )}
                      </Button>
                    </CardHeader>
                    <CardContent>
                      <pre className='rounded-lg bg-muted p-4 font-mono text-sm overflow-x-auto whitespace-pre-wrap break-all'>
                        {curlCommand}
                      </pre>
                    </CardContent>
                  </Card>
                )}

                <div className='flex justify-end space-x-4'>
                  <Button
                    onClick={handleTest}
                    disabled={isLoading || !selectedChain || !selectedInterface}
                    className='bg-primary hover:bg-primary/90'
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                        Running...
                      </>
                    ) : (
                      <>
                        <Play className='mr-2 h-4 w-4' />
                        Run Test
                      </>
                    )}
                  </Button>
                </div>

                {response && (
                  <Card className='border-muted bg-card/50'>
                    <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                      <CardTitle className='text-lg font-medium'>Single Test Response</CardTitle>
                      <div className='flex items-center gap-3'>
                        <div className='flex flex-col items-start gap-1 py-1'>
                          {singleTestStatus && (
                            <span className='flex items-center gap-1.5 text-sm font-medium'>
                              {getStatusIcon(singleTestStatus)}
                              <span className={getStatusColor(singleTestStatus)}>
                                {singleTestStatus}
                              </span>
                            </span>
                          )}
                          {singleTestLatency && (
                            <span className='flex items-center gap-1.5 text-sm text-slate-300'>
                              <Timer className='h-4 w-4 text-slate-400' />
                              {singleTestLatency.toFixed(1)}ms
                            </span>
                          )}
                          {singleTestProvider && (
                            <div className='flex items-center gap-1.5 text-sm text-slate-400'>
                              <Server className='h-4 w-4 text-slate-400' />
                              <span className='truncate' title={singleTestProvider}>
                                {singleTestProvider.toLowerCase() === 'cached'
                                  ? 'Cached'
                                  : singleTestProvider}
                              </span>
                            </div>
                          )}
                        </div>
                        <Button
                          variant='ghost'
                          size='icon'
                          onClick={() => {
                            setCopiedSingleResponse(true);
                            copyToClipboard(response, 'Copied response');
                            setTimeout(() => setCopiedSingleResponse(false), 1200);
                          }}
                        >
                          {copiedSingleResponse ? (
                            <Check className='h-4 w-4 text-green-500' />
                          ) : (
                            <Copy className='h-4 w-4' />
                          )}
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent>
                      {singleResponseTruncated && (
                        <div className='mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800'>
                          Response was truncated for safety (payload too large).
                        </div>
                      )}
                      {renderInlineJson(
                        response,
                        singleHeadersExpanded,
                        () => setSingleHeadersExpanded(true),
                        singleTestHeaders,
                      )}
                    </CardContent>
                  </Card>
                )}
              </div>
            </TabsContent>

            <TabsContent value='load' className='mt-6'>
              <div className='grid gap-6'>
                <Card className='border-2 border-primary/20 bg-gradient-to-br from-card/50 to-card shadow-lg hover:shadow-xl transition-all duration-200'>
                  <CardHeader className='border-b border-border/20 bg-gradient-to-r from-primary/10 to-background pb-4'>
                    <CardTitle className='text-xl font-bold bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent'>
                      Configuration
                    </CardTitle>
                    <CardDescription>
                      Select a network, router and interface to test
                    </CardDescription>
                  </CardHeader>
                  <CardContent className='space-y-6 pt-6'>
                    {isFetching ? (
                      <div className='flex items-center justify-center py-8'>
                        <Loader2 className='h-6 w-6 animate-spin text-primary' />
                      </div>
                    ) : (
                      <>
                        <div className='space-y-4'>
                          <Label className='text-sm font-medium'>Network</Label>
                          <div className='flex flex-wrap gap-3'>
                            {networks.map(net => {
                              const conf = chains.find(c => c.value === net);
                              const label = conf ? conf.label : getChainLabel(net);
                              const icon = conf ? conf.icon : getChainIcon(net);
                              const selected = selectedNetwork === net;
                              return (
                                <button
                                  key={net}
                                  onClick={() => {
                                    if (selectedNetwork === net) return;
                                    setSelectedNetwork(net);
                                    const routers = availableChains.filter(c => c.network === net);
                                    if (routers.length === 1) {
                                      setSelectedChain(routers[0].id);
                                    } else {
                                      setSelectedChain('');
                                    }
                                    setSelectedInterface('');
                                    setResponse('');
                                    setLoadTestResult(null);
                                  }}
                                  className={cn(
                                    'flex items-center gap-3 p-3 rounded-lg border-2 transition-all duration-200 hover:border-primary/50 hover:bg-primary/5',
                                    selected
                                      ? 'border-primary bg-primary/10 shadow-lg'
                                      : 'border-border/50 bg-card',
                                  )}
                                >
                                  <div className='flex-shrink-0 w-8 h-8 rounded-full bg-background/50 p-1.5'>
                                    {icon && (
                                      <img
                                        src={icon}
                                        alt={label}
                                        className='w-full h-full object-contain'
                                      />
                                    )}
                                  </div>
                                  <span className='font-medium'>{label}</span>
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {selectedNetwork && routersForSelectedNetwork.length > 1 && (
                          <div className='space-y-4'>
                            <Label className='text-sm font-medium'>Router</Label>
                            <div className='flex flex-wrap gap-3'>
                              {routersForSelectedNetwork.map(router => {
                                const selected = selectedChain === router.id;
                                const conf = chains.find(c => c.value === selectedNetwork);
                                const label = conf ? conf.label : getChainLabel(selectedNetwork);
                                const icon = conf ? conf.icon : getChainIcon(selectedNetwork);
                                return (
                                  <button
                                    key={router.id}
                                    onClick={() => {
                                      setSelectedChain(router.id);
                                      setSelectedInterface('');
                                      setResponse('');
                                      setLoadTestResult(null);
                                    }}
                                    className={cn(
                                      'flex items-center gap-3 p-3 rounded-lg border-2 transition-all duration-200 hover:border-primary/50 hover:bg-primary/5',
                                      selected
                                        ? 'border-primary bg-primary/10 shadow-lg'
                                        : 'border-border/50 bg-card',
                                    )}
                                  >
                                    <div className='flex-shrink-0 w-8 h-8 rounded-full bg-background/50 p-1.5'>
                                      {icon && (
                                        <img
                                          src={icon}
                                          alt={label}
                                          className='w-full h-full object-contain'
                                        />
                                      )}
                                    </div>
                                    <span className='font-medium'>{router.id}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {selectedChain && (
                          <div className='space-y-4'>
                            <Label className='text-sm font-medium'>Interface</Label>
                            <div className='flex flex-wrap gap-2'>
                              {configuredInterfaces.map(iface => {
                                const displayName =
                                  iface === 'jsonrpc'
                                    ? 'JSON-RPC'
                                    : iface === 'tendermintrpc'
                                      ? 'TendermintRPC'
                                      : iface === 'rest'
                                        ? 'REST'
                                        : iface === 'grpc'
                                          ? 'gRPC'
                                          : iface;
                                return (
                                  <Button
                                    key={iface}
                                    variant={selectedInterface === iface ? 'default' : 'outline'}
                                    size='sm'
                                    className={cn(
                                      selectedInterface === iface &&
                                        (iface === 'jsonrpc'
                                          ? 'bg-blue-500 hover:bg-blue-600'
                                          : iface === 'tendermintrpc'
                                            ? 'bg-green-500 hover:bg-green-600'
                                            : iface === 'rest'
                                              ? 'bg-purple-500 hover:bg-purple-600'
                                              : iface === 'grpc'
                                                ? 'bg-orange-500 hover:bg-orange-600'
                                                : ''),
                                      'hover:opacity-90',
                                    )}
                                    onClick={() => {
                                      setSelectedInterface(iface);
                                      setSelectedRequestType('regular');
                                      setResponse('');
                                      setLoadTestResult(null);
                                    }}
                                  >
                                    {displayName}
                                  </Button>
                                );
                              })}
                              {/* Add JSON-RPC/WSS option for chains with hasWss */}
                              {configuredInterfaces.includes('jsonrpc') &&
                                (() => {
                                  const baseNetwork = getNetworkFromChainId(selectedChain);
                                  const chain = chains.find(c => c.value === baseNetwork);
                                  return chain?.hasWss ? (
                                    <Button
                                      key='jsonrpc/wss'
                                      variant={
                                        selectedInterface === 'jsonrpc/wss' ? 'default' : 'outline'
                                      }
                                      size='sm'
                                      className={cn(
                                        selectedInterface === 'jsonrpc/wss' &&
                                          'bg-cyan-500 hover:bg-cyan-600',
                                        'hover:opacity-90',
                                      )}
                                      onClick={() => {
                                        setSelectedInterface('jsonrpc/wss');
                                        setSelectedRequestType('regular');
                                        setResponse('');
                                        setLoadTestResult(null);
                                      }}
                                    >
                                      JSON-RPC/WSS
                                    </Button>
                                  ) : null;
                                })()}
                              {/* Add TendermintRPC/WSS option for chains with hasWss */}
                              {configuredInterfaces.includes('tendermintrpc') &&
                                (() => {
                                  const baseNetwork = getNetworkFromChainId(selectedChain);
                                  const chain = chains.find(c => c.value === baseNetwork);
                                  return chain?.hasWss ? (
                                    <Button
                                      key='tendermintrpc/wss'
                                      variant={
                                        selectedInterface === 'tendermintrpc/wss'
                                          ? 'default'
                                          : 'outline'
                                      }
                                      size='sm'
                                      className={cn(
                                        selectedInterface === 'tendermintrpc/wss' &&
                                          'bg-teal-500 hover:bg-teal-600',
                                        'hover:opacity-90',
                                      )}
                                      onClick={() => {
                                        setSelectedInterface('tendermintrpc/wss');
                                        setSelectedRequestType('regular');
                                        setResponse('');
                                        setLoadTestResult(null);
                                      }}
                                    >
                                      TendermintRPC/WSS
                                    </Button>
                                  ) : null;
                                })()}
                            </div>
                          </div>
                        )}

                        {/* Skip Cache Option */}
                        <div className='space-y-4'>
                          <div className='flex items-center space-x-2'>
                            <input
                              type='checkbox'
                              id='skip-cache-global'
                              checked={skipCache}
                              onChange={e => setSkipCache(e.target.checked)}
                              className='h-4 w-4 text-primary focus:ring-primary border-gray-300 rounded'
                            />
                            <Label htmlFor='skip-cache-global' className='text-sm font-medium'>
                              Skip Cache
                            </Label>
                          </div>
                        </div>

                        {/* Request Type Selection */}
                        {selectedChain &&
                          selectedInterface &&
                          (() => {
                            const baseNetwork = getNetworkFromChainId(selectedChain);
                            if (!baseNetwork) throw new Error('Network not found for chain');
                            const chain = chains.find(c => c.value === baseNetwork);
                            if (!chain) return null;

                            const chainType = chainTypes.find(t => t.value === chain.type);
                            if (!chainType) return null;

                            const interfaceCommands = chainType.interfaces[selectedInterface];
                            if (!interfaceCommands) return null;

                            const availableTypes = configuredRequestTypes
                              .filter(type => type !== 'regular')
                              .filter(
                                type =>
                                  interfaceCommands[type as keyof typeof interfaceCommands] !==
                                  null,
                              );

                            if (availableTypes.length === 0) return null;

                            return (
                              <div className='space-y-4'>
                                <Label className='text-sm font-medium'>Request Type</Label>
                                <div className='flex flex-wrap gap-2'>
                                  {availableTypes.map(type => {
                                    const displayName =
                                      type.charAt(0).toUpperCase() + type.slice(1);
                                    return (
                                      <Button
                                        key={type}
                                        variant={
                                          selectedRequestType === type ? 'default' : 'outline'
                                        }
                                        size='sm'
                                        className={cn(
                                          selectedRequestType === type &&
                                            (type === 'regular'
                                              ? 'bg-blue-500 hover:bg-blue-600'
                                              : type === 'archive'
                                                ? 'bg-green-500 hover:bg-green-600'
                                                : type === 'debug'
                                                  ? 'bg-orange-500 hover:bg-orange-600'
                                                  : type === 'trace'
                                                    ? 'bg-purple-500 hover:bg-purple-600'
                                                    : ''),
                                          'hover:opacity-90',
                                        )}
                                        onClick={() => {
                                          // Toggle logic: if clicking the same type, reset to regular
                                          const newType =
                                            selectedRequestType === type ? 'regular' : type;
                                          setSelectedRequestType(
                                            newType as 'regular' | 'archive' | 'debug' | 'trace',
                                          );
                                          setResponse('');
                                          setLoadTestResult(null);
                                        }}
                                      >
                                        {displayName}
                                      </Button>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })()}
                      </>
                    )}
                  </CardContent>
                </Card>

                {selectedChain && selectedInterface && (
                  <Card className='border-muted bg-card/50'>
                    <CardHeader>
                      <CardTitle className='text-lg font-medium'>Load Test Configuration</CardTitle>
                      <CardDescription>
                        Configure the number of requests for load testing
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className='space-y-4'>
                        <div className='space-y-2'>
                          <Label htmlFor='numberOfRequests' className='text-sm font-medium'>
                            Number of Requests (1-500)
                          </Label>
                          <Input
                            id='numberOfRequests'
                            type='number'
                            min={1}
                            max={500}
                            value={numberOfRequests}
                            onChange={e =>
                              setNumberOfRequests(
                                Math.max(1, Math.min(500, parseInt(e.target.value) || 1)),
                              )
                            }
                            className='w-32'
                            disabled={isLoadTesting}
                          />
                        </div>
                        <div className='space-y-2'>
                          <Label htmlFor='concurrency' className='text-sm font-medium'>
                            Concurrency (1-100)
                          </Label>
                          <Input
                            id='concurrency'
                            type='number'
                            min={1}
                            max={100}
                            value={concurrency}
                            onChange={e =>
                              setConcurrency(
                                Math.max(1, Math.min(100, parseInt(e.target.value) || 5)),
                              )
                            }
                            className='w-32'
                            disabled={isLoadTesting}
                          />
                        </div>
                        <p className='text-sm text-muted-foreground'>
                          Load tests will run {numberOfRequests} requests with up to {concurrency}{' '}
                          concurrent requests and report success rate and latency statistics.
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                )}

                <div className='flex justify-end space-x-4'>
                  <Button
                    onClick={handleLoadTest}
                    disabled={isLoadTesting || !selectedChain || !selectedInterface}
                    className='bg-primary hover:bg-primary/90'
                  >
                    {isLoadTesting ? (
                      <>
                        <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                        Load Testing...
                      </>
                    ) : (
                      <>
                        <BarChart3 className='mr-2 h-4 w-4' />
                        Run Load Test
                      </>
                    )}
                  </Button>
                </div>

                {loadTestResult && (
                  <Card className='border-muted bg-card/50'>
                    <CardHeader>
                      <div className='flex items-center justify-between'>
                        <CardTitle className='text-lg font-medium'>Load Test Results</CardTitle>
                        <Button
                          variant='outline'
                          size='sm'
                          onClick={() => setIsDistributionOpen(true)}
                          className='ml-auto'
                        >
                          View distribution
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent className='space-y-6'>
                      {/* Summary Stats */}
                      <div className='grid grid-cols-2 md:grid-cols-6 gap-4'>
                        <div className='text-center p-4 rounded-lg bg-muted/50'>
                          <div className='text-2xl font-bold text-primary'>
                            {loadTestResult.success_rate % 1 === 0
                              ? `${loadTestResult.success_rate.toFixed(0)}%`
                              : `${loadTestResult.success_rate.toFixed(1)}%`}
                          </div>
                          <div className='text-sm text-primary'>Success Rate</div>
                        </div>
                        <div className='text-center p-4 rounded-lg bg-muted/50'>
                          <div className='text-2xl font-bold text-green-600'>
                            {loadTestResult.successful_requests}
                            <span className='text-xs font-semibold text-green-600'>
                              /{loadTestResult.total_requests}
                            </span>
                          </div>
                          <div className='text-sm text-green-600'>Successful</div>
                        </div>
                        <div className='text-center p-4 rounded-lg bg-muted/50'>
                          <div className='text-2xl font-bold text-red-600'>
                            {loadTestResult.failed_requests}
                            <span className='text-xs font-semibold text-red-600'>
                              /{loadTestResult.total_requests}
                            </span>
                          </div>
                          <div className='text-sm text-red-600'>Failed</div>
                        </div>
                        <div className='text-center p-4 rounded-lg bg-muted/50'>
                          <div className='text-2xl font-bold text-blue-600'>
                            {(() => {
                              const total = loadTestResult.total_requests || 0;
                              const rate = total > 0 ? (cachedCount / total) * 100 : 0;
                              return rate % 1 === 0 ? `${rate.toFixed(0)}%` : `${rate.toFixed(1)}%`;
                            })()}
                          </div>
                          <div className='text-sm text-blue-600'>Cache Rate</div>
                        </div>
                        <div className='text-center p-4 rounded-lg bg-muted/50'>
                          <div className='text-2xl font-bold text-slate-400'>
                            {cachedCount}
                            <span className='text-xs font-semibold text-slate-400'>
                              /{loadTestResult.total_requests}
                            </span>
                          </div>
                          <div className='text-sm text-slate-400'>Cached</div>
                        </div>
                        <div className='text-center p-4 rounded-lg bg-muted/50'>
                          <div className='text-2xl font-bold text-slate-400'>
                            {nonCachedCount}
                            <span className='text-xs font-semibold text-slate-400'>
                              /{loadTestResult.total_requests}
                            </span>
                          </div>
                          <div className='text-sm text-slate-400'>Non-cached</div>
                        </div>
                      </div>

                      {/* Latency Stats */}
                      <div className='space-y-2'>
                        <h4 className='font-medium'>Latency Statistics (ms)</h4>
                        <div className='grid grid-cols-2 md:grid-cols-6 gap-4'>
                          <div className='text-center p-3 rounded-lg bg-muted/30'>
                            <div className='text-lg font-semibold text-green-600'>
                              {loadTestResult.latency_stats.min.toFixed(1)}
                            </div>
                            <div className='text-xs text-green-600'>Min</div>
                          </div>
                          <div className='text-center p-3 rounded-lg bg-muted/30'>
                            <div className='text-lg font-semibold text-red-600'>
                              {loadTestResult.latency_stats.max.toFixed(1)}
                            </div>
                            <div className='text-xs text-red-600'>Max</div>
                          </div>
                          <div className='text-center p-3 rounded-lg bg-muted/30'>
                            <div className='text-lg font-semibold text-sky-300'>
                              {loadTestResult.latency_stats.avg.toFixed(1)}
                            </div>
                            <div className='text-xs text-sky-300'>Average</div>
                          </div>
                          <div className='text-center p-3 rounded-lg bg-muted/30'>
                            <div className='text-lg font-semibold text-sky-400'>
                              {loadTestResult.latency_stats.p50.toFixed(1)}
                            </div>
                            <div className='text-xs text-sky-400'>P50</div>
                          </div>
                          <div className='text-center p-3 rounded-lg bg-muted/30'>
                            <div className='text-lg font-semibold text-blue-500'>
                              {loadTestResult.latency_stats.p90.toFixed(1)}
                            </div>
                            <div className='text-xs text-blue-500'>P90</div>
                          </div>
                          <div className='text-center p-3 rounded-lg bg-muted/30'>
                            <div className='text-lg font-semibold text-blue-800'>
                              {loadTestResult.latency_stats.p95.toFixed(1)}
                            </div>
                            <div className='text-xs text-blue-800'>P95</div>
                          </div>
                        </div>
                      </div>

                      {/* Failed Status Statistics - only show when failed filter is selected */}
                      {loadTestResult.responses.length > 0 &&
                        responseFilter === 'failed' &&
                        (() => {
                          const failedResponses = loadTestResult.responses.filter(r => !r.success);
                          if (failedResponses.length === 0) return null;

                          // Count status codes (exclude 0 which represents network errors)
                          const statusCounts: Record<number, number> = {};
                          failedResponses.forEach(resp => {
                            // Only count actual HTTP status codes (not 0 which means network error)
                            if (resp.status_code && resp.status_code > 0) {
                              statusCounts[resp.status_code] =
                                (statusCounts[resp.status_code] || 0) + 1;
                            }
                          });

                          // Calculate percentages
                          const statusStats = Object.entries(statusCounts)
                            .map(([status, count]) => ({
                              status: parseInt(status, 10),
                              count,
                              percentage: (count / failedResponses.length) * 100,
                            }))
                            .sort((a, b) => b.count - a.count);

                          return (
                            <div className='space-y-3'>
                              <h4 className='font-medium'>Failed Status Breakdown</h4>
                              <div className='grid grid-cols-2 md:grid-cols-4 gap-3'>
                                {statusStats.map(({ status, count, percentage }) => (
                                  <div
                                    key={status}
                                    className='text-center p-3 rounded-lg bg-red-50 border border-red-200'
                                  >
                                    <div className='text-lg font-semibold text-red-700'>
                                      {status}
                                    </div>
                                    <div className='text-xs text-red-600'>{count} requests</div>
                                    <div className='text-xs text-red-500'>
                                      {percentage.toFixed(1)}% of failed
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          );
                        })()}

                      {/* Responses with chip-style toggle */}
                      {loadTestResult.responses.length > 0 && (
                        <div className='space-y-3'>
                          <h4 className='font-medium'>Responses</h4>
                          <div className='flex items-center gap-3'>
                            <button
                              type='button'
                              onClick={() => setResponseFilter('successful')}
                              className={cn(
                                'px-3 py-1.5 rounded-full border-2 transition-all duration-200',
                                responseFilter === 'successful'
                                  ? 'border-primary bg-primary/10 text-primary'
                                  : 'border-border/50 bg-card hover:border-primary/50 hover:bg-primary/5',
                              )}
                            >
                              Successful
                            </button>
                            <button
                              type='button'
                              onClick={() => setResponseFilter('failed')}
                              className={cn(
                                'px-3 py-1.5 rounded-full border-2 transition-all duration-200',
                                responseFilter === 'failed'
                                  ? 'border-primary bg-primary/10 text-primary'
                                  : 'border-border/50 bg-card hover:border-primary/50 hover:bg-primary/5',
                              )}
                            >
                              Failed
                            </button>
                          </div>
                          <div className='space-y-2 max-h-60 overflow-y-auto'>
                            {loadTestResult.responses
                              .filter(r =>
                                responseFilter === 'successful' ? r.success : !r.success,
                              )
                              .map(resp => {
                                const responseText = resp.error
                                  ? resp.error
                                  : typeof resp.response_data === 'string'
                                    ? resp.response_data
                                    : JSON.stringify(resp.response_data, null, 2);
                                const originalIndex = loadTestResult.responses.indexOf(resp);
                                return (
                                  <Card
                                    key={`resp-${originalIndex}`}
                                    className='border-muted bg-card/50'
                                  >
                                    <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                                      <CardTitle className='text-lg font-medium'>
                                        Request #{originalIndex + 1}
                                      </CardTitle>
                                      <div className='flex items-center gap-3'>
                                        <div className='flex flex-col items-start gap-1 py-1'>
                                          <span className='flex items-center gap-1.5 text-sm font-medium'>
                                            {getStatusIcon(resp.status_code)}
                                            <span className={getStatusColor(resp.status_code)}>
                                              {resp.status_code}
                                            </span>
                                          </span>
                                          <span className='flex items-center gap-1.5 text-sm text-slate-300'>
                                            <Timer className='h-4 w-4 text-slate-400' />
                                            {resp.latency_ms.toFixed(1)}ms
                                          </span>
                                          {resp.headers &&
                                            (() => {
                                              const providerHeader =
                                                resp.headers['lava-provider-address'];
                                              return providerHeader ? (
                                                <div className='flex items-center gap-1.5 text-sm text-slate-400'>
                                                  <Server className='h-4 w-4 text-slate-400' />
                                                  <span className='truncate' title={providerHeader}>
                                                    {providerHeader.toLowerCase() === 'cached'
                                                      ? 'Cached'
                                                      : providerHeader}
                                                  </span>
                                                </div>
                                              ) : null;
                                            })()}
                                        </div>
                                        <Button
                                          variant='ghost'
                                          size='icon'
                                          onClick={() => {
                                            setCopiedResponseIndex(originalIndex);
                                            copyToClipboard(
                                              responseText,
                                              `Copied response #${originalIndex + 1}`,
                                            );
                                            setTimeout(() => setCopiedResponseIndex(null), 1200);
                                          }}
                                        >
                                          {copiedResponseIndex === originalIndex ? (
                                            <Check className='h-4 w-4 text-green-500' />
                                          ) : (
                                            <Copy className='h-4 w-4' />
                                          )}
                                        </Button>
                                      </div>
                                    </CardHeader>
                                    <CardContent>
                                      {resp.error ? (
                                        <div className='text-sm text-red-600 font-mono bg-red-50 p-3 rounded border'>
                                          {resp.error}
                                        </div>
                                      ) : (
                                        <>
                                          {renderInlineJson(
                                            typeof resp.response_data === 'string'
                                              ? resp.response_data
                                              : JSON.stringify(resp.response_data, null, 2),
                                            loadTestExpandedHeaders.has(originalIndex),
                                            () =>
                                              setLoadTestExpandedHeaders(prev =>
                                                new Set(prev).add(originalIndex),
                                              ),
                                            resp.headers,
                                          )}
                                        </>
                                      )}
                                    </CardContent>
                                  </Card>
                                );
                              })}
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )}

                {/* Provider distribution modal */}
                {loadTestResult && (
                  <ProviderDistributionModal
                    open={isDistributionOpen}
                    onOpenChange={setIsDistributionOpen}
                    chainId={selectedChain}
                    responses={loadTestResult.responses}
                    allProviders={(() => {
                      const providers = apiData?.consumers?.[selectedChain]?.providers || [];
                      return providers.map((p: any) => p.name);
                    })()}
                  />
                )}
              </div>
            </TabsContent>

            {showBatchTab && (
              <TabsContent value='batch' className='mt-6'>
                <div className='grid gap-6'>
                  <Card className='border-2 border-primary/20 bg-gradient-to-br from-card/50 to-card shadow-lg hover:shadow-xl transition-all duration-200'>
                    <CardHeader className='border-b border-border/20 bg-gradient-to-r from-primary/10 to-background pb-4'>
                      <CardTitle className='text-xl font-bold bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent'>
                        Configuration
                      </CardTitle>
                      <CardDescription>
                        Select a network and router for batch testing
                      </CardDescription>
                    </CardHeader>
                    <CardContent className='space-y-6 pt-6'>
                      {isFetching ? (
                        <div className='flex items-center justify-center py-8'>
                          <Loader2 className='h-6 w-6 animate-spin text-primary' />
                        </div>
                      ) : batchSupportedNetworks.length === 0 ? (
                        <div className='text-center py-8 text-muted-foreground'>
                          No chains with batch support are currently configured.
                        </div>
                      ) : (
                        <>
                          <div className='space-y-4'>
                            <Label className='text-sm font-medium'>Network</Label>
                            <div className='flex flex-wrap gap-3'>
                              {batchSupportedNetworks.map(net => {
                                const conf = chains.find(c => c.value === net);
                                const label = conf ? conf.label : getChainLabel(net);
                                const icon = conf ? conf.icon : getChainIcon(net);
                                const selected = selectedNetwork === net;
                                return (
                                  <button
                                    key={net}
                                    onClick={() => {
                                      if (selectedNetwork === net) return;
                                      setSelectedNetwork(net);
                                      const routers = batchSupportedChains.filter(c => c.network === net);
                                      if (routers.length === 1) {
                                        setSelectedChain(routers[0].id);
                                      } else {
                                        setSelectedChain('');
                                      }
                                      resetBatchRequests();
                                    }}
                                    className={cn(
                                      'flex items-center gap-3 p-3 rounded-lg border-2 transition-all duration-200 hover:border-primary/50 hover:bg-primary/5',
                                      selected
                                        ? 'border-primary bg-primary/10 shadow-lg'
                                        : 'border-border/50 bg-card',
                                    )}
                                  >
                                    <div className='flex-shrink-0 w-8 h-8 rounded-full bg-background/50 p-1.5'>
                                      {icon && (
                                        <img
                                          src={icon}
                                          alt={label}
                                          className='w-full h-full object-contain'
                                        />
                                      )}
                                    </div>
                                    <span className='font-medium'>{label}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          {selectedNetwork && batchRoutersForSelectedNetwork.length > 1 && (
                            <div className='space-y-4'>
                              <Label className='text-sm font-medium'>Router</Label>
                              <div className='flex flex-wrap gap-3'>
                                {batchRoutersForSelectedNetwork.map(router => {
                                  const selected = selectedChain === router.id;
                                  const conf = chains.find(c => c.value === selectedNetwork);
                                  const label = conf ? conf.label : getChainLabel(selectedNetwork);
                                  const icon = conf ? conf.icon : getChainIcon(selectedNetwork);
                                  return (
                                    <button
                                      key={router.id}
                                      onClick={() => {
                                        setSelectedChain(router.id);
                                        resetBatchRequests();
                                      }}
                                      className={cn(
                                        'flex items-center gap-3 p-3 rounded-lg border-2 transition-all duration-200 hover:border-primary/50 hover:bg-primary/5',
                                        selected
                                          ? 'border-primary bg-primary/10 shadow-lg'
                                          : 'border-border/50 bg-card',
                                      )}
                                    >
                                      <div className='flex-shrink-0 w-8 h-8 rounded-full bg-background/50 p-1.5'>
                                        {icon && (
                                          <img
                                            src={icon}
                                            alt={label}
                                            className='w-full h-full object-contain'
                                          />
                                        )}
                                      </div>
                                      <span className='font-medium'>{router.id}</span>
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {/* Mode Selection */}
                          <div className='space-y-4'>
                            <Label className='text-sm font-medium'>Mode</Label>
                            <div className='flex gap-3'>
                              <button
                                onClick={() => setBatchMode('single')}
                                className={cn(
                                  'px-4 py-2 rounded-lg border-2 transition-all duration-200',
                                  batchMode === 'single'
                                    ? 'border-primary bg-primary/10 text-primary font-medium'
                                    : 'border-border/50 bg-card hover:border-primary/50',
                                )}
                              >
                                Single Batch
                              </button>
                              <button
                                onClick={() => setBatchMode('load')}
                                className={cn(
                                  'px-4 py-2 rounded-lg border-2 transition-all duration-200',
                                  batchMode === 'load'
                                    ? 'border-primary bg-primary/10 text-primary font-medium'
                                    : 'border-border/50 bg-card hover:border-primary/50',
                                )}
                              >
                                Batch Load Test
                              </button>
                            </div>
                          </div>

                          {/* Skip Cache Option */}
                          <div className='flex items-center space-x-2'>
                            <input
                              type='checkbox'
                              id='skip-cache-batch'
                              checked={skipCache}
                              onChange={e => setSkipCache(e.target.checked)}
                              className='h-4 w-4 text-primary focus:ring-primary border-gray-300 rounded'
                            />
                            <Label htmlFor='skip-cache-batch' className='text-sm font-medium'>
                              Skip Cache
                            </Label>
                          </div>
                        </>
                      )}
                    </CardContent>
                  </Card>

                  {/* Batch Composition */}
                  {selectedChain && batchConfig && (
                    <Card className='border-muted bg-card/50'>
                      <CardHeader>
                        <CardTitle className='text-lg font-medium'>Batch Composition</CardTitle>
                        <CardDescription>
                          Add multiple JSON-RPC requests to send in a single batch
                        </CardDescription>
                      </CardHeader>
                      <CardContent className='space-y-4'>
                        {batchRequests.map((req, index) => (
                          <div
                            key={req.id}
                            className='flex items-start gap-3 p-4 rounded-lg border border-border/50 bg-muted/30'
                          >
                            <div className='flex-1 space-y-3'>
                              <div className='flex items-center gap-3'>
                                <span className='text-sm font-medium text-muted-foreground w-8'>
                                  #{index + 1}
                                </span>
                                <Select
                                  value={req.method || undefined}
                                  onValueChange={value => {
                                    const methodConfig = batchConfig.methods.find(m => m.method === value);
                                    let params: any = [];
                                    if (methodConfig) {
                                      try {
                                        params = JSON.parse(methodConfig.defaultParams);
                                      } catch {
                                        params = [];
                                      }
                                    }
                                    updateBatchRequest(req.id, { method: value, params });
                                  }}
                                >
                                  <SelectTrigger className='flex-1'>
                                    <SelectValue placeholder='Select method...' />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {batchConfig.methods.map(m => (
                                      <SelectItem key={m.method} value={m.method}>
                                        {m.label} ({m.method})
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                                <Input
                                  className='w-20'
                                  value={req.id}
                                  onChange={e => {
                                    const newId = parseInt(e.target.value) || req.id;
                                    updateBatchRequest(req.id, { id: newId });
                                  }}
                                  placeholder='ID'
                                  title='Request ID'
                                />
                                <Button
                                  variant='ghost'
                                  size='icon'
                                  onClick={() => removeBatchRequest(req.id)}
                                  disabled={batchRequests.length <= 1}
                                  className='text-muted-foreground hover:text-destructive'
                                >
                                  <Trash2 className='h-4 w-4' />
                                </Button>
                              </div>
                              {req.method && (
                                <div className='ml-11'>
                                  <Label className='text-xs text-muted-foreground'>Params (JSON)</Label>
                                  <Input
                                    className='font-mono text-sm'
                                    value={JSON.stringify(req.params)}
                                    onChange={e => {
                                      try {
                                        const params = JSON.parse(e.target.value);
                                        updateBatchRequest(req.id, { params });
                                      } catch {
                                        // Keep as string if not valid JSON
                                      }
                                    }}
                                    placeholder='[]'
                                  />
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                        <Button
                          variant='outline'
                          onClick={addBatchRequest}
                          className='w-full'
                        >
                          <Plus className='h-4 w-4 mr-2' />
                          Add Request
                        </Button>

                        {/* Quick Templates */}
                        {batchConfig.methods.length > 0 && (
                          <div className='pt-4 border-t border-border/50'>
                            <Label className='text-sm font-medium mb-2 block'>Quick Templates</Label>
                            <div className='flex flex-wrap gap-2'>
                              <Button
                                variant='outline'
                                size='sm'
                                onClick={() => {
                                  // Add first 3 methods as a quick template
                                  const templateMethods = batchConfig.methods.slice(0, 3);
                                  setBatchRequests(
                                    templateMethods.map((m, i) => ({
                                      id: i + 1,
                                      method: m.method,
                                      params: JSON.parse(m.defaultParams),
                                    }))
                                  );
                                }}
                              >
                                Quick Start (3 methods)
                              </Button>
                              <Button
                                variant='outline'
                                size='sm'
                                onClick={() => {
                                  // Add all available methods
                                  setBatchRequests(
                                    batchConfig.methods.map((m, i) => ({
                                      id: i + 1,
                                      method: m.method,
                                      params: JSON.parse(m.defaultParams),
                                    }))
                                  );
                                }}
                              >
                                All Methods ({batchConfig.methods.length})
                              </Button>
                            </div>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )}

                  {/* Load Test Settings */}
                  {selectedChain && batchMode === 'load' && (
                    <Card className='border-muted bg-card/50'>
                      <CardHeader>
                        <CardTitle className='text-lg font-medium'>Batch Load Test Settings</CardTitle>
                        <CardDescription>
                          Configure the number of batch requests for load testing
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <div className='space-y-4'>
                          <div className='space-y-2'>
                            <Label htmlFor='numberOfBatches' className='text-sm font-medium'>
                              Number of Batches (1-500)
                            </Label>
                            <Input
                              id='numberOfBatches'
                              type='number'
                              min={1}
                              max={500}
                              value={numberOfBatches}
                              onChange={e =>
                                setNumberOfBatches(
                                  Math.max(1, Math.min(500, parseInt(e.target.value) || 1)),
                                )
                              }
                              className='w-32'
                              disabled={isBatchTesting}
                            />
                          </div>
                          <div className='space-y-2'>
                            <Label htmlFor='batchConcurrency' className='text-sm font-medium'>
                              Concurrency (1-100)
                            </Label>
                            <Input
                              id='batchConcurrency'
                              type='number'
                              min={1}
                              max={100}
                              value={batchConcurrency}
                              onChange={e =>
                                setBatchConcurrency(
                                  Math.max(1, Math.min(100, parseInt(e.target.value) || 5)),
                                )
                              }
                              className='w-32'
                              disabled={isBatchTesting}
                            />
                          </div>
                          <p className='text-sm text-muted-foreground'>
                            Load test will run {numberOfBatches} batch requests with up to {batchConcurrency}{' '}
                            concurrent requests.
                          </p>
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  {/* Endpoint */}
                  {selectedChain && batchEndpointUrl && (
                    <Card className='border-muted bg-card/50'>
                      <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                        <CardTitle className='text-lg font-medium'>Endpoint</CardTitle>
                        <Button
                          variant='ghost'
                          size='icon'
                          onClick={() => {
                            setCopiedBatchEndpoint(true);
                            copyToClipboard(batchEndpointUrl, 'Copied endpoint URL');
                            setTimeout(() => setCopiedBatchEndpoint(false), 1200);
                          }}
                        >
                          {copiedBatchEndpoint ? (
                            <Check className='h-4 w-4 text-green-500' />
                          ) : (
                            <Copy className='h-4 w-4' />
                          )}
                        </Button>
                      </CardHeader>
                      <CardContent>
                        <div className='rounded-lg bg-muted p-4 font-mono text-sm overflow-x-auto whitespace-pre-wrap break-all'>
                          {batchEndpointUrl}
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  {/* Batch cURL Command */}
                  {selectedChain && batchCurlCommand && (
                    <Card className='border-muted bg-card/50'>
                      <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                        <CardTitle className='text-lg font-medium'>Batch Test Command</CardTitle>
                        <Button
                          variant='ghost'
                          size='icon'
                          onClick={() => {
                            setCopiedBatchCurl(true);
                            copyToClipboard(batchCurlCommand, 'Copied batch curl command');
                            setTimeout(() => setCopiedBatchCurl(false), 1200);
                          }}
                        >
                          {copiedBatchCurl ? (
                            <Check className='h-4 w-4 text-green-500' />
                          ) : (
                            <Copy className='h-4 w-4' />
                          )}
                        </Button>
                      </CardHeader>
                      <CardContent>
                        <pre className='rounded-lg bg-muted p-4 font-mono text-sm overflow-x-auto whitespace-pre-wrap break-all'>
                          {batchCurlCommand}
                        </pre>
                      </CardContent>
                    </Card>
                  )}

                  {/* Run Button */}
                  <div className='flex justify-end space-x-4'>
                    <Button
                      onClick={handleBatchTest}
                      disabled={isBatchTesting || !selectedChain || batchRequests.every(r => !r.method)}
                      className='bg-primary hover:bg-primary/90'
                    >
                      {isBatchTesting ? (
                        <>
                          <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                          {batchMode === 'single' ? 'Running Batch...' : 'Running Load Test...'}
                        </>
                      ) : (
                        <>
                          <Layers className='mr-2 h-4 w-4' />
                          {batchMode === 'single' ? 'Run Batch Request' : 'Run Batch Load Test'}
                        </>
                      )}
                    </Button>
                  </div>

                  {/* Single Batch Results */}
                  {batchResult && batchMode === 'single' && (
                    <Card className='border-muted bg-card/50'>
                      <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                        <div>
                          <CardTitle className='text-lg font-medium'>Batch Response</CardTitle>
                          <CardDescription>
                            {batchResult.responses.filter(r => r.success).length}/{batchResult.responses.length} successful
                            {batchResult.truncated && ' • Response truncated'}
                          </CardDescription>
                        </div>
                        <div className='flex items-center gap-3'>
                          <div className='flex flex-col items-start gap-1 py-1'>
                            <span className='flex items-center gap-1.5 text-sm font-medium'>
                              {getStatusIcon(batchResult.status_code)}
                              <span className={getStatusColor(batchResult.status_code)}>
                                {batchResult.status_code}
                              </span>
                            </span>
                            <span className='flex items-center gap-1.5 text-sm text-slate-300'>
                              <Timer className='h-4 w-4 text-slate-400' />
                              {batchResult.latency_ms.toFixed(1)}ms
                            </span>
                            {(() => {
                              const providerHeader = Object.keys(batchResult.headers || {}).find(
                                key => key.toLowerCase() === 'lava-provider-address',
                              );
                              const providerValue = providerHeader ? batchResult.headers[providerHeader] : null;
                              return providerValue ? (
                                <div className='flex items-center gap-1.5 text-sm text-slate-400'>
                                  <Server className='h-4 w-4 text-slate-400' />
                                  <span className='truncate' title={providerValue}>
                                    {providerValue.toLowerCase() === 'cached' ? 'Cached' : providerValue}
                                  </span>
                                </div>
                              ) : null;
                            })()}
                          </div>
                          <Button
                            variant='ghost'
                            size='icon'
                            onClick={() => {
                              const fullResponse = batchResult.responses.map(r => 
                                r.error 
                                  ? { jsonrpc: '2.0', id: r.id, error: r.error }
                                  : { jsonrpc: '2.0', id: r.id, result: r.result }
                              );
                              copyToClipboard(JSON.stringify(fullResponse, null, 2), 'Copied batch response');
                            }}
                          >
                            <Copy className='h-4 w-4' />
                          </Button>
                        </div>
                      </CardHeader>
                      <CardContent className='space-y-4'>
                        {batchResult.responses.map((resp) => (
                          <div
                            key={resp.id}
                            className='rounded-lg border border-border/50 overflow-hidden'
                          >
                            <div className='flex items-center gap-3 p-3 bg-muted/30 border-b border-border/50'>
                              {resp.success ? (
                                <CheckCircle2 className='h-4 w-4 text-green-600' />
                              ) : (
                                <XCircle className='h-4 w-4 text-red-600' />
                              )}
                              <span className='font-mono text-sm font-medium'>{resp.method}</span>
                              <span className='text-muted-foreground text-sm'>ID: {resp.id}</span>
                            </div>
                            <div className='p-4'>
                              <div className='text-sm font-medium text-muted-foreground mb-2'>
                                Response
                              </div>
                              <pre className='rounded-lg bg-muted p-4 font-mono text-sm overflow-x-auto whitespace-pre-wrap break-all'>
                                <code>
                                  {JSON.stringify(
                                    resp.error
                                      ? { jsonrpc: '2.0', id: resp.id, error: resp.error }
                                      : { jsonrpc: '2.0', id: resp.id, result: resp.result },
                                    null,
                                    2
                                  )}
                                </code>
                              </pre>
                            </div>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  )}

                  {/* Batch Load Test Results */}
                  {batchLoadTestResult && batchMode === 'load' && (
                    <Card className='border-muted bg-card/50'>
                      <CardHeader>
                        <div className='flex items-center justify-between'>
                          <CardTitle className='text-lg font-medium'>Batch Load Test Results</CardTitle>
                          <Button
                            variant='outline'
                            size='sm'
                            onClick={() => setIsBatchDistributionOpen(true)}
                            className='ml-auto'
                          >
                            View distribution
                          </Button>
                        </div>
                      </CardHeader>
                      <CardContent className='space-y-6'>
                        {/* Summary Stats */}
                        <div className='grid grid-cols-2 md:grid-cols-4 gap-4'>
                          <div className='text-center p-4 rounded-lg bg-muted/50'>
                            <div className='text-2xl font-bold text-primary'>
                              {batchLoadTestResult.batch_success_rate % 1 === 0
                                ? `${batchLoadTestResult.batch_success_rate.toFixed(0)}%`
                                : `${batchLoadTestResult.batch_success_rate.toFixed(1)}%`}
                            </div>
                            <div className='text-sm text-primary'>Success Rate</div>
                          </div>
                          <div className='text-center p-4 rounded-lg bg-muted/50'>
                            <div className='text-2xl font-bold text-green-600'>
                              {batchLoadTestResult.successful_batches}
                              <span className='text-xs font-semibold'>
                                /{batchLoadTestResult.total_batches}
                              </span>
                            </div>
                            <div className='text-sm text-green-600'>Successful Batches</div>
                          </div>
                          <div className='text-center p-4 rounded-lg bg-muted/50'>
                            <div className='text-2xl font-bold text-red-600'>
                              {batchLoadTestResult.failed_batches}
                              <span className='text-xs font-semibold'>
                                /{batchLoadTestResult.total_batches}
                              </span>
                            </div>
                            <div className='text-sm text-red-600'>Failed Batches</div>
                          </div>
                          <div className='text-center p-4 rounded-lg bg-muted/50'>
                            <div className='text-2xl font-bold text-blue-600'>
                              {(() => {
                                const total = batchLoadTestResult.total_batches || 0;
                                const cached = batchLoadTestResult.cached_count || 0;
                                const rate = total > 0 ? (cached / total) * 100 : 0;
                                return rate % 1 === 0 ? `${rate.toFixed(0)}%` : `${rate.toFixed(1)}%`;
                              })()}
                            </div>
                            <div className='text-sm text-blue-600'>Cache Rate</div>
                          </div>
                        </div>

                        {/* Latency Stats */}
                        <div className='space-y-2'>
                          <h4 className='font-medium'>Latency Statistics (ms per batch)</h4>
                          <div className='grid grid-cols-2 md:grid-cols-6 gap-4'>
                            <div className='text-center p-3 rounded-lg bg-muted/30'>
                              <div className='text-lg font-semibold text-green-600'>
                                {batchLoadTestResult.latency_stats.min.toFixed(1)}
                              </div>
                              <div className='text-xs text-green-600'>Min</div>
                            </div>
                            <div className='text-center p-3 rounded-lg bg-muted/30'>
                              <div className='text-lg font-semibold text-red-600'>
                                {batchLoadTestResult.latency_stats.max.toFixed(1)}
                              </div>
                              <div className='text-xs text-red-600'>Max</div>
                            </div>
                            <div className='text-center p-3 rounded-lg bg-muted/30'>
                              <div className='text-lg font-semibold text-sky-300'>
                                {batchLoadTestResult.latency_stats.avg.toFixed(1)}
                              </div>
                              <div className='text-xs text-sky-300'>Average</div>
                            </div>
                            <div className='text-center p-3 rounded-lg bg-muted/30'>
                              <div className='text-lg font-semibold text-sky-400'>
                                {batchLoadTestResult.latency_stats.p50.toFixed(1)}
                              </div>
                              <div className='text-xs text-sky-400'>P50</div>
                            </div>
                            <div className='text-center p-3 rounded-lg bg-muted/30'>
                              <div className='text-lg font-semibold text-blue-500'>
                                {batchLoadTestResult.latency_stats.p90.toFixed(1)}
                              </div>
                              <div className='text-xs text-blue-500'>P90</div>
                            </div>
                            <div className='text-center p-3 rounded-lg bg-muted/30'>
                              <div className='text-lg font-semibold text-blue-800'>
                                {batchLoadTestResult.latency_stats.p95.toFixed(1)}
                              </div>
                              <div className='text-xs text-blue-800'>P95</div>
                            </div>
                          </div>
                        </div>

                        {/* Per-Method Stats */}
                        <div className='space-y-3'>
                          <h4 className='font-medium'>Per-Method Breakdown</h4>
                          <div className='space-y-2'>
                            {Object.values(batchLoadTestResult.method_stats).map(stats => (
                              <div
                                key={stats.method}
                                className='flex items-center justify-between p-3 rounded-lg bg-muted/30'
                              >
                                <span className='font-mono text-sm'>{stats.method}</span>
                                <div className='flex items-center gap-4 text-sm'>
                                  <span className='text-green-600'>
                                    {stats.successful}/{stats.total} successful
                                  </span>
                                  <span className={cn(
                                    'font-medium',
                                    stats.successRate >= 90 ? 'text-green-600' :
                                    stats.successRate >= 70 ? 'text-yellow-600' : 'text-red-600'
                                  )}>
                                    {stats.successRate.toFixed(1)}%
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  {/* Provider distribution modal for batch load test */}
                  {batchLoadTestResult && (
                    <ProviderDistributionModal
                      open={isBatchDistributionOpen}
                      onOpenChange={setIsBatchDistributionOpen}
                      chainId={selectedChain}
                      responses={batchLoadTestResult.responses.map(r => ({
                        status_code: r.status_code,
                        latency_ms: r.latency_ms,
                        success: r.success,
                        headers: r.headers,
                      }))}
                      allProviders={(() => {
                        const providers = apiData?.consumers?.[selectedChain]?.providers || [];
                        return providers.map((p: any) => p.name);
                      })()}
                    />
                  )}
                </div>
              </TabsContent>
            )}

            <TabsContent value='cross' className='mt-6'>
              <div className='grid gap-6'>
                <Card className='border-2 border-primary/20 bg-gradient-to-br from-card/50 to-card shadow-lg hover:shadow-xl transition-all duration-200'>
                  <CardHeader className='border-b border-border/20 bg-gradient-to-r from-primary/10 to-background pb-4'>
                    <CardTitle className='text-xl font-bold bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent'>
                      Configuration
                    </CardTitle>
                    <CardDescription>
                      Select a network, router and interface to test
                    </CardDescription>
                  </CardHeader>
                  <CardContent className='space-y-6 pt-6'>
                    {isFetching ? (
                      <div className='flex items-center justify-center py-8'>
                        <Loader2 className='h-6 w-6 animate-spin text-primary' />
                      </div>
                    ) : (
                      <>
                        <div className='space-y-4'>
                          <Label className='text-sm font-medium'>Network</Label>
                          <div className='flex flex-wrap gap-3'>
                            {networks.map(net => {
                              const conf = chains.find(c => c.value === net);
                              const label = conf ? conf.label : getChainLabel(net);
                              const icon = conf ? conf.icon : getChainIcon(net);
                              const selected = selectedNetwork === net;
                              return (
                                <button
                                  key={net}
                                  onClick={() => {
                                    if (selectedNetwork === net) return;
                                    setSelectedNetwork(net);
                                    const routers = availableChains.filter(c => c.network === net);
                                    if (routers.length === 1) {
                                      setSelectedChain(routers[0].id);
                                    } else {
                                      setSelectedChain('');
                                    }
                                    setSelectedInterface('');
                                    setCrossValidationResponse('');
                                  }}
                                  className={cn(
                                    'flex items-center gap-3 p-3 rounded-lg border-2 transition-all duration-200 hover:border-primary/50 hover:bg-primary/5',
                                    selected
                                      ? 'border-primary bg-primary/10 shadow-lg'
                                      : 'border-border/50 bg-card',
                                  )}
                                >
                                  <div className='flex-shrink-0 w-8 h-8 rounded-full bg-background/50 p-1.5'>
                                    {icon && (
                                      <img
                                        src={icon}
                                        alt={label}
                                        className='w-full h-full object-contain'
                                      />
                                    )}
                                  </div>
                                  <span className='font-medium'>{label}</span>
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        {selectedNetwork && routersForSelectedNetwork.length > 1 && (
                          <div className='space-y-4'>
                            <Label className='text-sm font-medium'>Router</Label>
                            <div className='flex flex-wrap gap-3'>
                              {routersForSelectedNetwork.map(router => {
                                const selected = selectedChain === router.id;
                                const conf = chains.find(c => c.value === selectedNetwork);
                                const label = conf ? conf.label : getChainLabel(selectedNetwork);
                                const icon = conf ? conf.icon : getChainIcon(selectedNetwork);
                                return (
                                  <button
                                    key={router.id}
                                    onClick={() => {
                                      setSelectedChain(router.id);
                                      setSelectedInterface('');
                                      setCrossValidationResponse('');
                                    }}
                                    className={cn(
                                      'flex items-center gap-3 p-3 rounded-lg border-2 transition-all duration-200 hover:border-primary/50 hover:bg-primary/5',
                                      selected
                                        ? 'border-primary bg-primary/10 shadow-lg'
                                        : 'border-border/50 bg-card',
                                    )}
                                  >
                                    <div className='flex-shrink-0 w-8 h-8 rounded-full bg-background/50 p-1.5'>
                                      {icon && (
                                        <img
                                          src={icon}
                                          alt={label}
                                          className='w-full h-full object-contain'
                                        />
                                      )}
                                    </div>
                                    <span className='font-medium'>{router.id}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {selectedChain && (
                          <div className='space-y-4'>
                            <Label className='text-sm font-medium'>Interface</Label>
                            <div className='flex flex-wrap gap-2'>
                              {configuredInterfaces.map(iface => {
                                const displayName =
                                  iface === 'jsonrpc'
                                    ? 'JSON-RPC'
                                    : iface === 'tendermintrpc'
                                      ? 'TendermintRPC'
                                      : iface === 'rest'
                                        ? 'REST'
                                        : iface === 'grpc'
                                          ? 'gRPC'
                                          : iface;
                                return (
                                  <Button
                                    key={iface}
                                    variant={selectedInterface === iface ? 'default' : 'outline'}
                                    size='sm'
                                    className={cn(
                                      selectedInterface === iface &&
                                        (iface === 'jsonrpc'
                                          ? 'bg-blue-500 hover:bg-blue-600'
                                          : iface === 'tendermintrpc'
                                            ? 'bg-green-500 hover:bg-green-600'
                                            : iface === 'rest'
                                              ? 'bg-purple-500 hover:bg-purple-600'
                                              : iface === 'grpc'
                                                ? 'bg-orange-500 hover:bg-orange-600'
                                                : ''),
                                      'hover:opacity-90',
                                    )}
                                    onClick={() => {
                                      setSelectedInterface(iface);
                                      setSelectedRequestType('regular');
                                      setCrossValidationResponse('');
                                    }}
                                  >
                                    {displayName}
                                  </Button>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Skip Cache Option */}
                        <div className='space-y-4'>
                          <div className='flex items-center space-x-2'>
                            <input
                              type='checkbox'
                              id='skip-cache-cross-config'
                              checked={skipCache}
                              onChange={e => setSkipCache(e.target.checked)}
                              className='h-4 w-4 text-primary focus:ring-primary border-gray-300 rounded'
                            />
                            <Label
                              htmlFor='skip-cache-cross-config'
                              className='text-sm font-medium'
                            >
                              Skip Cache
                            </Label>
                          </div>
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>

                {selectedChain && selectedInterface && (
                  <Card className='border-muted bg-card/50'>
                    <CardHeader>
                      <CardTitle className='text-lg font-medium'>
                        Cross Validation Configuration
                      </CardTitle>
                      <CardDescription>Configure cross validation parameters</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <div className='space-y-6'>
                        <div className='space-y-2'>
                          <Label htmlFor='crossValidationMin' className='text-sm font-medium'>
                            Minimum: {crossValidationMin}
                          </Label>
                          <input
                            id='crossValidationMin'
                            type='range'
                            min='1'
                            max={crossValidationMax}
                            value={crossValidationMin}
                            onChange={e => setCrossValidationMin(parseInt(e.target.value))}
                            className='w-full'
                            disabled={isCrossValidating || maxProvidersForNetwork === 1}
                          />
                        </div>
                        <div className='space-y-2'>
                          <Label htmlFor='crossValidationMax' className='text-sm font-medium'>
                            Maximum: {crossValidationMax}
                          </Label>
                          <input
                            id='crossValidationMax'
                            type='range'
                            min='1'
                            max={maxProvidersForNetwork}
                            value={crossValidationMax}
                            onChange={e => {
                              const newMax = parseInt(e.target.value);
                              setCrossValidationMax(newMax);
                              // If minimum is higher than new maximum, adjust it
                              if (crossValidationMin > newMax) {
                                setCrossValidationMin(newMax);
                              }
                            }}
                            className='w-full'
                            disabled={isCrossValidating || maxProvidersForNetwork === 1}
                          />
                        </div>
                        <div className='space-y-2'>
                          <Label htmlFor='crossValidationRate' className='text-sm font-medium'>
                            Rate: {crossValidationRate.toFixed(2)}
                          </Label>
                          <input
                            id='crossValidationRate'
                            type='range'
                            min='0'
                            max='1'
                            step='0.01'
                            value={crossValidationRate}
                            onChange={e => setCrossValidationRate(parseFloat(e.target.value))}
                            className='w-full'
                            disabled={isCrossValidating || maxProvidersForNetwork === 1}
                          />
                        </div>
                        {maxProvidersForNetwork === 1 ? (
                          <p className='text-sm text-muted-foreground'>
                            Cross validation is not available for this network as it only has 1
                            provider configured.
                          </p>
                        ) : (
                          <p className='text-sm text-muted-foreground'>
                            Cross validation will test with minimum: {crossValidationMin}, maximum:{' '}
                            {crossValidationMax}, rate: {crossValidationRate.toFixed(2)}
                          </p>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                )}

                {selectedChain && selectedInterface && maxProvidersForNetwork > 1 && (
                  <Card className='border-muted bg-card/50'>
                    <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                      <CardTitle className='text-lg font-medium'>Test Command</CardTitle>
                      <Button
                        variant='ghost'
                        size='icon'
                        onClick={() => {
                          setCopiedCurl(true);
                          copyToClipboard(crossValidationCurlCommand, 'Copied curl command');
                          setTimeout(() => setCopiedCurl(false), 1200);
                        }}
                      >
                        {copiedCurl ? (
                          <Check className='h-4 w-4 text-green-500' />
                        ) : (
                          <Copy className='h-4 w-4' />
                        )}
                      </Button>
                    </CardHeader>
                    <CardContent>
                      <pre className='rounded-lg bg-muted p-4 font-mono text-sm overflow-x-auto whitespace-pre-wrap break-all'>
                        {crossValidationCurlCommand}
                      </pre>
                    </CardContent>
                  </Card>
                )}

                <div className='flex justify-end space-x-4'>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div>
                          <Button
                            onClick={handleCrossValidation}
                            disabled={
                              isCrossValidating ||
                              !selectedChain ||
                              !selectedInterface ||
                              maxProvidersForNetwork === 1
                            }
                            className='bg-primary hover:bg-primary/90'
                          >
                            {isCrossValidating ? (
                              <>
                                <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                                Cross Validating...
                              </>
                            ) : (
                              <>
                                <Shield className='mr-2 h-4 w-4' />
                                Cross Validation
                              </>
                            )}
                          </Button>
                        </div>
                      </TooltipTrigger>
                      {maxProvidersForNetwork === 1 && (
                        <TooltipContent>
                          <p>Cross validation requires at least 2 providers</p>
                        </TooltipContent>
                      )}
                    </Tooltip>
                  </TooltipProvider>
                </div>

                {crossValidationResponse && (
                  <Card className='border-muted bg-card/50'>
                    <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                      <CardTitle className='text-lg font-medium'>
                        Cross Validation Response
                      </CardTitle>
                      <div className='flex items-center gap-3'>
                        <div className='flex flex-col items-start gap-1 py-1'>
                          {crossValidationStatus && (
                            <span className='flex items-center gap-1.5 text-sm font-medium'>
                              {getStatusIcon(crossValidationStatus)}
                              <span className={getStatusColor(crossValidationStatus)}>
                                {crossValidationStatus}
                              </span>
                            </span>
                          )}
                          {crossValidationLatency && (
                            <span className='flex items-center gap-1.5 text-sm text-slate-300'>
                              <Timer className='h-4 w-4 text-slate-400' />
                              {crossValidationLatency.toFixed(1)}ms
                            </span>
                          )}
                          {crossValidationProvider && (
                            <div className='flex items-center gap-1.5 text-sm text-slate-400'>
                              <Server className='h-4 w-4 text-slate-400' />
                              <span className='truncate' title={crossValidationProvider}>
                                {crossValidationProvider.toLowerCase() === 'cached'
                                  ? 'Cached'
                                  : crossValidationProvider}
                              </span>
                            </div>
                          )}
                        </div>
                        <Button
                          variant='ghost'
                          size='icon'
                          onClick={() => {
                            setCopiedSingleResponse(true);
                            copyToClipboard(
                              crossValidationResponse,
                              'Copied cross validation response',
                            );
                            setTimeout(() => setCopiedSingleResponse(false), 1200);
                          }}
                        >
                          {copiedSingleResponse ? (
                            <Check className='h-4 w-4 text-green-500' />
                          ) : (
                            <Copy className='h-4 w-4' />
                          )}
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent>
                      {crossValidationResponseTruncated && (
                        <div className='mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800'>
                          Response was truncated for safety (payload too large).
                        </div>
                      )}
                      {renderInlineJson(
                        crossValidationResponse,
                        crossValidationHeadersExpanded,
                        () => setCrossValidationHeadersExpanded(true),
                        crossValidationHeaders,
                      )}
                    </CardContent>
                  </Card>
                )}
              </div>
            </TabsContent>
          </Tabs>
        </div>
        <Toaster />
      </div>
    </ProtectedRoute>
  );
}
