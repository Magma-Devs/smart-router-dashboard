'use client';

import { useState, useEffect } from 'react';
import { useConfig } from '@/hooks/use-config';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/use-toast';
import { Toaster } from '@/components/ui/toaster';
import { Copy, Loader2 } from 'lucide-react';
import { chains } from '@/app/config/chains';
import { cn } from '@/lib/utils';
import { chainTypes } from '@/app/config/chain-types';
import { ProtectedRoute } from '@/components/protected-route';
import { apiClient } from '@/lib/api-client';
import { getChainIcon, getChainLabel } from '@/app/config/chains';
import { MetricsService } from '@/services/metricsService';

interface ApiResponse {
  consumers: {
    [key: string]: {
      id: string;
      interfaces: string[];
      providers: Array<{
        name: string;
        endpoint: string;
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

export default function LiveTestPage() {
  const { config } = useConfig();
  // id + network of real chains with metrics
  const [availableChains, setAvailableChains] = useState<Array<{ id: string; network: string }>>([]);
  const [selectedNetwork, setSelectedNetwork] = useState<string>('');
  const [selectedChain, setSelectedChain] = useState<string>('');
  const [selectedInterface, setSelectedInterface] = useState<string>('');
  const [response, setResponse] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [curlCommand, setCurlCommand] = useState<string>('');
  const [endpointUrl, setEndpointUrl] = useState<string>('');
  const [configuredInterfaces, setConfiguredInterfaces] = useState<string[]>([]);
  const [apiData, setApiData] = useState<ApiResponse | null>(null);

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
        const chainsData = Object.entries(chainsResponse.chains).map(([chainId, chainMetrics]: [string, any]) => ({
          id: chainId,
          network: chainMetrics.network,
        }));
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
    } else {
      setConfiguredInterfaces([]);
    }
  }, [selectedChain, apiData]);

  useEffect(() => {
    if (selectedChain && selectedInterface) {
      const apiEndpoint = config.apiEndpoint;
      const baseNetwork = selectedChain.split('-')[0];
      const chain = chains.find(c => c.value === baseNetwork);
      if (!chain) return;

      const chainType = chainTypes.find(t => t.value === chain.type);
      if (!chainType) return;

      const interfaceCommand = chainType.interfaces[selectedInterface];
      if (!interfaceCommand) return;

      const domain = process.env.NEXT_PUBLIC_DOMAIN || 'lavapro.xyz';
      const port = process.env.NEXT_PUBLIC_PORT || '8443';

      const curlHost = `${selectedChain}-${selectedInterface}.${domain}`;
      const endpoint = `https://${curlHost}:${port}`;
      setEndpointUrl(endpoint);
      
      const cmd =
        selectedInterface === 'rest'
          ? `curl -X GET https://${curlHost}:${port}${JSON.parse(interfaceCommand).path}`
          : `curl -X POST -H "Content-Type: application/json" https://${curlHost}:${port} -d '${interfaceCommand}'`;
      setCurlCommand(cmd);
    }
  }, [selectedChain, selectedInterface, config.apiEndpoint]);

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
    try {
      const baseNetwork = selectedChain.split('-')[0];
      const chain = chains.find(c => c.value === baseNetwork);
      if (!chain) throw new Error('Chain not found');

      const chainType = chainTypes.find(t => t.value === chain.type);
      if (!chainType) throw new Error('Chain type not found');

      const interfaceCommand = chainType.interfaces[selectedInterface];
      if (!interfaceCommand) throw new Error('Interface command not found');

      const domain = process.env.NEXT_PUBLIC_DOMAIN || 'lavapro.xyz';
      const port = process.env.NEXT_PUBLIC_PORT || '8443';
      const curlHost = `${selectedChain}-${selectedInterface}.${domain}`;
      const response = await fetch(
        `https://${curlHost}:${port}${selectedInterface === 'rest' ? JSON.parse(interfaceCommand).path : ''}`,
        {
          method: selectedInterface === 'rest' ? 'GET' : 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: selectedInterface === 'rest' ? undefined : interfaceCommand,
        },
      );

      const data = await response.json();
      setResponse(JSON.stringify(data, null, 2));
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

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      toast({
        title: 'Copied to clipboard',
        description: 'The command has been copied to your clipboard',
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
            <p className='text-muted-foreground'>Test your chain configuration with live requests</p>
          </div>

          {error && (
            <div className='rounded-lg bg-destructive/10 p-4 text-destructive'>{error}</div>
          )}

          <div className='grid gap-6'>
            <Card className='border-2 border-primary/20 bg-gradient-to-br from-card/50 to-card shadow-lg hover:shadow-xl transition-all duration-200'>
              <CardHeader className='border-b border-border/20 bg-gradient-to-r from-primary/10 to-background pb-4'>
                <CardTitle className='text-xl font-bold bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent'>
                  Configuration
                </CardTitle>
                <CardDescription>Select a network, router and interface to test</CardDescription>
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
                                selected ? 'border-primary bg-primary/10 shadow-lg' : 'border-border/50 bg-card',
                              )}
                            >
                              <div className='flex-shrink-0 w-8 h-8 rounded-full bg-background/50 p-1.5'>
                                {icon && <img src={icon} alt={label} className='w-full h-full object-contain' />}
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
                                  selected ? 'border-primary bg-primary/10 shadow-lg' : 'border-border/50 bg-card',
                                )}
                              >
                                <div className='flex-shrink-0 w-8 h-8 rounded-full bg-background/50 p-1.5'>
                                  {icon && <img src={icon} alt={label} className='w-full h-full object-contain' />}
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
                                  setResponse('');
                                }}
                              >
                                {displayName}
                              </Button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </CardContent>
            </Card>

            {selectedChain && selectedInterface && (
              <Card className='border-muted bg-card/50'>
                <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                  <CardTitle className='text-lg font-medium'>Endpoint</CardTitle>
                  <Button variant='ghost' size='icon' onClick={() => copyToClipboard(endpointUrl)}>
                    <Copy className='h-4 w-4' />
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
                  <Button variant='ghost' size='icon' onClick={() => copyToClipboard(curlCommand)}>
                    <Copy className='h-4 w-4' />
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
                  'Run Test'
                )}
              </Button>
            </div>

            {response && (
              <Card className='border-muted bg-card/50'>
                <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-2'>
                  <CardTitle className='text-lg font-medium'>Response</CardTitle>
                  <Button variant='ghost' size='icon' onClick={() => copyToClipboard(response)}>
                    <Copy className='h-4 w-4' />
                  </Button>
                </CardHeader>
                <CardContent>
                  <pre className='rounded-lg bg-muted p-4 font-mono text-sm overflow-x-auto whitespace-pre-wrap break-all'>
                    {response}
                  </pre>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
        <Toaster />
      </div>
    </ProtectedRoute>
  );
}
