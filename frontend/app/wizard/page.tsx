'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  Trash2,
  CheckCircle2,
  Circle,
  AlertCircle,
  Check,
  Loader2,
  Settings,
  PlusCircle,
  ArrowRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { motion, AnimatePresence, useAnimation } from 'framer-motion';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useToast } from '@/components/ui/use-toast';
import { Progress } from '@/components/ui/progress';
import { useConfig } from '@/hooks/use-config';
import { Checkbox } from '@/components/ui/checkbox';
import { useDebounce } from '@/hooks/use-debounce';
import { chains } from '@/app/config/chains';
import { ProtectedRoute } from '@/components/protected-route';

interface ChainInterface {
  name: string[];
  port: number;
  addons: string[];
  providers: {
    name: string;
    url: string;
    addons: string[];
    nodes: {
      endpoint: string;
      type: string;
    }[];
  }[];
}

interface ChainConfig {
  name: string;
  interfaces: ChainInterface[];
}

interface ProviderInterface {
  name: string;
  nodes: {
    endpoint: string;
    type: string;
  }[];
}

interface Provider {
  name: string;
  interfaces: ProviderInterface[];
  chainIndex: number;
}

type Step = 1 | 2 | 3;
const steps = [
  { id: 1, title: 'Add Chains', description: 'Configure your chains' },
  { id: 2, title: 'Add Providers', description: 'Configure providers for each chain' },
  { id: 3, title: 'Review', description: 'Review your configuration' },
];

const interfaces = [
  { value: 'jsonrpc', label: 'JSON-RPC', color: 'bg-blue-500' },
  { value: 'tendermintrpc', label: 'TendermintRPC', color: 'bg-green-500' },
  { value: 'rest', label: 'REST', color: 'bg-purple-500' },
  { value: 'grpc', label: 'gRPC', color: 'bg-red-500' },
];

interface ProviderCardProps {
  providerName: string;
  interfaces: ChainInterface[];
  chainIndex: number;
}

