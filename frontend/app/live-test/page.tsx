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

interface Interface {
  name: string;
  port?: number;
  addons?: string[];
}

interface ApiResponse {
  consumers: {
    [key: string]: {
      interfaces: Array<{
        name: string;
        port: number;
        addons: string[];
      }>;
    };
  };
  providers: {
    [key: string]: Array<{
      name: string;
      interfaces: Interface[];
    }>;
  };
}

const interfaces = [
  { value: 'jsonrpc', label: 'JSON-RPC', color: 'bg-blue-500' },
  { value: 'tendermintrpc', label: 'TendermintRPC', color: 'bg-green-500' },
  { value: 'rest', label: 'REST', color: 'bg-purple-500' },
  { value: 'grpc', label: 'gRPC', color: 'bg-red-500' },
];

export default function LiveTestPage() {
  const { config } = useConfig();
  const [availableChains, setAvailableChains] = useState<typeof chains>([]);
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
        const data: ApiResponse = await apiClient.get(`/api/components/`);
        
        // Store the API data for later use
        setApiData(data);

        // Get configured chains and their interfaces
        const configuredChains = Object.keys(data.consumers);
        const availableChainConfigs = chains.filter(chain =>
          configuredChains.includes(chain.value),
        );
        setAvailableChains(availableChainConfigs);
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
    if (selectedChain && apiData && apiData.consumers[selectedChain]) {
      // Deduplicate interfaces by name
      const interfaceNames = apiData.consumers[selectedChain].interfaces.map(i => i.name);
      const uniqueInterfaces = [...new Set(interfaceNames)];
      setConfiguredInterfaces(uniqueInterfaces);
    }
  }, [selectedChain, apiData]);

  useEffect(() => {
    if (selectedChain && selectedInterface) {
      // Use the configured API endpoint
      const apiEndpoint = config.apiEndpoint;

      // Get the chain type and its interface command
      const chain = chains.find(c => c.value === selectedChain);
      if (!chain) return;

      const chainType = chainTypes.find(t => t.value === chain.type);
      if (!chainType) return;

      const interfaceCommand = chainType.interfaces[selectedInterface];
      if (!interfaceCommand) return;

      const domain = process.env.NEXT_PUBLIC_DOMAIN || 'lavapro.xyz';
      const port = process.env.NEXT_PUBLIC_PORT || '8443';
      const hostHeader = `${ }-${selectedInterface}.${domain}`;
      
      // Generate endpoint URL
      const endpoint = `https://${domain}:${port}`;
      setEndpointUrl(endpoint);
      
      const cmd =
        selectedInterface === 'rest'
          ? `curl -X GET -H "X-Host: ${hostHeader}" https://${domain}:${port}${JSON.parse(interfaceCommand).path}`
          : `curl -X POST -H "X-Host: ${hostHeader}" -H "Content-Type: application/json" https://${domain}:${port} -d '${interfaceCommand}'`;
      setCurlCommand(cmd);
    }
  }, [selectedChain, selectedInterface, config.apiEndpoint]);

  const handleTest = async () => {
    if (!selectedChain || !selectedInterface) {
      toast({
        variant: 'destructive',
        title: 'Error',
        description: 'Please select both chain and interface',
      });
      return;
    }

    setIsLoading(true);
    try {
      // Get the chain type and its interface command
      const chain = chains.find(c => c.value === selectedChain);
      if (!chain) throw new Error('Chain not found');

      const chainType = chainTypes.find(t => t.value === chain.type);
      if (!chainType) throw new Error('Chain type not found');

      const interfaceCommand = chainType.interfaces[selectedInterface];
      if (!interfaceCommand) throw new Error('Interface command not found');

      const domain = process.env.NEXT_PUBLIC_DOMAIN || 'lavapro.xyz';
      const port = process.env.NEXT_PUBLIC_PORT || '8443';
      const hostHeader = `${selectedChain}-${selectedInterface}.${domain}`;
      const response = await fetch(
        `https://${domain}:${port}${selectedInterface === 'rest' ? JSON.parse(interfaceCommand).path : ''}`,
        {
          method: selectedInterface === 'rest' ? 'GET' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Host': hostHeader,
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

          <div className='grid gap-6'>
            <Card className='border-2 border-primary/20 bg-gradient-to-br from-card/50 to-card shadow-lg hover:shadow-xl transition-all duration-200'>
              <CardHeader className='border-b border-border/20 bg-gradient-to-r from-primary/10 to-background pb-4'>
                <CardTitle className='text-xl font-bold bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent'>
                  Configuration
                </CardTitle>
                <CardDescription>Select a chain and interface to test</CardDescription>
              </CardHeader>
              <CardContent className='space-y-6 pt-6'>
                {isFetching ? (
                  <div className='flex items-center justify-center py-8'>
                    <Loader2 className='h-6 w-6 animate-spin text-primary' />
                  </div>
                ) : (
                  <>
                    <div className='space-y-4'>
                      <Label className='text-sm font-medium'>Chain</Label>
                      <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4'>
                        {availableChains.map(chain => (
                          <button
                            key={chain.value}
                            onClick={() => {
                              setSelectedChain(chain.value === selectedChain ? '' : chain.value);
                              setSelectedInterface('');
                              setResponse('');
                            }}
                            className={cn(
                              'flex items-center gap-3 p-4 rounded-lg border-2 transition-all duration-200',
                              'hover:border-primary/50 hover:bg-primary/5',
                              selectedChain === chain.value
                                ? 'border-primary bg-primary/10 shadow-lg'
                                : 'border-border/50 bg-card',
                            )}
                          >
                            <div className='flex-shrink-0 w-8 h-8 rounded-full bg-background/50 p-1.5'>
                              <img
                                src={chain.icon}
                                alt={chain.label}
                                className='w-full h-full object-contain'
                              />
                            </div>
                            <span className='font-medium'>{chain.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {selectedChain && (
                      <div className='space-y-4'>
                        <Label className='text-sm font-medium'>Interface</Label>
                        <div className='flex flex-wrap gap-2'>
                          {configuredInterfaces.map(iface => {
                            const interfaceConfig = interfaces.find(i => i.value === iface);
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
