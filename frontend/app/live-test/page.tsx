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
} from 'lucide-react';
import { chains } from '@/app/config/chains';
import { cn } from '@/lib/utils';
import { chainTypes } from '@/app/config/chain-types';
import { ProtectedRoute } from '@/components/protected-route';
import { apiClient } from '@/lib/api-client';
import { getChainIcon, getChainLabel } from '@/app/config/chains';
import { MetricsService } from '@/services/metricsService';
import ProviderDistributionModal from '@/components/ProviderDistributionModal';
import { makeTestRequest, makeLoadTestRequests, calculateLoadTestStats } from '@/lib/test-client';

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
  const [endpointUrl, setEndpointUrl] = useState<string>('');
  const [configuredInterfaces, setConfiguredInterfaces] = useState<string[]>([]);
  const [configuredRequestTypes, setConfiguredRequestTypes] = useState<string[]>([]);
  const [apiData, setApiData] = useState<ApiResponse | null>(null);

  // Load test state
  const [numberOfRequests, setNumberOfRequests] = useState<number>(50);
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

  // Load test headers state - track which responses have expanded headers
  const [loadTestExpandedHeaders, setLoadTestExpandedHeaders] = useState<Set<number>>(new Set());

  // Cross validation headers state
  const [crossValidationHeadersExpanded, setCrossValidationHeadersExpanded] =
    useState<boolean>(false);

  // Helper: prettify header values that contain JSON or escaped JSON
  const parseHeaderValue = (val: string): any => {
    if (typeof val !== 'string') return val;
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
  const [crossValidationRate, setCrossValidationRate] = useState<number>(0.5);
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
  const [activeTab, setActiveTab] = useState<'single' | 'load' | 'cross'>('single');

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

  useEffect(() => {
    const fetchChains = async () => {
      if (!config.apiEndpoint) {
        setIsFetching(false);
        return;
      }

      try {
        // 1) interfaces source (keep as-is for per-chain interfaces)
        const data: ApiResponse = await apiClient.get(`/api/components/`);
        setApiData(data);

        // 2) networks and routers list from metrics API
        const chainsResponse = await MetricsService.fetchMetricsForAllChains(1, 1);
        const chainsData = Object.entries(chainsResponse.chains).map(
          ([chainId, chainMetrics]: [string, any]) => ({
            id: chainId,
            network: chainMetrics.network,
          }),
        );
        setAvailableChains(chainsData);

        // default select first network if any
        if (chainsData.length > 0) {
          setSelectedNetwork(chainsData[0].network);
          const routers = chainsData.filter(c => c.network === chainsData[0].network);
          if (routers.length === 1) {
            setSelectedChain(routers[0].id);
          } else {
            setSelectedChain('');
          }
        }
      } catch (error) {
        console.error('Fetch error:', error);
        setError(error instanceof Error ? error.message : 'Failed to fetch chains');
      } finally {
        setIsFetching(false);
      }
    };

    fetchChains();
  }, [config.apiEndpoint]);

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
    if (selectedChain && selectedInterface && apiData) {
      const apiEndpoint = config.apiEndpoint;

      // Get the network from the API data instead of parsing chain ID
      const selectedChainData = apiData.consumers[selectedChain];
      if (!selectedChainData || !selectedChainData.network) return;

      const baseNetwork = selectedChainData.network;
      const chain = chains.find(c => c.value === baseNetwork);
      if (!chain) return;

      const chainType = chainTypes.find(t => t.value === chain.type);
      if (!chainType) return;

      // For jsonrpc/wss, use jsonrpc interface commands
      const actualInterface = selectedInterface === 'jsonrpc/wss' ? 'jsonrpc' : selectedInterface;
      const interfaceCommands = chainType.interfaces[actualInterface];
      if (!interfaceCommands) return;

      const interfaceCommand = interfaceCommands[selectedRequestType];
      if (!interfaceCommand) return;

      const domain = process.env.NEXT_PUBLIC_DOMAIN || 'lava.lavapro.xyz';
      const port = process.env.NEXT_PUBLIC_PORT || '8443';

      const curlHost = `${selectedChain}-${actualInterface}.${domain}`;
      // Use wss:// protocol with /websocket path for WebSocket connections
      const endpoint =
        selectedInterface === 'jsonrpc/wss'
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
      if (selectedInterface === 'jsonrpc/wss') {
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
    config.apiEndpoint,
    skipCache,
    apiData,
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

    if (numberOfRequests < 1 || numberOfRequests > 200) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Number of requests must be between 1 and 200',
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

      // For jsonrpc/wss, use jsonrpc interface commands
      const actualInterface = selectedInterface === 'jsonrpc/wss' ? 'jsonrpc' : selectedInterface;
      const interfaceCommands = chainType.interfaces[actualInterface];
      if (!interfaceCommands) throw new Error('Interface not found');

      const interfaceCommand = interfaceCommands[selectedRequestType];
      if (!interfaceCommand) throw new Error('Request type command not found');

      // Make direct requests to provider endpoint
      const domain = process.env.NEXT_PUBLIC_DOMAIN || 'lava.lavapro.xyz';
      const port = process.env.NEXT_PUBLIC_PORT || '8443';

      const responses = await makeLoadTestRequests(
        {
          chainId: selectedChain,
          interface: actualInterface,
          interfaceCommand,
          domain,
          port,
          skipCache,
          requestType: selectedRequestType,
        },
        numberOfRequests,
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

    setIsCrossValidating(true);
    setCrossValidationResponse('');
    setCrossValidationStatus(null);
    setCrossValidationLatency(null);
    setCrossValidationProvider(null);
    setCrossValidationHeaders(null);
    setCrossValidationHeadersExpanded(false);

    try {
      const baseNetwork = getNetworkFromChainId(selectedChain);
      if (!baseNetwork) throw new Error('Network not found for chain');
      const chain = chains.find(c => c.value === baseNetwork);
      if (!chain) throw new Error('Chain not found');

      const chainType = chainTypes.find(t => t.value === chain.type);
      if (!chainType) throw new Error('Chain type not found');

      // For jsonrpc/wss, use jsonrpc interface commands
      const actualInterface = selectedInterface === 'jsonrpc/wss' ? 'jsonrpc' : selectedInterface;
      const interfaceCommands = chainType.interfaces[actualInterface];
      if (!interfaceCommands) throw new Error('Interface not found');

      const interfaceCommand = interfaceCommands[selectedRequestType];
      if (!interfaceCommand) throw new Error('Request type command not found');

      // Make direct request to provider endpoint with quorum headers
      const domain = process.env.NEXT_PUBLIC_DOMAIN || 'lava.lavapro.xyz';
      const port = process.env.NEXT_PUBLIC_PORT || '8443';

      const response = await makeTestRequest({
        chainId: selectedChain,
        interface: actualInterface,
        interfaceCommand,
        domain,
        port,
        skipCache,
        requestType: selectedRequestType,
        quorumMin: crossValidationMin,
        quorumMax: crossValidationMax,
        quorumRate: crossValidationRate,
      });

      // Handle both string and object response_data
      const responseData = response.response_data;
      let formattedResponse: string;

      // Recursive function to parse nested JSON strings
      const parseNestedJson = (obj: any): any => {
        if (typeof obj === 'string') {
          try {
            const parsed = JSON.parse(obj);
            return parseNestedJson(parsed); // Recursively parse nested JSON
          } catch {
            // Try to handle escaped JSON strings
            try {
              const unescaped = obj.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
              const parsed = JSON.parse(unescaped);
              return parseNestedJson(parsed);
            } catch {
              return obj; // Return as-is if can't parse
            }
          }
        } else if (Array.isArray(obj)) {
          return obj.map(parseNestedJson);
        } else if (obj && typeof obj === 'object') {
          const result: any = {};
          for (const [key, value] of Object.entries(obj)) {
            result[key] = parseNestedJson(value);
          }
          return result;
        }
        return obj;
      };

      if (typeof responseData === 'string') {
        try {
          const parsed = JSON.parse(responseData);
          const fullyParsed = parseNestedJson(parsed);
          formattedResponse = JSON.stringify(fullyParsed, null, 2);
        } catch {
          // If parsing fails, try to handle escaped JSON strings
          try {
            const unescaped = responseData.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            const parsed = JSON.parse(unescaped);
            const fullyParsed = parseNestedJson(parsed);
            formattedResponse = JSON.stringify(fullyParsed, null, 2);
          } catch {
            // If all parsing fails, use the string as-is
            formattedResponse = responseData;
          }
        }
      } else {
        // If it's already an object, recursively parse and stringify it prettily
        const fullyParsed = parseNestedJson(responseData);
        formattedResponse = JSON.stringify(fullyParsed, null, 2);
      }

      setCrossValidationResponse(formattedResponse);
      setCrossValidationStatus(response.status_code);
      setCrossValidationLatency(response.latency_ms);

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

    setIsLoading(true);
    setSingleTestStatus(null);
    setSingleTestLatency(null);
    setSingleTestProvider(null);
    setSingleTestHeaders(null);
    setSingleHeadersExpanded(false);
    try {
      const baseNetwork = getNetworkFromChainId(selectedChain);
      if (!baseNetwork) throw new Error('Network not found for chain');
      const chain = chains.find(c => c.value === baseNetwork);
      if (!chain) throw new Error('Chain not found');

      const chainType = chainTypes.find(t => t.value === chain.type);
      if (!chainType) throw new Error('Chain type not found');

      // For jsonrpc/wss, use jsonrpc interface commands
      const actualInterface = selectedInterface === 'jsonrpc/wss' ? 'jsonrpc' : selectedInterface;
      const interfaceCommands = chainType.interfaces[actualInterface];
      if (!interfaceCommands) throw new Error('Interface not found');

      const interfaceCommand = interfaceCommands[selectedRequestType];
      if (!interfaceCommand) throw new Error('Request type command not found');

      // Make direct request to provider endpoint
      const domain = process.env.NEXT_PUBLIC_DOMAIN || 'lava.lavapro.xyz';
      const port = process.env.NEXT_PUBLIC_PORT || '8443';

      const response = await makeTestRequest({
        chainId: selectedChain,
        interface: actualInterface,
        interfaceCommand,
        domain,
        port,
        skipCache,
        requestType: selectedRequestType,
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

      const responseData = response.response_data;
      setResponse(
        typeof responseData === 'string' ? responseData : JSON.stringify(responseData, null, 2),
      );
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
            onValueChange={value => setActiveTab(value as 'single' | 'load' | 'cross')}
            className='w-full'
          >
            <TabsList className='grid w-full grid-cols-3'>
              <TabsTrigger value='single' className='flex items-center gap-2'>
                <Play className='h-4 w-4' />
                Single Test
              </TabsTrigger>
              <TabsTrigger value='load' className='flex items-center gap-2'>
                <BarChart3 className='h-4 w-4' />
                Load Test
              </TabsTrigger>
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
                            Number of Requests (1-200)
                          </Label>
                          <Input
                            id='numberOfRequests'
                            type='number'
                            min={1}
                            max={200}
                            value={numberOfRequests}
                            onChange={e =>
                              setNumberOfRequests(
                                Math.max(1, Math.min(200, parseInt(e.target.value) || 1)),
                              )
                            }
                            className='w-32'
                            disabled={isLoadTesting}
                          />
                        </div>
                        <p className='text-sm text-muted-foreground'>
                          Load tests will run {numberOfRequests} parallel requests and report
                          success rate and latency statistics.
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
                                        setCrossValidationResponse('');
                                      }}
                                    >
                                      JSON-RPC/WSS
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
                            disabled={isCrossValidating}
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
                            max='10'
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
                            disabled={isCrossValidating}
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
                            disabled={isCrossValidating}
                          />
                        </div>
                        <p className='text-sm text-muted-foreground'>
                          Cross validation will test with minimum: {crossValidationMin}, maximum:{' '}
                          {crossValidationMax}, rate: {crossValidationRate.toFixed(2)}
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                )}

                <div className='flex justify-end space-x-4'>
                  <Button
                    onClick={handleCrossValidation}
                    disabled={isCrossValidating || !selectedChain || !selectedInterface}
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