const ProviderCard = ({ providerName, interfaces, chainIndex }: ProviderCardProps) => {
  return (
    <div className='space-y-2'>
      <div className='flex items-center gap-2'>
        <h5 className='font-medium'>Provider: {providerName}</h5>
        <span className='text-sm text-muted-foreground'></span>
      </div>
      <div className='flex flex-wrap gap-2'>
        {interfaces.map((iface, idx) => {
          const provider = iface.providers.find(p => p.name === providerName);
          return (
            <div key={idx} className='flex flex-col gap-1 p-3 bg-muted/50 rounded-lg'>
              <div className='flex flex-wrap gap-1'>
                {iface.name.map((name, nameIdx) => (
                  <span
                    key={nameIdx}
                    className={cn(
                      'text-xs px-2 py-0.5 rounded',
                      name.includes('jsonrpc') && 'bg-blue-500/10 text-blue-700',
                      name.includes('tendermintrpc') && 'bg-green-500/10 text-green-700',
                      name.includes('rest') && 'bg-purple-500/10 text-purple-700',
                      name.includes('grpc') && 'bg-orange-500/10 text-orange-700',
                    )}
                  >
                    {name}
                  </span>
                ))}
              </div>
              {provider?.nodes?.[0]?.endpoint && (
                <div className='text-sm text-muted-foreground'>
                  Endpoint: {provider.nodes[0].endpoint}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const useProviderNameUpdate = (
  chainConfigs: ChainConfig[],
  setChainConfigs: React.Dispatch<React.SetStateAction<ChainConfig[]>>,
) => {
  const [localProviderName, setLocalProviderName] = useState<string>('');
  const [currentProviderKey, setCurrentProviderKey] = useState<string>('');
  const debouncedName = useDebounce(localProviderName, 1000);
  const { toast } = useToast();

  useEffect(() => {
    if (debouncedName && currentProviderKey) {
      const [chainIndex, providerName] = currentProviderKey.split(':');
      updateProviderName(parseInt(chainIndex), providerName, debouncedName);
    }
  }, [debouncedName, currentProviderKey]);

  const updateProviderName = useCallback(
    (chainIndex: number, oldName: string, newName: string) => {
      // Validate provider name
      const providerNameRegex = /^[a-zA-Z0-9_-]{3,}$/;
      if (!providerNameRegex.test(newName)) {
        toast({
          title: 'Invalid provider name',
          description:
            'Provider name must be at least 3 characters long and contain only letters, numbers, hyphens, and underscores.',
          variant: 'destructive',
        });
        return;
      }

      setChainConfigs((prevChains: ChainConfig[]) => {
        const newChains = [...prevChains];
        const chain = newChains[chainIndex];

        // Create a new interfaces array with only the updated provider
        const updatedInterfaces = chain.interfaces.map((iface: ChainInterface) => {
          if (iface.providers[0]?.name === oldName) {
            return {
              ...iface,
              providers: [
                {
                  ...iface.providers[0],
                  name: newName,
                  url: `${newName}-provider.lava-infra.svc.cluster.local:2200`,
                },
              ],
            };
          }
          return iface;
        });

        // Only update the specific chain
        newChains[chainIndex] = {
          ...chain,
          interfaces: updatedInterfaces,
        };

        return newChains;
      });
    },
    [setChainConfigs, toast],
  );

  const handleProviderNameChange = useCallback(
    (chainIndex: number, providerName: string, newName: string) => {
      setLocalProviderName(newName);
      setCurrentProviderKey(`${chainIndex}:${providerName}`);
    },
    [],
  );

  return {
    localProviderName,
    setLocalProviderName,
    handleProviderNameChange,
  };
};

const getInterfaceName = (name: string | string[]): string => {
  return Array.isArray(name) ? name.join(', ') : name;
};

const hasInterfaceType = (name: string | string[], type: string): boolean => {
  return Array.isArray(name) ? name.includes(type) : name === type;
};

const ensureArray = (value: any): string[] => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [value];
  return [];
};

const getAvailableInterfaces = (chainValue: string) => {
  const chain = chains.find(c => c.value === chainValue);
  if (!chain) return [];
  return interfaces.filter(iface => chain.supportedInterfaces.includes(iface.value));
};

export default function WizardPage() {
  const [selectedOption, setSelectedOption] = useState<'edit' | 'new' | null>(null);
  const [hoveredCard, setHoveredCard] = useState<'edit' | 'new' | null>(null);
  const [step, setStep] = useState<Step>(1);
  const [chainConfigs, setChainConfigs] = useState<ChainConfig[]>([]);
  const [currentChainIndex, setCurrentChainIndex] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isComplete, setIsComplete] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const controls = useAnimation();
  const { toast } = useToast();
  const formRef = useRef<HTMLDivElement>(null);
  const { config } = useConfig();
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({});
  const { localProviderName, setLocalProviderName, handleProviderNameChange } =
    useProviderNameUpdate(chainConfigs, setChainConfigs);
  const [showConfig, setShowConfig] = useState(false);
  const [finalConfig, setFinalConfig] = useState<string>('');

  // Load current configuration when edit is selected
  useEffect(() => {
    if (selectedOption === 'edit') {
      setIsLoading(true);
      setApiError(null);

      const fetchData = async () => {
        try {
          if (!config.apiEndpoint) {
            setApiError(
              'No API endpoint configured. Please set up an API endpoint in the configuration page.',
            );
            setIsLoading(false);
            return;
          }

          const response = await fetch(`${config.apiEndpoint}/api/components/`);
          if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
          }
          const data = await response.json();

          // Transform the API data into our internal format
          const transformedChains = Object.entries(data.consumers).map(
            ([chainId, chain]: [string, any]) => {
              // Group interfaces by name only
              const interfaceMap = new Map<string, any>();

              // Extract interfaces from the new structure
              const interfaces = chain.interfaces || [];
              const providers = chain.providers || [];

              interfaces.forEach((interfaceName: string) => {
                if (!interfaceMap.has(interfaceName)) {
                  // Initialize the interface
                  interfaceMap.set(interfaceName, {
                    name: [interfaceName],
                    port: 443, // Default port
                    addons: [],
                    providers: [],
                  });
                }

                // Add providers that support this interface
                providers.forEach((provider: any) => {
                  const providerEndpoints = provider.endpoints || [];
                  const relevantEndpoints = providerEndpoints.filter(
                    (endpoint: any) => endpoint.interface === interfaceName,
                  );

                  if (relevantEndpoints.length > 0) {
                    const existingInterface = interfaceMap.get(interfaceName);
                    // Check if this provider already exists
                    const existingProviderIndex = existingInterface.providers.findIndex(
                      (p: any) => p.name === provider.name,
                    );

                    if (existingProviderIndex === -1) {
                      // Add new provider
                      existingInterface.providers.push({
                        name: provider.name,
                        url: relevantEndpoints[0].url, // Use first endpoint URL
                        addons: relevantEndpoints.flatMap((ep: any) => ep.addons || []),
                        nodes: relevantEndpoints.map((endpoint: any) => ({
                          endpoint: endpoint.url,
                          type: endpoint.interface,
                        })),
                      });
                    }
                  }
                });
              });

              return {
                name: chainId,
                interfaces: Array.from(interfaceMap.values()),
              };
            },
          );

          console.log('Transformed chains:', transformedChains);
          setChainConfigs(transformedChains);
          setStep(1);
          setCurrentChainIndex(0);
          setErrors({});
          setIsComplete(false);
          setProgress(0);
        } catch (error) {
          console.error('Error loading configuration:', error);
          setApiError('Failed to connect to the API. Please check your connection and try again.');
          toast({
            title: 'Error',
            description: 'Failed to load current configuration',
            variant: 'destructive',
          });
        } finally {
          setIsLoading(false);
        }
      };

      fetchData();
    }
  }, [selectedOption, toast, config.apiEndpoint]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        nextStep();
      } else if (e.key === 'Backspace' && e.ctrlKey) {
        e.preventDefault();
        prevStep();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [step, chains, currentChainIndex]);

  // Progress animation
  useEffect(() => {
    const targetProgress = (step / steps.length) * 100;
    const interval = setInterval(() => {
      setProgress(prev => {
        const diff = targetProgress - prev;
        if (Math.abs(diff) < 1) return targetProgress;
        return prev + diff * 0.1;
      });
    }, 16);
    return () => clearInterval(interval);
  }, [step]);

  const validateStep = () => {
    const newErrors: Record<string, string> = {};

    if (step === 1) {
      chainConfigs.forEach((chain, index) => {
        if (!chain.name) {
          newErrors[`chain-name-${index}`] = 'Chain is required';
        }
      });
    } else if (step === 2) {
      const currentChain = chainConfigs[currentChainIndex];
      if (!currentChain || !currentChain.interfaces || currentChain.interfaces.length === 0) {
        newErrors[`chain-interfaces-${currentChainIndex}`] = 'No interfaces configured';
      } else {
        currentChain.interfaces.forEach((iface, ifaceIndex) => {
          if (!iface.name || iface.name.length === 0) {
            newErrors[`interface-types-${currentChainIndex}-${ifaceIndex}`] =
              'At least one interface type must be selected';
          }
          iface.providers.forEach((provider, providerIndex) => {
            if (!provider.name) {
              newErrors[`provider-name-${currentChainIndex}-${ifaceIndex}-${providerIndex}`] =
                'Provider name is required';
            }
            if (!provider.nodes?.[0]?.endpoint) {
              newErrors[`node-endpoint-${currentChainIndex}-${ifaceIndex}-${providerIndex}`] =
                'Node endpoint is required';
            } else if (
              !provider.nodes[0].endpoint.startsWith('http://') &&
              !provider.nodes[0].endpoint.startsWith('https://')
            ) {
              newErrors[`node-endpoint-${currentChainIndex}-${ifaceIndex}-${providerIndex}`] =
                'Node endpoint must be a valid URL starting with http:// or https://';
            }
          });
        });
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const addChain = () => {
    setChainConfigs([...chainConfigs, { name: '', interfaces: [] }]);
    controls.start({ scale: [1, 1.05, 1], transition: { duration: 0.3 } });
  };

  const removeChain = (index: number) => {
    const newChains = [...chainConfigs];
    newChains.splice(index, 1);
    setChainConfigs(newChains);
    setErrors({});
    toast({
      title: 'Chain removed',
      description: 'The chain has been removed from the configuration.',
    });
  };

  const updateChain = (index: number, field: keyof ChainConfig, value: any) => {
    const newChains = [...chainConfigs];
    newChains[index] = { ...newChains[index], [field]: value };
    // If updating interfaces, ensure each interface has its own provider
    if (field === 'interfaces') {
      const currentInterfaces = newChains[index].interfaces;
      const newInterfaces: ChainInterface[] = [];

      // Create a provider for each interface
      value.forEach((iface: ChainInterface) => {
        // Try to find an existing provider for this interface
        const existingInterface = currentInterfaces.find(p =>
          p.name.some(n => iface.name.some(m => m === n)),
        );
        if (existingInterface) {
          // If found, update it to only handle this interface
          newInterfaces.push({
            ...existingInterface,
            providers: existingInterface.providers.map(p => ({
              ...p,
              addons: iface.addons,
            })),
          });
        } else {
          // If not found, create a new provider
          newInterfaces.push({
            ...iface,
            providers: iface.providers.map(p => ({
              ...p,
              addons: iface.addons,
            })),
          });
        }
      });

      newChains[index].interfaces = newInterfaces;
    }
    setChainConfigs(newChains);
    setErrors({});
  };

  const addProvider = (chainIndex: number) => {
    const newChains = [...chainConfigs];

    // Find the highest port number used across all chains
    const highestPort = newChains.reduce((maxPort, chain) => {
      const chainMaxPort = chain.interfaces.reduce((port, iface) => Math.max(port, iface.port), 0);
      return Math.max(maxPort, chainMaxPort);
    }, 1999); // Start from 1999 so first port will be 2000

    // Get the chain name and count existing providers for this chain
    const chainName = newChains[chainIndex].name;
    const providerCount = newChains[chainIndex].interfaces.filter(iface =>
      iface.providers[0]?.name?.startsWith(`${chainName}-`),
    ).length;

    // Generate default provider name
    const defaultProviderName = `${chainName}-${providerCount}`;

    // Create a new interface with a new provider
    newChains[chainIndex].interfaces.push({
      name: [], // Don't set a default interface type
      port: highestPort + 1, // Use the next available port
      addons: ['archive', 'debug'], // Always include both addons
      providers: [
        {
          name: defaultProviderName, // Use the generated default name
          url: `${defaultProviderName}-provider.lava-infra.svc.cluster.local:2200`,
          addons: ['archive', 'debug'], // Always include both addons
          nodes: [
            {
              endpoint: '',
              type: 'full',
            },
          ],
        },
      ],
    });

    // Collapse all existing providers
    const newExpandedProviders = { ...expandedProviders };
    Object.keys(newExpandedProviders).forEach(key => {
      newExpandedProviders[key] = false;
    });
    // Expand only the new provider
    newExpandedProviders[defaultProviderName] = true;
    setExpandedProviders(newExpandedProviders);

    // Reset the local provider name state
    setLocalProviderName('');

    setChainConfigs(newChains);
    setErrors({} as Record<string, string>);
    controls.start({ scale: [1, 1.05, 1], transition: { duration: 0.3 } });
  };

  const addInterfaceToProvider = (
    chainIndex: number,
    interfaceIndex: number,
    providerName: string,
  ) => {
    const newChains = [...chainConfigs];
    const currentInterface = newChains[chainIndex].interfaces[interfaceIndex];

    // Get the chain's supported interfaces
    const chainInfo = chains.find(c => c.value === newChains[chainIndex].name);
    const supportedInterfaces = chainInfo?.supportedInterfaces || [];

    // Get all used interface types for this provider
    const usedInterfaceTypes = newChains[chainIndex].interfaces
      .filter(iface => iface.providers[0]?.name === providerName)
      .map(iface => iface.name[0]);

    // Find the first available supported interface that hasn't been used
    const availableInterface = interfaces.find(
      iface =>
        supportedInterfaces.includes(iface.value) && !usedInterfaceTypes.includes(iface.value),
    );

    if (!availableInterface) {
      toast({
        title: 'No available interfaces',
        description: 'All supported interface types are already configured for this provider.',
        variant: 'destructive',
      });
      return;
    }

    // Create a new interface with the same provider
    const newInterface = {
      name: [availableInterface.value],
      port: currentInterface.port + 1,
      addons: ['archive', 'debug'], // Always include both addons
      providers: [
        {
          name: providerName,
          url: currentInterface.providers[0].url,
          addons: ['archive', 'debug'], // Always include both addons
          nodes: [
            {
              endpoint: '',
              type: 'full',
            },
          ],
        },
      ],
    };

    // Insert the new interface right after the current one
    newChains[chainIndex].interfaces.splice(interfaceIndex + 1, 0, newInterface);

    setChainConfigs(newChains);
    setErrors({} as Record<string, string>);
  };

  const removeProvider = (chainIndex: number, providerIndex: number) => {
    const newChains = [...chainConfigs];
    newChains[chainIndex].interfaces.splice(providerIndex, 1);
    setChainConfigs(newChains);
    setErrors({});
    toast({
      title: 'Provider removed',
      description: 'The provider has been removed from the configuration.',
    });
  };

  const updateProvider = (
    chainIndex: number,
    interfaceIndex: number,
    providerIndex: number,
    updates: Partial<{ name: string; url: string }>,
  ) => {
    const newChains = [...chainConfigs];
    const currentProvider =
      newChains[chainIndex].interfaces[interfaceIndex].providers[providerIndex];

    if (updates.name) {
      // Update URL based on the new name
      updates.url = `${updates.name}.lava-infra.svc.cluster.local:2200`;
    }

    newChains[chainIndex].interfaces[interfaceIndex].providers[providerIndex] = {
      ...currentProvider,
      ...updates,
    };
    setChainConfigs(newChains);
    setErrors({} as Record<string, string>);
  };

  const generateFinalConfig = useCallback(() => {
    const config: any = {
      chains: {},
    };

    // Process chains
    chainConfigs.forEach(chain => {
      // Create a map to store interfaces by name
      const interfaceMap = new Map();

      // First pass: collect all interfaces and their providers
      chain.interfaces.forEach(iface => {
        const interfaceName = iface.name[0];
        if (!interfaceMap.has(interfaceName)) {
          interfaceMap.set(interfaceName, {
            name: interfaceName,
            port: iface.port,
            providers: [],
          });
        }

        // Add providers to the existing interface
        const existingInterface = interfaceMap.get(interfaceName);
        existingInterface.providers.push(
          ...iface.providers.map(provider => ({
            name: provider.name,
            url: provider.url,
            nodes: provider.nodes.map(node => ({
              endpoint: node.endpoint,
              type: 'full', // Always set type to "full"
            })),
          })),
        );
      });

      // Add the chain with combined interfaces
      config.chains[chain.name] = {
        addons: ['archive', 'debug'], // Move addons to chain level
        interfaces: Array.from(interfaceMap.values()),
      };
    });

    return JSON.stringify(config, null, 2);
  }, [chainConfigs]);

  // Update the useEffect to set the final config when chains change
  useEffect(() => {
    if (step === 3) {
      setFinalConfig(generateFinalConfig());
    }
  }, [step, chainConfigs, generateFinalConfig]);

  const handleComplete = useCallback(async () => {
    setIsSubmitting(true);
    try {
      if (!config.apiEndpoint) {
        setApiError(
          'No API endpoint configured. Please set up an API endpoint in the configuration page.',
        );
        return;
      }

      const finalConfig = generateFinalConfig();
      setFinalConfig(finalConfig);
      setShowConfig(true);

      // Show confirmation dialog
      const confirmed = window.confirm(
        'Please review the configuration below. Click OK to apply the changes or Cancel to go back.',
      );

      if (!confirmed) {
        setIsSubmitting(false);
        return;
      }

      // Make POST request to backend using the same endpoint configuration
      const response = await fetch(`${config.apiEndpoint}/api/components/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: finalConfig,
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }

      setIsComplete(true);
      toast({
        title: 'Success',
        description: 'Configuration has been saved successfully',
      });
    } catch (error) {
      console.error('Error saving configuration:', error);
      setApiError('Failed to connect to the API. Please check your connection and try again.');
      toast({
        title: 'Error',
        description: 'Failed to save configuration. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  }, [generateFinalConfig, toast, config.apiEndpoint]);

  const nextStep = async () => {
    if (!validateStep()) {
      controls.start({ x: [0, -10, 10, -10, 0], transition: { duration: 0.3 } });
      return;
    }

    if (step === 1 && chainConfigs.length > 0) {
      setStep(2);
    } else if (step === 2 && currentChainIndex < chainConfigs.length - 1) {
      setCurrentChainIndex(currentChainIndex + 1);
    } else if (step === 2 && currentChainIndex === chainConfigs.length - 1) {
      setStep(3);
    } else if (step === 3) {
      await handleComplete();
    }
  };

  const prevStep = () => {
    if (step === 2 && currentChainIndex > 0) {
      setCurrentChainIndex(currentChainIndex - 1);
    } else if (step === 2 && currentChainIndex === 0) {
      setStep(1);
    } else if (step === 3) {
      setStep(2);
    }
  };

  const resetWizard = () => {
    setStep(1);
    setChainConfigs([]);
    setCurrentChainIndex(0);
    setErrors({});
    setIsComplete(false);
    setProgress(0);
    toast({
      title: 'Wizard reset',
      description: 'The wizard has been reset to its initial state.',
    });
  };

  return (
    <ProtectedRoute>
      <div className='container mx-auto px-4 py-12 max-w-7xl'>
        {!selectedOption ? (
          <>
            <motion.div
              className='text-center mb-16'
              initial={{ opacity: 0, y: -20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5 }}
            >
              <h1 className='text-4xl font-bold mb-4'>Configuration Wizard</h1>
              <p className='text-xl text-muted-foreground max-w-2xl mx-auto'>
                Choose how you want to configure your infrastructure setup
              </p>
            </motion.div>

            <div className='grid grid-cols-1 md:grid-cols-2 gap-8 max-w-5xl mx-auto'>
              <motion.div
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onHoverStart={() => setHoveredCard('edit')}
                onHoverEnd={() => setHoveredCard(null)}
              >
                <Card
                  className={cn(
                    'h-full cursor-pointer transition-all duration-300',
                    hoveredCard === 'edit' ? 'border-primary shadow-lg' : 'hover:border-primary/50',
                  )}
                  onClick={() => setSelectedOption('edit')}
                >
                  <CardHeader className='pb-6'>
                    <div className='flex items-center gap-6'>
                      <motion.div
                        className='p-4 bg-primary/10 rounded-full'
                        animate={{
                          scale: hoveredCard === 'edit' ? 1.1 : 1,
                          rotate: hoveredCard === 'edit' ? 5 : 0,
                        }}
                        transition={{ duration: 0.3 }}
                      >
                        <Settings className='h-10 w-10 text-primary' />
                      </motion.div>
                      <div>
                        <CardTitle className='text-2xl mb-2'>Edit Current Configuration</CardTitle>
                        <CardDescription className='text-base'>
                          Modify your existing infrastructure setup
                        </CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className='text-muted-foreground text-lg mb-6'>
                      Update your current chains, providers, and their relationships while
                      preserving existing configurations.
                    </p>
                    <motion.div
                      className='flex items-center text-primary font-medium'
                      animate={{
                        x: hoveredCard === 'edit' ? 5 : 0,
                        opacity: hoveredCard === 'edit' ? 1 : 0.8,
                      }}
                    >
                      <span>Continue to edit</span>
                      <ArrowRight className='ml-2 h-5 w-5' />
                    </motion.div>
                  </CardContent>
                </Card>
              </motion.div>

              <motion.div
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onHoverStart={() => setHoveredCard('new')}
                onHoverEnd={() => setHoveredCard(null)}
              >
                <Card
                  className={cn(
                    'h-full cursor-pointer transition-all duration-300',
                    hoveredCard === 'new' ? 'border-primary shadow-lg' : 'hover:border-primary/50',
                  )}
                  onClick={() => {
                    setSelectedOption('new');
                    setStep(1);
                    setChainConfigs([]);
                    setCurrentChainIndex(0);
                    setErrors({});
                    setIsComplete(false);
                    setProgress(0);
                    setShowConfig(false);
                    setFinalConfig('');
                    setApiError(null);
                    setIsLoading(false);
                    setExpandedProviders({});
                  }}
                >
                  <CardHeader className='pb-6'>
                    <div className='flex items-center gap-6'>
                      <motion.div
                        className='p-4 bg-primary/10 rounded-full'
                        animate={{
                          scale: hoveredCard === 'new' ? 1.1 : 1,
                          rotate: hoveredCard === 'new' ? 5 : 0,
                        }}
                        transition={{ duration: 0.3 }}
                      >
                        <PlusCircle className='h-10 w-10 text-primary' />
                      </motion.div>
                      <div>
                        <CardTitle className='text-2xl mb-2'>Start Fresh</CardTitle>
                        <CardDescription className='text-base'>
                          Create a new configuration from scratch
                        </CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className='text-muted-foreground text-lg mb-6'>
                      Begin with a clean slate and set up your infrastructure configuration step by
                      step.
                    </p>
                    <motion.div
                      className='flex items-center text-primary font-medium'
                      animate={{
                        x: hoveredCard === 'new' ? 5 : 0,
                        opacity: hoveredCard === 'new' ? 1 : 0.8,
                      }}
                    >
                      <span>Start new configuration</span>
                      <ArrowRight className='ml-2 h-5 w-5' />
                    </motion.div>
                  </CardContent>
                </Card>
              </motion.div>
            </div>
          </>
        ) : selectedOption === 'new' ? (
          <div className='max-w-4xl mx-auto'>
            <Button
              variant='ghost'
              className='mb-8 text-lg'
              onClick={() => setSelectedOption(null)}
            >
              ← Back to options
            </Button>

            <div className='flex items-center justify-between mb-6'>
              <div className='flex items-center gap-2'>
                <span className='text-sm text-muted-foreground'>
                  Step {step} of {steps.length}
                </span>
              </div>
            </div>
            <div className='mb-6'>
              <Progress value={(step / steps.length) * 100} className='h-2 bg-muted/50' />
            </div>
            <div className='mb-8 flex items-center justify-between'>
              {steps.map((s, index) => (
                <div key={s.id} className='flex flex-col items-center'>
                  <motion.div
                    className={cn(
                      'flex h-8 w-8 items-center justify-center rounded-full border-2',
                      Number(step) > s.id
                        ? 'border-primary bg-primary text-primary-foreground'
                        : Number(step) === s.id
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-muted bg-background text-muted-foreground',
                    )}
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ duration: 0.3, delay: index * 0.1 }}
                  >
                    {Number(step) > s.id ? (
                      <CheckCircle2 className='h-5 w-5' />
                    ) : Number(step) === s.id ? (
                      <Circle className='h-5 w-5' />
                    ) : (
                      <Circle className='h-5 w-5' />
                    )}
                  </motion.div>
                  <motion.span
                    className={cn(
                      'mt-2 text-sm font-medium',
                      Number(step) >= s.id ? 'text-foreground' : 'text-muted-foreground',
                    )}
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ duration: 0.3, delay: index * 0.1 }}
                  >
                    {s.title}
                  </motion.span>
                </div>
              ))}
            </div>

            <AnimatePresence mode='wait'>
              {isComplete ? (
                <motion.div
                  key='success'
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                >
                  <Card className='shadow-lg'>
                    <CardHeader>
                      <CardTitle className='flex items-center gap-2'>
                        <CheckCircle2 className='h-6 w-6 text-green-500' />
                        Configuration Complete!
                      </CardTitle>
                      <CardDescription>
                        Your configuration has been successfully saved.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      <Alert className='mb-6'>
                        <Check className='h-4 w-4' />
                        <AlertTitle>Success!</AlertTitle>
                        <AlertDescription>
                          You have successfully configured {chainConfigs.length} chain
                          {chainConfigs.length !== 1 ? 's' : ''} with their providers.
                        </AlertDescription>
                      </Alert>
                      <div className='space-y-4'>
                        {chainConfigs.map((chain, index) => (
                          <motion.div
                            key={index}
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: index * 0.1 }}
                          >
                            <Card className='p-6 border-primary/20'>
                              <div className='space-y-4'>
                                <h4 className='font-medium text-lg'>
                                  {chain.name}
                                  {(() => {
                                    const chainConfig = chains.find(c => c.value === chain.name);
                                    return chainConfig ? (
                                      <>
                                        {' '}
                                        ({chainConfig.label}{' '}
                                        <img
                                          src={chainConfig.icon}
                                          alt={chainConfig.label}
                                          className='w-4 h-4 inline-block ml-1'
                                        />
                                        )
                                      </>
                                    ) : (
                                      ''
                                    );
                                  })()}
                                </h4>

                                {/* Get unique providers across all interfaces */}
                                {Array.from(
                                  new Set(
                                    chain.interfaces.flatMap(iface =>
                                      iface.providers.map(p => p.name),
                                    ),
                                  ),
                                ).map(providerName => {
                                  // Get all interfaces that have this provider
                                  const providerInterfaces = chain.interfaces.filter(iface =>
                                    iface.providers.some(p => p.name === providerName),
                                  );
                                  return (
                                    <ProviderCard
                                      key={providerName}
                                      providerName={providerName}
                                      interfaces={providerInterfaces}
                                      chainIndex={index}
                                    />
                                  );
                                })}
                              </div>
                            </Card>
                          </motion.div>
                        ))}
                      </div>
                      <div className='mt-6 flex justify-center'>
                        <Button onClick={resetWizard} className='bg-primary hover:bg-primary/90'>
                          Start New Configuration
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              ) : (
                <motion.div
                  key='wizard'
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  ref={formRef}
                >
                  <Card className='shadow-lg'>
                    <CardHeader>
                      <CardTitle>{steps[Number(step) - 1].title}</CardTitle>
                      <CardDescription>{steps[Number(step) - 1].description}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      {Number(step) === 1 && (
                        <motion.div
                          className='space-y-6'
                          initial={{ opacity: 0, x: -20 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: 20 }}
                        >
                          <div className='flex items-center justify-between'>
                            <Button onClick={addChain} className='bg-primary hover:bg-primary/90'>
                              <Plus className='mr-2 h-4 w-4' />
                              Add Chain
                            </Button>
                          </div>
                          {chainConfigs.map((chain, index) => (
                            <motion.div
                              key={index}
                              initial={{ opacity: 0, y: 20 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ delay: index * 0.1 }}
                            >
                              <Card className='p-6 border-primary/20'>
                                <div className='space-y-4'>
                                  <div className='flex items-center justify-between'>
                                    <h4 className='font-medium'>Chain {index + 1}</h4>
                                    <Button
                                      variant='ghost'
                                      size='sm'
                                      onClick={() => removeChain(index)}
                                    >
                                      <Trash2 className='h-4 w-4 text-destructive' />
                                    </Button>
                                  </div>
                                  <div className='space-y-2'>
                                    <Select
                                      value={chain.name}
                                      onValueChange={value => {
                                        const newChains = [...chainConfigs];
                                        newChains[index] = {
                                          name: value,
                                          interfaces: [],
                                        };
                                        setChainConfigs(newChains);
                                      }}
                                    >
                                      <SelectTrigger
                                        className={cn(
                                          errors[`chain-name-${index}`] && 'border-destructive',
                                        )}
                                      >
                                        <SelectValue placeholder='Select chain' />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {chains.map(chain => (
                                          <SelectItem key={chain.value} value={chain.value}>
                                            <div className='flex items-center gap-2'>
                                              <img
                                                src={chain.icon}
                                                alt={chain.label}
                                                className='w-4 h-4'
                                              />
                                              <span>{chain.label}</span>
                                            </div>
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                    {errors[`chain-name-${index}`] && (
                                      <div className='flex items-center gap-1 text-sm text-destructive'>
                                        <AlertCircle className='h-4 w-4' />
                                        {errors[`chain-name-${index}`]}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </Card>
                            </motion.div>
                          ))}
                          <div className='mt-8 flex justify-end'>
                            <Button
                              onClick={nextStep}
                              disabled={chainConfigs.length === 0}
                              className='w-32 bg-primary hover:bg-primary/90'
                            >
                              Next
                              <ChevronRight className='ml-2 h-4 w-4' />
                            </Button>
                          </div>
                        </motion.div>
                      )}

                      {Number(step) === 2 && (
                        <motion.div
                          className='space-y-6'
                          initial={{ opacity: 0, x: -20 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: 20 }}
                        >
                          <div className='flex items-center justify-between'>
                            <div className='space-y-1'>
                              <h3 className='text-lg font-medium'>
                                Configure Providers for{' '}
                                <span className='text-primary font-bold'>
                                  {(() => {
                                    const chainInfo = chains.find(
                                      c => c.value === chainConfigs[currentChainIndex]?.name,
                                    );
                                    return chainInfo ? (
                                      <>
                                        {' '}
                                        {chainInfo.label}{' '}
                                        <img
                                          src={chainInfo.icon}
                                          alt={chainInfo.label}
                                          className='w-4 h-4 inline-block ml-1'
                                        />
                                      </>
                                    ) : (
                                      ''
                                    );
                                  })()}
                                </span>
                              </h3>
                              <p className='text-sm text-muted-foreground'>
                                Add and configure providers to handle requests for this chain
                              </p>
                            </div>
                            <Button
                              onClick={() => addProvider(currentChainIndex)}
                              className='bg-primary hover:bg-primary/90'
                            >
                              <Plus className='mr-2 h-4 w-4' />
                              Add Provider
                            </Button>
                          </div>

                          {/* Group interfaces by provider */}
                          {Object.entries(
                            chainConfigs[currentChainIndex]?.interfaces.reduce(
                              (acc, iface, index) => {
                                // Get all providers for this interface
                                iface.providers.forEach(provider => {
                                  const providerName = provider.name;
                                  if (!acc[providerName]) {
                                    acc[providerName] = [];
                                  }
                                  // Add this interface to the provider's group
                                  acc[providerName].push({ iface, index });
                                });
                                return acc;
                              },
                              {} as Record<string, { iface: ChainInterface; index: number }[]>,
                            ),
                          ).map(([providerName, interfaceGroup]) => {
                            // Initialize expanded state for this provider if it doesn't exist yet
                            if (expandedProviders[providerName] === undefined) {
                              setExpandedProviders(prev => ({ ...prev, [providerName]: true }));
                            }

                            return (
                              <motion.div
                                key={providerName}
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: 0.1 }}
                              >
                                <Card className='p-6 border-primary/20'>
                                  <div className='space-y-4'>
                                    <div
                                      className='flex items-center justify-between cursor-pointer'
                                      onClick={() =>
                                        setExpandedProviders({
                                          ...expandedProviders,
                                          [providerName]: !expandedProviders[providerName],
                                        })
                                      }
                                    >
                                      <div className='space-y-1'>
                                        <h4 className='font-medium text-lg'>
                                          Provider{providerName ? `: ${providerName}` : ''}
                                        </h4>
                                        <div className='flex flex-col gap-1'>
                                          <div className='flex flex-wrap gap-1 mt-1'>
                                            {interfaceGroup.map(({ iface }) => (
                                              <span
                                                key={getInterfaceName(iface.name)}
                                                className={cn(
                                                  'text-xs px-2 py-0.5 rounded',
                                                  hasInterfaceType(iface.name, 'jsonrpc') &&
                                                    'bg-blue-500/10 text-blue-700',
                                                  hasInterfaceType(iface.name, 'tendermintrpc') &&
                                                    'bg-green-500/10 text-green-700',
                                                  hasInterfaceType(iface.name, 'rest') &&
                                                    'bg-purple-500/10 text-purple-700',
                                                  hasInterfaceType(iface.name, 'grpc') &&
                                                    'bg-orange-500/10 text-orange-700',
                                                )}
                                              >
                                                {getInterfaceName(iface.name)}
                                              </span>
                                            ))}
                                          </div>
                                        </div>
                                      </div>
                                      <div className='flex items-center gap-2'>
                                        <Button
                                          variant='ghost'
                                          size='sm'
                                          onClick={e => {
                                            e.stopPropagation();
                                            setExpandedProviders({
                                              ...expandedProviders,
                                              [providerName]: !expandedProviders[providerName],
                                            });
                                          }}
                                        >
                                          {expandedProviders[providerName] ? (
                                            <ChevronLeft className='h-4 w-4' />
                                          ) : (
                                            <ChevronRight className='h-4 w-4' />
                                          )}
                                        </Button>
                                        <Button
                                          variant='ghost'
                                          size='sm'
                                          onClick={e => {
                                            e.stopPropagation();
                                            // Remove all interfaces associated with this provider
                                            const newChains = [...chainConfigs];
                                            const interfaceIndices = interfaceGroup
                                              .map(i => i.index)
                                              .sort((a, b) => b - a); // Remove from end to beginning
                                            interfaceIndices.forEach(idx => {
                                              newChains[currentChainIndex].interfaces.splice(
                                                idx,
                                                1,
                                              );
                                            });
                                            setChainConfigs(newChains);
                                            setErrors({});
                                            toast({
                                              title: 'Provider removed',
                                              description:
                                                'The provider and all its interfaces have been removed.',
                                            });
                                          }}
                                        >
                                          <Trash2 className='h-4 w-4 text-destructive' />
                                        </Button>
                                      </div>
                                    </div>

                                    {expandedProviders[providerName] && (
                                      <>
                                        {/* Provider Name - Only show once for each provider */}
                                        <div className='space-y-2'>
                                          <Label
                                            htmlFor={`provider-name-${currentChainIndex}-${providerName}`}
                                          >
                                            Provider Name
                                          </Label>
                                          <Input
                                            id={`provider-name-${currentChainIndex}-${providerName}`}
                                            value={localProviderName || providerName}
                                            onChange={e => {
                                              const newName = e.target.value;
                                              // Check if the name is already used by another provider
                                              const isNameUsed = Object.keys(
                                                chainConfigs[currentChainIndex].interfaces
                                                  .filter(
                                                    iface =>
                                                      iface.providers[0]?.name !== providerName &&
                                                      iface.providers[0]?.name !== '',
                                                  )
                                                  .reduce(
                                                    (acc, iface) => {
                                                      acc[iface.providers[0]?.name] = true;
                                                      return acc;
                                                    },
                                                    {} as Record<string, boolean>,
                                                  ),
                                              ).includes(newName);

                                              if (isNameUsed) {
                                                toast({
                                                  title: 'Name already in use',
                                                  description:
                                                    'This provider name is already being used by another provider.',
                                                  variant: 'destructive',
                                                });
                                                return;
                                              }

                                              handleProviderNameChange(
                                                currentChainIndex,
                                                providerName,
                                                newName,
                                              );
                                            }}
                                          />
                                        </div>

                                        {interfaceGroup.map(({ iface, index }) => (
                                          <motion.div
                                            key={index}
                                            initial={{ opacity: 0, y: 20 }}
                                            animate={{ opacity: 1, y: 0 }}
                                            transition={{ delay: index * 0.1 }}
                                          >
                                            <Card className='p-4 border-muted'>
                                              <div className='space-y-4'>
                                                <div className='space-y-2'>
                                                  <div className='flex items-center justify-between'>
                                                    <div>
                                                      <Label>Interface Types</Label>
                                                    </div>
                                                    <Button
                                                      variant='ghost'
                                                      size='sm'
                                                      onClick={() =>
                                                        removeProvider(currentChainIndex, index)
                                                      }
                                                    >
                                                      <Trash2 className='h-4 w-4 text-destructive' />
                                                    </Button>
                                                  </div>

                                                  <div className='flex flex-wrap gap-2'>
                                                    {getAvailableInterfaces(
                                                      chainConfigs[currentChainIndex].name,
                                                    ).map(interfaceType => {
                                                      // Check if this interface type is already used by other interfaces of the same provider
                                                      const isUsed = chainConfigs[
                                                        currentChainIndex
                                                      ].interfaces
                                                        .filter(
                                                          iface =>
                                                            iface.providers[0]?.name ===
                                                            providerName,
                                                        )
                                                        .filter((_, i) => i !== index) // Exclude current interface
                                                        .some(iface =>
                                                          hasInterfaceType(
                                                            iface.name,
                                                            interfaceType.value,
                                                          ),
                                                        );

                                                      return (
                                                        <Button
                                                          key={interfaceType.value}
                                                          variant={
                                                            hasInterfaceType(
                                                              iface.name,
                                                              interfaceType.value,
                                                            )
                                                              ? 'default'
                                                              : 'outline'
                                                          }
                                                          size='sm'
                                                          className={cn(
                                                            hasInterfaceType(
                                                              iface.name,
                                                              interfaceType.value,
                                                            ) &&
                                                              (interfaceType.value === 'jsonrpc'
                                                                ? 'bg-blue-500 hover:bg-blue-600'
                                                                : interfaceType.value ===
                                                                    'tendermintrpc'
                                                                  ? 'bg-green-500 hover:bg-green-600'
                                                                  : interfaceType.value === 'rest'
                                                                    ? 'bg-purple-500 hover:bg-purple-600'
                                                                    : interfaceType.value === 'grpc'
                                                                      ? 'bg-orange-500 hover:bg-orange-600'
                                                                      : ''),
                                                            'hover:opacity-90',
                                                            isUsed &&
                                                              'opacity-50 cursor-not-allowed',
                                                          )}
                                                          onClick={() => {
                                                            if (isUsed) return;
                                                            const newChains = [...chainConfigs];
                                                            newChains[currentChainIndex].interfaces[
                                                              index
                                                            ].name = [interfaceType.value];
                                                            setChainConfigs(newChains);
                                                          }}
                                                          disabled={isUsed}
                                                        >
                                                          {interfaceType.label}
                                                        </Button>
                                                      );
                                                    })}
                                                  </div>
                                                </div>

                                                <div className='space-y-2'>
                                                  <Label>Node Endpoint</Label>
                                                  <Input
                                                    value={
                                                      iface.providers[0]?.nodes[0]?.endpoint || ''
                                                    }
                                                    onChange={e => {
                                                      const newChains = [...chainConfigs];
                                                      const currentProvider =
                                                        newChains[currentChainIndex].interfaces[
                                                          index
                                                        ].providers[0];
                                                      if (!currentProvider.nodes[0]) {
                                                        currentProvider.nodes = [
                                                          {
                                                            endpoint: e.target.value,
                                                            type: 'full',
                                                          },
                                                        ];
                                                      } else {
                                                        currentProvider.nodes[0].endpoint =
                                                          e.target.value;
                                                      }

                                                      setChainConfigs(newChains);
                                                    }}
                                                  />
                                                </div>
                                              </div>
                                            </Card>
                                          </motion.div>
                                        ))}

                                        {/* Only show "Add Another Interface" button for the last interface of this provider group if more interfaces are available */}
                                        {(() => {
                                          // Get the chain's supported interfaces
                                          const chainInfo = chains.find(
                                            c => c.value === chainConfigs[currentChainIndex].name,
                                          );
                                          const supportedInterfaces =
                                            chainInfo?.supportedInterfaces || [];

                                          // Get all used interface types for this provider
                                          const usedInterfaceTypes = chainConfigs[
                                            currentChainIndex
                                          ].interfaces
                                            .filter(
                                              iface => iface.providers[0]?.name === providerName,
                                            )
                                            .map(iface => iface.name[0]);

                                          // Check if there are any available supported interfaces left
                                          const availableInterfaceTypes = interfaces.filter(
                                            interfaceType =>
                                              !usedInterfaceTypes.includes(interfaceType.value) &&
                                              supportedInterfaces.includes(interfaceType.value),
                                          );

                                          return availableInterfaceTypes.length > 0 ? (
                                            <Button
                                              variant='outline'
                                              size='sm'
                                              onClick={() => {
                                                // Find the last interface index for this provider
                                                const lastInterfaceIndex =
                                                  interfaceGroup[interfaceGroup.length - 1].index;
                                                addInterfaceToProvider(
                                                  currentChainIndex,
                                                  lastInterfaceIndex,
                                                  providerName,
                                                );
                                              }}
                                              className='w-full'
                                            >
                                              <Plus className='mr-2 h-4 w-4' />
                                              Add Another Interface
                                            </Button>
                                          ) : null;
                                        })()}
                                      </>
                                    )}
                                  </div>
                                </Card>
                              </motion.div>
                            );
                          })}
                          <div className='mt-8 flex justify-between'>
                            <Button variant='outline' onClick={prevStep} className='w-32'>
                              <ChevronLeft className='mr-2 h-4 w-4' />
                              Previous
                            </Button>
                            <Button
                              onClick={nextStep}
                              disabled={chainConfigs[currentChainIndex]?.interfaces.length === 0}
                              className='w-32 bg-primary hover:bg-primary/90'
                            >
                              Next
                              <ChevronRight className='ml-2 h-4 w-4' />
                            </Button>
                          </div>
                        </motion.div>
                      )}

                      {Number(step) === 3 && (
                        <motion.div
                          className='space-y-6'
                          initial={{ opacity: 0, x: -20 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: 20 }}
                        >
                          {chainConfigs.map((chain, index) => (
                            <motion.div
                              key={index}
                              initial={{ opacity: 0, y: 20 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ delay: index * 0.1 }}
                            >
                              <Card className='p-6 border-primary/20'>
                                <div className='space-y-4'>
                                  <h4 className='font-medium text-lg'>
                                    <span className='text-primary font-bold'>
                                      {(() => {
                                        const chainInfo = chains.find(c => c.value === chain.name);
                                        return chainInfo ? (
                                          <>
                                            {' '}
                                            {chainInfo.label}{' '}
                                            <img
                                              src={chainInfo.icon}
                                              alt={chainInfo.label}
                                              className='w-4 h-4 inline-block ml-1'
                                            />
                                          </>
                                        ) : (
                                          ''
                                        );
                                      })()}
                                    </span>
                                  </h4>

                                  {/* Get unique providers across all interfaces */}
                                  {Array.from(
                                    new Set(
                                      chain.interfaces.flatMap(iface =>
                                        iface.providers.map(p => p.name),
                                      ),
                                    ),
                                  ).map(providerName => {
                                    // Get all interfaces that have this provider
                                    const providerInterfaces = chain.interfaces.filter(iface =>
                                      iface.providers.some(p => p.name === providerName),
                                    );
                                    return (
                                      <ProviderCard
                                        key={providerName}
                                        providerName={providerName}
                                        interfaces={providerInterfaces}
                                        chainIndex={index}
                                      />
                                    );
                                  })}
                                </div>
                              </Card>
                            </motion.div>
                          ))}

                          <Card className='p-6 border-primary/20'>
                            <div className='space-y-4'>
                              <div className='flex items-center justify-between'>
                                <h4 className='font-medium text-lg'>Configuration Preview</h4>
                                <div className='flex items-center gap-2'>
                                  <Button
                                    variant='outline'
                                    size='sm'
                                    onClick={() => {
                                      navigator.clipboard.writeText(generateFinalConfig());
                                      toast({
                                        title: 'Copied to clipboard',
                                        description:
                                          'Configuration has been copied to your clipboard.',
                                      });
                                    }}
                                  >
                                    <svg
                                      xmlns='http://www.w3.org/2000/svg'
                                      width='16'
                                      height='16'
                                      viewBox='0 0 24 24'
                                      fill='none'
                                      stroke='currentColor'
                                      strokeWidth='2'
                                      strokeLinecap='round'
                                      strokeLinejoin='round'
                                      className='mr-2'
                                    >
                                      <rect width='14' height='14' x='8' y='8' rx='2' ry='2' />
                                      <path d='M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' />
                                    </svg>
                                    Copy
                                  </Button>
                                </div>
                              </div>
                              <pre className='bg-muted p-4 rounded-lg overflow-auto max-h-[500px]'>
                                <code>{finalConfig}</code>
                              </pre>
                            </div>
                          </Card>

                          <div className='mt-8 flex justify-between'>
                            <Button
                              variant='outline'
                              onClick={prevStep}
                              disabled={Number(step) === 1}
                              className='w-32'
                            >
                              <ChevronLeft className='mr-2 h-4 w-4' />
                              Previous
                            </Button>
                            <Button
                              onClick={nextStep}
                              disabled={
                                (Number(step) === 1 && chainConfigs.length === 0) ||
                                (Number(step) === 2 &&
                                  chainConfigs[currentChainIndex]?.interfaces.length === 0) ||
                                isSubmitting
                              }
                              className='w-32 bg-primary hover:bg-primary/90'
                            >
                              {isSubmitting ? (
                                <>
                                  <Loader2 className='mr-2 h-4 w-4 animate-spin' />
                                  Saving...
                                </>
                              ) : Number(step) === 3 ? (
                                'Complete'
                              ) : (
                                'Next'
                              )}
                              {!isSubmitting && <ChevronRight className='ml-2 h-4 w-4' />}
                            </Button>
                          </div>
                        </motion.div>
                      )}
                    </CardContent>
                  </Card>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ) : (
          <div className='max-w-4xl mx-auto'>
            <Button
              variant='ghost'
              className='mb-8 text-lg'
              onClick={() => setSelectedOption(null)}
            >
              ← Back to options
            </Button>

            <Card>
              <CardHeader>
                <CardTitle className='text-2xl'>Edit Configuration</CardTitle>
                <CardDescription className='text-lg'>
                  Modify your existing infrastructure setup
                </CardDescription>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className='flex items-center justify-center py-8'>
                    <Loader2 className='h-8 w-8 animate-spin text-primary' />
                    <span className='ml-2 text-muted-foreground'>
                      Loading current configuration...
                    </span>
                  </div>
                ) : apiError ? (
                  <Alert variant='destructive'>
                    <AlertCircle className='h-4 w-4' />
                    <AlertTitle>Connection Error</AlertTitle>
                    <AlertDescription>{apiError}</AlertDescription>
                  </Alert>
                ) : (
                  <div className='space-y-6'>
                    <div className='flex items-center justify-between'>
                      <h3 className='text-lg font-medium'>Current Configuration</h3>
                      <Button
                        onClick={() => {
                          setStep(1);
                          setSelectedOption('new');
                          setCurrentChainIndex(0);
                          setErrors({});
                          setIsComplete(false);
                          setProgress(0);
                        }}
                        className='bg-primary hover:bg-primary/90'
                      >
                        <Settings className='mr-2 h-4 w-4' />
                        Edit Configuration
                      </Button>
                    </div>

                    <div className='space-y-4'>
                      {chainConfigs.map((chain, index) => (
                        <motion.div
                          key={index}
                          initial={{ opacity: 0, y: 20 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ delay: index * 0.1 }}
                        >
                          <Card className='p-6 border-primary/20'>
                            <div className='space-y-4'>
                              <h4 className='font-medium text-lg'>
                                <span className='text-primary font-bold'>
                                  {(() => {
                                    const chainInfo = chains.find(c => c.value === chain.name);
                                    return chainInfo ? (
                                      <>
                                        {' '}
                                        {chainInfo.label}{' '}
                                        <img
                                          src={chainInfo.icon}
                                          alt={chainInfo.label}
                                          className='w-4 h-4 inline-block ml-1'
                                        />
                                      </>
                                    ) : (
                                      ''
                                    );
                                  })()}
                                </span>
                              </h4>

                              {/* Get unique providers across all interfaces */}
                              {Array.from(
                                new Set(
                                  chain.interfaces.flatMap(iface =>
                                    iface.providers.map(p => p.name),
                                  ),
                                ),
                              ).map(providerName => {
                                // Get all interfaces that have this provider
                                const providerInterfaces = chain.interfaces.filter(iface =>
                                  iface.providers.some(p => p.name === providerName),
                                );
                                return (
                                  <ProviderCard
                                    key={providerName}
                                    providerName={providerName}
                                    interfaces={providerInterfaces}
                                    chainIndex={index}
                                  />
                                );
                              })}
                            </div>
                          </Card>
                        </motion.div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </ProtectedRoute>
  );
}
