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

interface RouterInterface {
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

interface RouterConfig {
  name: string;
  interfaces: RouterInterface[];
}

interface NodeInterface {
  name: string;
  nodes: {
    endpoint: string;
    type: string;
  }[];
}

interface NodeModel {
  name: string;
  interfaces: NodeInterface[];
  routerIndex: number;
}

type Step = 1 | 2 | 3;
const steps = [
  { id: 1, title: 'Add Routers', description: 'Configure your routers' },
  { id: 2, title: 'Add Nodes', description: 'Configure nodes for each router' },
  { id: 3, title: 'Review', description: 'Review your configuration' },
];

const interfaces = [
  { value: 'jsonrpc', label: 'JSON-RPC', color: 'bg-blue-500' },
  { value: 'tendermintrpc', label: 'TendermintRPC', color: 'bg-green-500' },
  { value: 'rest', label: 'REST', color: 'bg-purple-500' },
  { value: 'grpc', label: 'gRPC', color: 'bg-red-500' },
];

interface NodeCardProps {
  providerName: string;
  interfaces: RouterInterface[];
  routerIndex: number;
}

const NodeCard = ({ providerName, interfaces, routerIndex }: NodeCardProps) => {
  return (
    <div className='space-y-2'>
      <div className='flex items-center gap-2'>
        <h5 className='font-medium'>Node: {providerName}</h5>
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

const useNodeNameUpdate = (
  routerConfigs: RouterConfig[],
  setRouterConfigs: React.Dispatch<React.SetStateAction<RouterConfig[]>>,
) => {
  const [localNodeName, setLocalNodeName] = useState<string>('');
  const [currentNodeKey, setCurrentNodeKey] = useState<string>('');
  const debouncedName = useDebounce(localNodeName, 1000);
  const { toast } = useToast();

  useEffect(() => {
    if (debouncedName && currentNodeKey) {
      const [routerIndex, nodeName] = currentNodeKey.split(':');
      updateNodeName(parseInt(routerIndex), nodeName, debouncedName);
    }
  }, [debouncedName, currentNodeKey]);

  const updateNodeName = useCallback(
    (routerIndex: number, oldName: string, newName: string) => {
      // Validate node name
      const nodeNameRegex = /^[a-zA-Z0-9_-]{3,}$/;
      if (!nodeNameRegex.test(newName)) {
        toast({
          title: 'Invalid node name',
          description:
            'Node name must be at least 3 characters long and contain only letters, numbers, hyphens, and underscores.',
          variant: 'destructive',
        });
        return;
      }

      setRouterConfigs((prevRouters: RouterConfig[]) => {
        const newRouters = [...prevRouters];
        const router = newRouters[routerIndex];

        // Create a new interfaces array with only the updated node
        const updatedInterfaces = router.interfaces.map((iface: RouterInterface) => {
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

        // Only update the specific router
        newRouters[routerIndex] = {
          ...router,
          interfaces: updatedInterfaces,
        };

        return newRouters;
      });
    },
    [setRouterConfigs, toast],
  );

  const handleNodeNameChange = useCallback(
    (routerIndex: number, nodeName: string, newName: string) => {
      setLocalNodeName(newName);
      setCurrentNodeKey(`${routerIndex}:${nodeName}`);
    },
    [],
  );

  return {
    localNodeName,
    setLocalNodeName,
    handleNodeNameChange,
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
  const [routerConfigs, setRouterConfigs] = useState<RouterConfig[]>([]);
  const [currentRouterIndex, setCurrentRouterIndex] = useState(0);
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
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>({});
  const { localNodeName, setLocalNodeName, handleNodeNameChange } = useNodeNameUpdate(
    routerConfigs,
    setRouterConfigs,
  );
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
          const transformedRouters = Object.entries(data.routers).map(
            ([routerId, router]: [string, any]) => {
              // Group interfaces by name only
              const interfaceMap = new Map<string, any>();

              // Extract interfaces from the new structure
              const interfaces = router.interfaces || [];
              const nodes = router.nodes || [];

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

                // Add nodes that support this interface
                nodes.forEach((node: any) => {
                  const nodeEndpoints = node.endpoints || [];
                  const relevantEndpoints = nodeEndpoints.filter(
                    (endpoint: any) => endpoint.interface === interfaceName,
                  );

                  if (relevantEndpoints.length > 0) {
                    const existingInterface = interfaceMap.get(interfaceName);
                    // Check if this node already exists
                    const existingNodeIndex = existingInterface.providers.findIndex(
                      (p: any) => p.name === node.name,
                    );

                    if (existingNodeIndex === -1) {
                      // Add new node
                      existingInterface.providers.push({
                        name: node.name,
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
                name: routerId,
                interfaces: Array.from(interfaceMap.values()),
              };
            },
          );

          console.log('Transformed routers:', transformedRouters);
          setRouterConfigs(transformedRouters);
          setStep(1);
          setCurrentRouterIndex(0);
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
  }, [step, chains, currentRouterIndex]);

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
      routerConfigs.forEach((router, index) => {
        if (!router.name) {
          newErrors[`router-name-${index}`] = 'Router is required';
        }
      });
    } else if (step === 2) {
      const currentRouter = routerConfigs[currentRouterIndex];
      if (!currentRouter || !currentRouter.interfaces || currentRouter.interfaces.length === 0) {
        newErrors[`router-interfaces-${currentRouterIndex}`] = 'No interfaces configured';
      } else {
        currentRouter.interfaces.forEach((iface, ifaceIndex) => {
          if (!iface.name || iface.name.length === 0) {
            newErrors[`interface-types-${currentRouterIndex}-${ifaceIndex}`] =
              'At least one interface type must be selected';
          }
          iface.providers.forEach((node, nodeIndex) => {
            if (!node.name) {
              newErrors[`node-name-${currentRouterIndex}-${ifaceIndex}-${nodeIndex}`] =
                'Node name is required';
            }
            if (!node.nodes?.[0]?.endpoint) {
              newErrors[`node-endpoint-${currentRouterIndex}-${ifaceIndex}-${nodeIndex}`] =
                'Node endpoint is required';
            } else if (
              !node.nodes[0].endpoint.startsWith('http://') &&
              !node.nodes[0].endpoint.startsWith('https://')
            ) {
              newErrors[`node-endpoint-${currentRouterIndex}-${ifaceIndex}-${nodeIndex}`] =
                'Node endpoint must be a valid URL starting with http:// or https://';
            }
          });
        });
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const addRouter = () => {
    setRouterConfigs([...routerConfigs, { name: '', interfaces: [] }]);
    controls.start({ scale: [1, 1.05, 1], transition: { duration: 0.3 } });
  };

  const removeRouter = (index: number) => {
    const newRouters = [...routerConfigs];
    newRouters.splice(index, 1);
    setRouterConfigs(newRouters);
    setErrors({});
    toast({
      title: 'Router removed',
      description: 'The router has been removed from the configuration.',
    });
  };

  const updateRouter = (index: number, field: keyof RouterConfig, value: any) => {
    const newRouters = [...routerConfigs];
    newRouters[index] = { ...newRouters[index], [field]: value };
    // If updating interfaces, ensure each interface has its own node
    if (field === 'interfaces') {
      const currentInterfaces = newRouters[index].interfaces;
      const newInterfaces: RouterInterface[] = [];

      // Create a node for each interface
      value.forEach((iface: RouterInterface) => {
        // Try to find an existing node for this interface
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
          // If not found, create a new node
          newInterfaces.push({
            ...iface,
            providers: iface.providers.map(p => ({
              ...p,
              addons: iface.addons,
            })),
          });
        }
      });

      newRouters[index].interfaces = newInterfaces;
    }
    setRouterConfigs(newRouters);
    setErrors({});
  };

  const addNode = (routerIndex: number) => {
    const newRouters = [...routerConfigs];

    // Find the highest port number used across all routers
    const highestPort = newRouters.reduce((maxPort, router) => {
      const routerMaxPort = router.interfaces.reduce(
        (port, iface) => Math.max(port, iface.port),
        0,
      );
      return Math.max(maxPort, routerMaxPort);
    }, 1999); // Start from 1999 so first port will be 2000

    // Get the router name and count existing nodes for this router
    const routerName = newRouters[routerIndex].name;
    const nodeCount = newRouters[routerIndex].interfaces.filter(iface =>
      iface.providers[0]?.name?.startsWith(`${routerName}-`),
    ).length;

    // Generate default node name
    const defaultNodeName = `${routerName}-${nodeCount}`;

    // Create a new interface with a new node
    newRouters[routerIndex].interfaces.push({
      name: [], // Don't set a default interface type
      port: highestPort + 1, // Use the next available port
      addons: ['archive', 'debug'], // Always include both addons
      providers: [
        {
          name: defaultNodeName, // Use the generated default name
          url: `${defaultNodeName}-provider.lava-infra.svc.cluster.local:2200`,
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

    // Collapse all existing nodes
    const newExpandedNodes = { ...expandedNodes };
    Object.keys(newExpandedNodes).forEach(key => {
      newExpandedNodes[key] = false;
    });
    // Expand only the new node
    newExpandedNodes[defaultNodeName] = true;
    setExpandedNodes(newExpandedNodes);

    // Reset the local node name state
    setLocalNodeName('');

    setRouterConfigs(newRouters);
    setErrors({} as Record<string, string>);
    controls.start({ scale: [1, 1.05, 1], transition: { duration: 0.3 } });
  };

  const addInterfaceToNode = (routerIndex: number, interfaceIndex: number, nodeName: string) => {
    const newRouters = [...routerConfigs];
    const currentInterface = newRouters[routerIndex].interfaces[interfaceIndex];

    // Get the router's supported interfaces
    const routerInfo = chains.find(c => c.value === newRouters[routerIndex].name);
    const supportedInterfaces = routerInfo?.supportedInterfaces || [];

    // Get all used interface types for this node
    const usedInterfaceTypes = newRouters[routerIndex].interfaces
      .filter(iface => iface.providers[0]?.name === nodeName)
      .map(iface => iface.name[0]);

    // Find the first available supported interface that hasn't been used
    const availableInterface = interfaces.find(
      iface =>
        supportedInterfaces.includes(iface.value) && !usedInterfaceTypes.includes(iface.value),
    );

    if (!availableInterface) {
      toast({
        title: 'No available interfaces',
        description: 'All supported interface types are already configured for this node.',
        variant: 'destructive',
      });
      return;
    }

    // Create a new interface with the same node
    const newInterface = {
      name: [availableInterface.value],
      port: currentInterface.port + 1,
      addons: ['archive', 'debug'], // Always include both addons
      providers: [
        {
          name: nodeName,
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
    newRouters[routerIndex].interfaces.splice(interfaceIndex + 1, 0, newInterface);

    setRouterConfigs(newRouters);
    setErrors({} as Record<string, string>);
  };

  const removeNode = (routerIndex: number, nodeIndex: number) => {
    const newRouters = [...routerConfigs];
    newRouters[routerIndex].interfaces.splice(nodeIndex, 1);
    setRouterConfigs(newRouters);
    setErrors({});
    toast({
      title: 'Node removed',
      description: 'The node has been removed from the configuration.',
    });
  };

  const updateNode = (
    routerIndex: number,
    interfaceIndex: number,
    nodeIndex: number,
    updates: Partial<{ name: string; url: string }>,
  ) => {
    const newRouters = [...routerConfigs];
    const currentNode = newRouters[routerIndex].interfaces[interfaceIndex].providers[nodeIndex];

    if (updates.name) {
      // Update URL based on the new name
      updates.url = `${updates.name}.lava-infra.svc.cluster.local:2200`;
    }

    newRouters[routerIndex].interfaces[interfaceIndex].providers[nodeIndex] = {
      ...currentNode,
      ...updates,
    };
    setRouterConfigs(newRouters);
    setErrors({} as Record<string, string>);
  };

  const generateFinalConfig = useCallback(() => {
    const config: any = {
      chains: {},
    };

    // Process routers
    routerConfigs.forEach(router => {
      // Create a map to store interfaces by name
      const interfaceMap = new Map();

      // First pass: collect all interfaces and their nodes
      router.interfaces.forEach(iface => {
        const interfaceName = iface.name[0];
        if (!interfaceMap.has(interfaceName)) {
          interfaceMap.set(interfaceName, {
            name: interfaceName,
            port: iface.port,
            providers: [],
          });
        }

        // Add nodes to the existing interface
        const existingInterface = interfaceMap.get(interfaceName);
        existingInterface.providers.push(
          ...iface.providers.map(node => ({
            name: node.name,
            url: node.url,
            nodes: node.nodes.map(endpoint => ({
              endpoint: endpoint.endpoint,
              type: 'full', // Always set type to "full"
            })),
          })),
        );
      });

      // Add the router with combined interfaces
      config.chains[router.name] = {
        addons: ['archive', 'debug'], // Move addons to router level
        interfaces: Array.from(interfaceMap.values()),
      };
    });

    return JSON.stringify(config, null, 2);
  }, [routerConfigs]);

  // Update the useEffect to set the final config when routers change
  useEffect(() => {
    if (step === 3) {
      setFinalConfig(generateFinalConfig());
    }
  }, [step, routerConfigs, generateFinalConfig]);

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

    if (step === 1 && routerConfigs.length > 0) {
      setStep(2);
    } else if (step === 2 && currentRouterIndex < routerConfigs.length - 1) {
      setCurrentRouterIndex(currentRouterIndex + 1);
    } else if (step === 2 && currentRouterIndex === routerConfigs.length - 1) {
      setStep(3);
    } else if (step === 3) {
      await handleComplete();
    }
  };

  const prevStep = () => {
    if (step === 2 && currentRouterIndex > 0) {
      setCurrentRouterIndex(currentRouterIndex - 1);
    } else if (step === 2 && currentRouterIndex === 0) {
      setStep(1);
    } else if (step === 3) {
      setStep(2);
    }
  };

  const resetWizard = () => {
    setStep(1);
    setRouterConfigs([]);
    setCurrentRouterIndex(0);
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
                      Update your current routers, nodes, and their relationships while preserving
                      existing configurations.
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
                    setRouterConfigs([]);
                    setCurrentRouterIndex(0);
                    setErrors({});
                    setIsComplete(false);
                    setProgress(0);
                    setShowConfig(false);
                    setFinalConfig('');
                    setApiError(null);
                    setIsLoading(false);
                    setExpandedNodes({});
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
                          You have successfully configured {routerConfigs.length} router
                          {routerConfigs.length !== 1 ? 's' : ''} with their nodes.
                        </AlertDescription>
                      </Alert>
                      <div className='space-y-4'>
                        {routerConfigs.map((router, index) => (
                          <motion.div
                            key={index}
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: index * 0.1 }}
                          >
                            <Card className='p-6 border-primary/20'>
                              <div className='space-y-4'>
                                <h4 className='font-medium text-lg'>
                                  {router.name}
                                  {(() => {
                                    const routerConfig = chains.find(c => c.value === router.name);
                                    return routerConfig ? (
                                      <>
                                        {' '}
                                        ({routerConfig.label}{' '}
                                        <img
                                          src={routerConfig.icon}
                                          alt={routerConfig.label}
                                          className='w-4 h-4 inline-block ml-1'
                                        />
                                        )
                                      </>
                                    ) : (
                                      ''
                                    );
                                  })()}
                                </h4>

                                {/* Get unique nodes across all interfaces */}
                                {Array.from(
                                  new Set(
                                    router.interfaces.flatMap(iface =>
                                      iface.providers.map(p => p.name),
                                    ),
                                  ),
                                ).map(providerName => {
                                  // Get all interfaces that have this node
                                  const providerInterfaces = router.interfaces.filter(iface =>
                                    iface.providers.some(p => p.name === providerName),
                                  );
                                  return (
                                    <NodeCard
                                      key={providerName}
                                      providerName={providerName}
                                      interfaces={providerInterfaces}
                                      routerIndex={index}
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
                            <Button onClick={addRouter} className='bg-primary hover:bg-primary/90'>
                              <Plus className='mr-2 h-4 w-4' />
                              Add Router
                            </Button>
                          </div>
                          {routerConfigs.map((router, index) => (
                            <motion.div
                              key={index}
                              initial={{ opacity: 0, y: 20 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ delay: index * 0.1 }}
                            >
                              <Card className='p-6 border-primary/20'>
                                <div className='space-y-4'>
                                  <div className='flex items-center justify-between'>
                                    <h4 className='font-medium'>Router {index + 1}</h4>
                                    <Button
                                      variant='ghost'
                                      size='sm'
                                      onClick={() => removeRouter(index)}
                                    >
                                      <Trash2 className='h-4 w-4 text-destructive' />
                                    </Button>
                                  </div>
                                  <div className='space-y-2'>
                                    <Select
                                      value={router.name}
                                      onValueChange={value => {
                                        const newRouters = [...routerConfigs];
                                        newRouters[index] = {
                                          name: value,
                                          interfaces: [],
                                        };
                                        setRouterConfigs(newRouters);
                                      }}
                                    >
                                      <SelectTrigger
                                        className={cn(
                                          errors[`router-name-${index}`] && 'border-destructive',
                                        )}
                                      >
                                        <SelectValue placeholder='Select router' />
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
                                    {errors[`router-name-${index}`] && (
                                      <div className='flex items-center gap-1 text-sm text-destructive'>
                                        <AlertCircle className='h-4 w-4' />
                                        {errors[`router-name-${index}`]}
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
                              disabled={routerConfigs.length === 0}
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
                                Configure Nodes for{' '}
                                <span className='text-primary font-bold'>
                                  {(() => {
                                    const routerInfo = chains.find(
                                      c => c.value === routerConfigs[currentRouterIndex]?.name,
                                    );
                                    return routerInfo ? (
                                      <>
                                        {' '}
                                        {routerInfo.label}{' '}
                                        <img
                                          src={routerInfo.icon}
                                          alt={routerInfo.label}
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
                                Add and configure nodes to handle requests for this router
                              </p>
                            </div>
                            <Button
                              onClick={() => addNode(currentRouterIndex)}
                              className='bg-primary hover:bg-primary/90'
                            >
                              <Plus className='mr-2 h-4 w-4' />
                              Add Node
                            </Button>
                          </div>

                          {/* Group interfaces by node */}
                          {Object.entries(
                            routerConfigs[currentRouterIndex]?.interfaces.reduce(
                              (acc, iface, index) => {
                                // Get all nodes for this interface
                                iface.providers.forEach(node => {
                                  const nodeName = node.name;
                                  if (!acc[nodeName]) {
                                    acc[nodeName] = [];
                                  }
                                  // Add this interface to the node's group
                                  acc[nodeName].push({ iface, index });
                                });
                                return acc;
                              },
                              {} as Record<string, { iface: RouterInterface; index: number }[]>,
                            ),
                          ).map(([providerName, interfaceGroup]) => {
                            // Initialize expanded state for this node if it doesn't exist yet
                            if (expandedNodes[providerName] === undefined) {
                              setExpandedNodes(prev => ({ ...prev, [providerName]: true }));
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
                                        setExpandedNodes({
                                          ...expandedNodes,
                                          [providerName]: !expandedNodes[providerName],
                                        })
                                      }
                                    >
                                      <div className='space-y-1'>
                                        <h4 className='font-medium text-lg'>
                                          Node{providerName ? `: ${providerName}` : ''}
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
                                            setExpandedNodes({
                                              ...expandedNodes,
                                              [providerName]: !expandedNodes[providerName],
                                            });
                                          }}
                                        >
                                          {expandedNodes[providerName] ? (
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
                                            // Remove all interfaces associated with this node
                                            const newRouters = [...routerConfigs];
                                            const interfaceIndices = interfaceGroup
                                              .map(i => i.index)
                                              .sort((a, b) => b - a); // Remove from end to beginning
                                            interfaceIndices.forEach(idx => {
                                              newRouters[currentRouterIndex].interfaces.splice(
                                                idx,
                                                1,
                                              );
                                            });
                                            setRouterConfigs(newRouters);
                                            setErrors({});
                                            toast({
                                              title: 'Node removed',
                                              description:
                                                'The node and all its interfaces have been removed.',
                                            });
                                          }}
                                        >
                                          <Trash2 className='h-4 w-4 text-destructive' />
                                        </Button>
                                      </div>
                                    </div>

                                    {expandedNodes[providerName] && (
                                      <>
                                        {/* Node Name - Only show once for each node */}
                                        <div className='space-y-2'>
                                          <Label
                                            htmlFor={`node-name-${currentRouterIndex}-${providerName}`}
                                          >
                                            Node Name
                                          </Label>
                                          <Input
                                            id={`node-name-${currentRouterIndex}-${providerName}`}
                                            value={localNodeName || providerName}
                                            onChange={e => {
                                              const newName = e.target.value;
                                              // Check if the name is already used by another node
                                              const isNameUsed = Object.keys(
                                                routerConfigs[currentRouterIndex].interfaces
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
                                                    'This node name is already being used by another node.',
                                                  variant: 'destructive',
                                                });
                                                return;
                                              }

                                              handleNodeNameChange(
                                                currentRouterIndex,
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
                                                        removeNode(currentRouterIndex, index)
                                                      }
                                                    >
                                                      <Trash2 className='h-4 w-4 text-destructive' />
                                                    </Button>
                                                  </div>

                                                  <div className='flex flex-wrap gap-2'>
                                                    {getAvailableInterfaces(
                                                      routerConfigs[currentRouterIndex].name,
                                                    ).map(interfaceType => {
                                                      // Check if this interface type is already used by other interfaces of the same node
                                                      const isUsed = routerConfigs[
                                                        currentRouterIndex
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
                                                            const newRouters = [...routerConfigs];
                                                            newRouters[
                                                              currentRouterIndex
                                                            ].interfaces[index].name = [
                                                              interfaceType.value,
                                                            ];
                                                            setRouterConfigs(newRouters);
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
                                                      const newRouters = [...routerConfigs];
                                                      const currentNode =
                                                        newRouters[currentRouterIndex].interfaces[
                                                          index
                                                        ].providers[0];
                                                      if (!currentNode.nodes[0]) {
                                                        currentNode.nodes = [
                                                          {
                                                            endpoint: e.target.value,
                                                            type: 'full',
                                                          },
                                                        ];
                                                      } else {
                                                        currentNode.nodes[0].endpoint =
                                                          e.target.value;
                                                      }

                                                      setRouterConfigs(newRouters);
                                                    }}
                                                  />
                                                </div>
                                              </div>
                                            </Card>
                                          </motion.div>
                                        ))}

                                        {/* Only show "Add Another Interface" button for the last interface of this node group if more interfaces are available */}
                                        {(() => {
                                          // Get the router's supported interfaces
                                          const routerInfo = chains.find(
                                            c => c.value === routerConfigs[currentRouterIndex].name,
                                          );
                                          const supportedInterfaces =
                                            routerInfo?.supportedInterfaces || [];

                                          // Get all used interface types for this node
                                          const usedInterfaceTypes = routerConfigs[
                                            currentRouterIndex
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
                                                // Find the last interface index for this node
                                                const lastInterfaceIndex =
                                                  interfaceGroup[interfaceGroup.length - 1].index;
                                                addInterfaceToNode(
                                                  currentRouterIndex,
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
                              disabled={routerConfigs[currentRouterIndex]?.interfaces.length === 0}
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
                          {routerConfigs.map((router, index) => (
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
                                        const routerInfo = chains.find(
                                          c => c.value === router.name,
                                        );
                                        return routerInfo ? (
                                          <>
                                            {' '}
                                            {routerInfo.label}{' '}
                                            <img
                                              src={routerInfo.icon}
                                              alt={routerInfo.label}
                                              className='w-4 h-4 inline-block ml-1'
                                            />
                                          </>
                                        ) : (
                                          ''
                                        );
                                      })()}
                                    </span>
                                  </h4>

                                  {/* Get unique nodes across all interfaces */}
                                  {Array.from(
                                    new Set(
                                      router.interfaces.flatMap(iface =>
                                        iface.providers.map(p => p.name),
                                      ),
                                    ),
                                  ).map(providerName => {
                                    // Get all interfaces that have this node
                                    const providerInterfaces = router.interfaces.filter(iface =>
                                      iface.providers.some(p => p.name === providerName),
                                    );
                                    return (
                                      <NodeCard
                                        key={providerName}
                                        providerName={providerName}
                                        interfaces={providerInterfaces}
                                        routerIndex={index}
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
                                (Number(step) === 1 && routerConfigs.length === 0) ||
                                (Number(step) === 2 &&
                                  routerConfigs[currentRouterIndex]?.interfaces.length === 0) ||
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
                          setCurrentRouterIndex(0);
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
                      {routerConfigs.map((router, index) => (
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
                                    const routerInfo = chains.find(c => c.value === router.name);
                                    return routerInfo ? (
                                      <>
                                        {' '}
                                        {routerInfo.label}{' '}
                                        <img
                                          src={routerInfo.icon}
                                          alt={routerInfo.label}
                                          className='w-4 h-4 inline-block ml-1'
                                        />
                                      </>
                                    ) : (
                                      ''
                                    );
                                  })()}
                                </span>
                              </h4>

                              {/* Get unique nodes across all interfaces */}
                              {Array.from(
                                new Set(
                                  router.interfaces.flatMap(iface =>
                                    iface.providers.map(p => p.name),
                                  ),
                                ),
                              ).map(providerName => {
                                // Get all interfaces that have this node
                                const providerInterfaces = router.interfaces.filter(iface =>
                                  iface.providers.some(p => p.name === providerName),
                                );
                                return (
                                  <NodeCard
                                    key={providerName}
                                    providerName={providerName}
                                    interfaces={providerInterfaces}
                                    routerIndex={index}
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
