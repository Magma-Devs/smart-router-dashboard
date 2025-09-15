'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Network,
  Server,
  User,
  X,
  ChevronDown,
  ChevronRight,
  ChevronUp,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { getChainLabel, getChainIcon } from '@/app/config/chains';
import { ChainsToProvidersResponse, ChainInfo } from '@/types/metrics';
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlowProvider,
  Edge,
  Node,
  useNodesInitialized,
  useStore,
  getRectOfNodes,
} from 'reactflow';
import 'reactflow/dist/style.css';
import React from 'react';

interface FlowVisualizationProps {
  data: ChainsToProvidersResponse | null;
  isAllExpanded?: boolean;
}

// Types for the flow visualization
interface Chain {
  name: string;
  label: string;
  icon?: string;
  healthy: boolean;
}

interface Provider {
  interface: string;
  healthy: boolean;
  service?: string;
}

interface Providers {
  [key: string]: Provider[];
}

interface ServiceGroup {
  service: string;
  providers: Provider[];
  allHealthy: boolean;
  anyHealthy: boolean;
  interfaces: Set<string>; // Track unique interfaces in this service
}

function MixedHealthIndicator() {
  return (
    <div className='relative w-4 h-4'>
      <Check
        className='absolute h-4 w-4 text-orange-500'
        style={{ clipPath: 'inset(0 50% 0 0)' }}
      />
      <X className='absolute h-4 w-4 text-orange-500' style={{ clipPath: 'inset(0 0 0 50%)' }} />
    </div>
  );
}

function UserNode({ data }: { data: any }) {
  return (
    <div className='px-4 py-2 rounded-xl border border-white/20 bg-white/10 backdrop-blur-md shadow-lg min-w-44 transition-all duration-200 hover:shadow-xl hover:scale-105 hover:bg-white/20 cursor-pointer'>
      <div className='flex items-center gap-2'>
        <User className='h-4 w-4' />
        <div className='font-medium'>User</div>
      </div>
      <Handle type='source' position={Position.Right} className='!bg-muted-foreground' />
    </div>
  );
}

function ChainNode({
  data,
}: {
  data: {
    label: string;
    chainName?: string;
    healthy: boolean;
    hasExpandedProviders?: boolean;
    onToggleExpand?: () => void;
    hasMultipleProviders?: boolean;
    icon?: string;
    hasMixedHealth?: boolean;
    width?: number;
  };
}) {
  return (
    <div
      className={cn(
        'px-4 py-2 shadow-lg rounded-xl border backdrop-blur-md transition-all duration-200 hover:shadow-xl hover:scale-105 cursor-pointer',
        data.healthy
          ? 'border-green-200/30 bg-green-50/10 hover:bg-green-50/20'
          : data.hasMixedHealth
            ? 'border-orange-200/30 bg-orange-50/10 hover:bg-orange-50/20'
            : 'border-red-200/30 bg-red-50/10 hover:bg-red-50/20',
      )}
      style={{ width: data.width ? `${data.width}px` : 'auto' }}
    >
      <Handle type='target' position={Position.Left} className='!bg-muted-foreground' />
      <div className='flex items-center gap-2'>
        {data.icon ? (
          <img src={data.icon} alt={data.label} className='w-4 h-4 flex-shrink-0' />
        ) : (
          <Network className='h-4 w-4 flex-shrink-0' />
        )}
        <div className='flex flex-col whitespace-nowrap'>
          <span className='font-medium'>{data.label}</span>
          {data.chainName && (
            <span className='text-xs text-muted-foreground'>{data.chainName}</span>
          )}
        </div>
        <div className='flex items-center ml-auto flex-shrink-0'>
          {data.hasMultipleProviders && (
            <button
              onClick={e => {
                e.stopPropagation();
                if (data.onToggleExpand) data.onToggleExpand();
              }}
              className='mr-2 p-1 hover:bg-muted rounded'
              title={data.hasExpandedProviders ? 'Collapse providers' : 'Expand providers'}
            >
              {data.hasExpandedProviders ? (
                <ChevronUp className='h-4 w-4 text-gray-500' />
              ) : (
                <ChevronDown className='h-4 w-4 text-gray-500' />
              )}
            </button>
          )}
          {data.healthy ? (
            <Check className='h-4 w-4 text-green-500' />
          ) : data.hasMixedHealth ? (
            <MixedHealthIndicator />
          ) : (
            <X className='h-4 w-4 text-red-500' />
          )}
        </div>
      </div>
      <Handle type='source' position={Position.Right} className='!bg-muted-foreground' />
    </div>
  );
}

function ProviderNode({
  data,
}: {
  data: {
    label: string;
    interface: string;
    healthy: boolean;
    isCollapseButton?: boolean;
    onCollapse?: () => void;
    service?: string;
  };
}) {
  return (
    <div
      className={cn(
        'px-4 py-2 shadow-lg rounded-xl border backdrop-blur-md min-w-44 transition-all duration-200 hover:shadow-xl hover:scale-105',
        data.isCollapseButton
          ? 'border-gray-200/30 bg-gray-50/10 hover:bg-gray-50/20 cursor-pointer'
          : data.healthy
            ? 'border-green-200/30 bg-green-50/10 hover:bg-green-50/20 cursor-pointer'
            : 'border-red-200/30 bg-red-50/10 hover:bg-red-50/20 cursor-pointer',
      )}
      onClick={data.isCollapseButton ? data.onCollapse : undefined}
    >
      <Handle type='target' position={Position.Left} className='!bg-muted-foreground' />
      <div className='flex items-center gap-2'>
        <Server className='h-4 w-4' />
        <div className='flex flex-col'>
          <span className='font-medium'>
            {data.isCollapseButton ? data.label : data.service || data.interface}
          </span>
          <span className='text-xs text-muted-foreground'>
            {data.isCollapseButton ? (
              <div className='flex items-center gap-1'>
                <ChevronUp className='h-3 w-3' />
                <span>Collapse</span>
              </div>
            ) : (
              data.interface
            )}
          </span>
        </div>
        {data.isCollapseButton ? (
          <ChevronUp className='h-4 w-4 text-gray-500 ml-auto' />
        ) : data.healthy ? (
          <Check className='h-4 w-4 text-green-500 ml-auto' />
        ) : (
          <X className='h-4 w-4 text-red-500 ml-auto' />
        )}
      </div>
    </div>
  );
}

function ProviderGroupNode({
  data,
}: {
  data: {
    label: string;
    providers: Provider[];
    isExpanded: boolean;
    onToggle: () => void;
    service?: string;
    interfaces?: Set<string>;
    maxWidth?: number;
  };
}) {
  const healthyCount = data.providers.filter(p => p.healthy).length;
  const totalCount = data.providers.length;
  const interfaceCount = data.interfaces ? data.interfaces.size : totalCount;
  const allHealthy = healthyCount === totalCount;
  const anyHealthy = healthyCount > 0;

  // Clean up service name by removing "-provider" substring
  const displayService = (data.service || data.label || '').replace(/-provider/g, '');

  // Group interfaces by health status
  const interfacesByHealth: { healthy: string[]; unhealthy: string[] } = {
    healthy: [],
    unhealthy: [],
  };

  data.providers.forEach(provider => {
    const interfaceName = provider.interface;
    if (provider.healthy) {
      interfacesByHealth.healthy.push(interfaceName);
    } else {
      interfacesByHealth.unhealthy.push(interfaceName);
    }
  });

  // Sort interfaces alphabetically
  interfacesByHealth.healthy.sort();
  interfacesByHealth.unhealthy.sort();

  // Determine if interfaces should be shown
  const showInterfaces = true;
  // Set max height for the interface list
  const maxListHeight = 150;

  return (
    <div
      className={cn(
        'px-4 py-2 shadow-lg rounded-xl border backdrop-blur-md cursor-pointer transition-all duration-200 hover:shadow-xl hover:scale-105',
        allHealthy 
          ? 'border-green-200/30 bg-green-50/10 hover:bg-green-50/20' 
          : anyHealthy 
            ? 'border-yellow-200/30 bg-yellow-50/10 hover:bg-yellow-50/20' 
            : 'border-red-200/30 bg-red-50/10 hover:bg-red-50/20',
      )}
      style={{ width: data.maxWidth ? `${data.maxWidth}px` : 'auto' }}
      onClick={data.onToggle}
    >
      <Handle type='target' position={Position.Left} className='!bg-muted-foreground' />
      <div className='flex flex-col'>
        <div className='flex items-center gap-2'>
          <div className='relative'>
            <Server className='h-4 w-4' />
            <ChevronRight className='h-3 w-3 absolute -bottom-1 -right-1' />
          </div>
          <div className='flex flex-col'>
            <span className='font-medium whitespace-nowrap overflow-hidden text-ellipsis'>
              {displayService}
            </span>
            <span className='text-xs text-muted-foreground flex items-center gap-1'>
              {showInterfaces ? (
                <ChevronUp className='h-3 w-3' />
              ) : (
                <ChevronDown className='h-3 w-3' />
              )}
              <span>Interfaces</span>
            </span>
          </div>
          <div className='ml-auto flex items-center gap-1'>
            <span className='text-xs font-medium'>
              {healthyCount}/{totalCount}
            </span>
            {allHealthy ? (
              <Check className='h-4 w-4 text-green-500' />
            ) : anyHealthy ? (
              <Check className='h-4 w-4 text-yellow-500' />
            ) : (
              <X className='h-4 w-4 text-red-500' />
            )}
          </div>
        </div>

        {showInterfaces && (
          <div className='mt-2 border-t pt-2 text-xs'>
            <div style={{ maxHeight: maxListHeight, overflowY: 'auto' }} className='pr-1'>
              {interfacesByHealth.healthy.length > 0 && (
                <div>
                  {interfacesByHealth.healthy.map((name, idx) => (
                    <div key={`healthy-${idx}`} className='flex items-center gap-1 py-1'>
                      <Check className='h-3 w-3 text-green-500 flex-shrink-0' />
                      <span className='truncate'>{name}</span>
                    </div>
                  ))}
                </div>
              )}

              {interfacesByHealth.unhealthy.length > 0 && (
                <div>
                  {interfacesByHealth.unhealthy.map((name, idx) => (
                    <div key={`unhealthy-${idx}`} className='flex items-center gap-1 py-1'>
                      <X className='h-3 w-3 text-red-500 flex-shrink-0' />
                      <span className='truncate'>{name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ProviderCountNode({
  data,
}: {
  data: {
    consumer: string;
    count: number;
    onExpand: () => void;
    isHealthy: boolean;
    healthyCount?: number;
    hasMixedHealth?: boolean;
  };
}) {
  return (
    <div
      className={cn(
        'px-4 py-2 shadow-lg rounded-xl border backdrop-blur-md cursor-pointer transition-all duration-200 hover:shadow-xl hover:scale-105',
        data.isHealthy
          ? 'border-green-200/30 bg-green-50/10 hover:bg-green-50/20'
          : data.hasMixedHealth
            ? 'border-orange-200/30 bg-orange-50/10 hover:bg-orange-50/20'
            : 'border-red-200/30 bg-red-50/10 hover:bg-red-50/20',
      )}
      onClick={data.onExpand}
    >
      <Handle type='target' position={Position.Left} className='!bg-muted-foreground' />
      <div className='flex items-center gap-2'>
        <div className='relative'>
          <Server className='h-4 w-4' />
          <ChevronRight className='h-3 w-3 absolute -bottom-1 -right-1' />
        </div>
        <div className='flex flex-col'>
          <span className='font-medium'>
            {data.healthyCount !== undefined ? `${data.healthyCount}/${data.count}` : data.count}{' '}
            {data.count === 1 ? 'Provider' : 'Providers'}
          </span>
          <span className='text-xs text-muted-foreground flex items-center gap-1'>
            <ChevronDown className='h-3 w-3' />
            <span>Expand</span>
          </span>
        </div>
        <div className='ml-auto'>
          {data.isHealthy ? (
            <Check className='h-4 w-4 text-green-500' />
          ) : data.hasMixedHealth ? (
            <MixedHealthIndicator />
          ) : (
            <X className='h-4 w-4 text-red-500' />
          )}
        </div>
      </div>
    </div>
  );
}

const nodeTypes = {
  user: UserNode,
  chain: ChainNode,
  provider: ProviderNode,
  providerGroup: ProviderGroupNode,
  providerCount: ProviderCountNode,
};

function FlowInner({
  apiData,
  isAllExpanded,
}: {
  apiData: any;
  isAllExpanded: boolean;
}): React.ReactElement {
  // Store expansion state in localStorage to persist between re-renders
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const nodesInitialized = useNodesInitialized();
  const renderedNodes = useStore((state: any) => state.nodes);
  const [containerHeight, setContainerHeight] = useState(800);

  // Get previous expansion state from localStorage
  useEffect(() => {
    try {
      const savedState = localStorage.getItem('flowVisualizationExpandedState');
      if (savedState) {
        // When loading from localStorage, don't overwrite with defaults
        setExpandedGroups(JSON.parse(savedState));
      }
    } catch (error) {
      console.error('Failed to load expanded state from localStorage:', error);
    }
  }, []); // Keep this dependency array empty to only run on mount

  // Save expansion state to localStorage whenever it changes
  useEffect(() => {
    try {
      if (Object.keys(expandedGroups).length > 0) {
        localStorage.setItem('flowVisualizationExpandedState', JSON.stringify(expandedGroups));
      }
    } catch (error) {
      console.error('Failed to save expanded state to localStorage:', error);
    }
  }, [expandedGroups]);

  // Update expansion state when isAllExpanded changes
  useEffect(() => {
    if (apiData) {
      const newExpandedState: Record<string, boolean> = {};

      // First collect all possible keys that should be affected
      const consumerKeys: string[] = [];
      const serviceGroupKeys: string[] = [];

      if (apiData?.chains) {
        // Extract keys from new API data using the correct format
        apiData.chains.forEach((chain: ChainInfo) => {
          consumerKeys.push(`chain-${chain.id}`);

          chain.providers.forEach(provider => {
            serviceGroupKeys.push(`service-group-${chain.id}-${provider.name}`);
          });
        });
      } else {
        // For mock data
        const mockData = [
          { consumer: 'ethereum', services: ['lava'] },
          { consumer: 'bitcoin', services: ['quicknodes', 'ankr'] },
          { consumer: 'solana', services: ['lava', 'ankr', 'alchemy'] },
        ];

        mockData.forEach(item => {
          consumerKeys.push(`chain-${item.consumer}`);

          item.services.forEach(service => {
            serviceGroupKeys.push(`service-group-${item.consumer}-${service}`);
          });
        });
      }

      // Set all consumer and service group keys based on isAllExpanded
      [...consumerKeys, ...serviceGroupKeys].forEach(key => {
        newExpandedState[key] = isAllExpanded;
      });

      // Update the state all at once
      setExpandedGroups(prev => ({
        ...prev,
        ...newExpandedState,
      }));
    }
  }, [apiData, isAllExpanded]);

  // Modify the initialization logic to not overwrite existing states
  useEffect(() => {
    if (apiData) {
      const newExpandedState: Record<string, boolean> = {};

      // Check if data follows the new chains-to-providers format
      if (apiData?.chains) {
        // Extract unique consumer names and service providers
        apiData.chains.forEach((chain: ChainInfo) => {
          const chainKey = `chain-${chain.id}`;
          // Always collapse by default
          newExpandedState[chainKey] = false;

          // Set service groups to collapsed by default
          chain.providers.forEach(provider => {
            const serviceKey = `service-group-${chain.id}-${provider.name}`;
            // Always collapse interfaces (service groups) by default
            newExpandedState[serviceKey] = false;
          });
        });
      } else {
        // For mock data
        const mockData = [
          { consumer: 'ethereum', services: ['lava'], count: 1 },
          { consumer: 'bitcoin', services: ['quicknodes', 'ankr'], count: 2 },
          { consumer: 'solana', services: ['lava', 'ankr', 'alchemy'], count: 3 },
        ];

        mockData.forEach(item => {
          const chainKey = `chain-${item.consumer}`;
          // Always collapse by default
          newExpandedState[chainKey] = false;

          // Always collapse service groups by default
          item.services.forEach(service => {
            const serviceKey = `service-group-${item.consumer}-${service}`;
            // Always collapse interfaces (service groups) by default
            newExpandedState[serviceKey] = false;
          });
        });
      }

      // Only update state for keys that don't already exist in expandedGroups
      setExpandedGroups(prev => {
        // Keep all existing expanded states
        const merged = { ...prev };

        // Only add new keys that don't exist in the current state
        Object.entries(newExpandedState).forEach(([key, value]) => {
          if (!(key in merged)) {
            merged[key] = value;
          }
        });

        return merged;
      });
    }
  }, []); // Only run on component mount, not when apiData changes

  // Force re-layout when expanded groups change
  const [key, setKey] = useState(0);

  useEffect(() => {
    // Reset the flow when expanded groups change to recalculate layout
    setKey(prev => prev + 1);
  }, [expandedGroups]);

  // Calculate dynamic node height based on content
  const calculateNodeHeight = (group: ServiceGroup, isExpanded: boolean): number => {
    if (!isExpanded) {
      return 60; // Default height for collapsed node
    }

    // Base height + header + padding
    const baseHeight = 60;

    // Add height for each interface (25px per interface plus additional padding)
    const interfaceCount = group.interfaces ? group.interfaces.size : group.providers.length;
    const interfaceHeight = Math.min(interfaceCount * 30, 150); // Cap at maxListHeight

    return baseHeight + interfaceHeight + 20; // Add extra padding at the bottom
  };

  const { nodes: flowNodes, edges }: { nodes: Node[]; edges: Edge[] } = useMemo(() => {
    // Process the API data to extract chains and providers
    const chains: Chain[] = [];
    const providers: Providers = {};


    // Process the new chains-to-providers API format
    if (apiData && apiData.chains && Array.isArray(apiData.chains) && apiData.chains.length > 0) {
      apiData.chains.forEach((chain: ChainInfo) => {
        // Create chain from chain data using proper labels and icons from chains.ts
        // Handle health states using enums - be explicit about the comparison
        const isHealthy = chain.health_status === "healthy";
        
        chains.push({
          name: chain.id,
          label: getChainLabel(chain.network),
          icon: getChainIcon(chain.network),
          healthy: isHealthy, // Only true when ALL providers are healthy
        });

        // Create providers for this chain
        providers[chain.id] = chain.providers.flatMap(provider => 
          provider.endpoints.map(endpoint => ({
            interface: endpoint.interface,
            healthy: provider.health_status === "healthy",
            service: provider.name,
          }))
        );
      });
    } else {
      // Mock data: 1 user, 3 consumers, 6 providers (1, 2, 3 distribution)
      const mockConsumers = [
        { name: 'ethereum', label: 'Ethereum Mainnet', healthy: true },
        { name: 'bitcoin', label: 'Bitcoin Mainnet', healthy: false },
        { name: 'solana', label: 'Solana Mainnet', healthy: true },
      ];

      mockConsumers.forEach(item => {
        chains.push(item);
      });

      providers['near'] = [
        { interface: 'lava', healthy: true, service: 'lava' },
      ];
      providers['eth1'] = [
        {
          interface: 'quicknodes',
          healthy: true,
          service: 'quicknodes',
        },
        { interface: 'anker', healthy: true, service: 'anker' },
      ];
      providers['btc'] = [
        { interface: 'anker', healthy: false, service: 'anker' },
      ];
      providers['solana'] = [
        { interface: 'lava', healthy: false, service: 'lava' },
        { interface: 'anker', healthy: true, service: 'anker' },
        { interface: 'anker2', healthy: true, service: 'anker' },
      ];
      providers['lava'] = [
        { interface: 'anker', healthy: true, service: 'anker' },
        { interface: 'anker2', healthy: true, service: 'anker' },
        { interface: 'anker3', healthy: true, service: 'anker' },
        { interface: 'anker4', healthy: true, service: 'anker2' },
      ];
    }

    const nodes: Node[] = [];
    const edges: Edge[] = [];

    const sidesPadding = 0;
    const horizontalGap = 400;
    const providerVerticalGap = 180;
    const serviceGroupGap = 100;

    // Sort chains alphabetically by name
    chains.sort((a, b) => a.name.localeCompare(b.name));

    // Calculate the max width needed for chain nodes
    const maxLabelLength = chains.reduce(
      (max, chain) => Math.max(max, chain.label.length),
      0,
    );

    // Base width + character width estimate * longest label + padding
    const baseWidth = 80; // Base width for icons and padding
    const charWidth = 10; // Approximate width of a character
    const chainNodeWidth = baseWidth + maxLabelLength * charWidth;

    // Apply a minimum width constraint
    const finalChainNodeWidth = Math.max(200, chainNodeWidth);

    // Create a map of expanded states for chains and service groups
    const expandedChains = new Set<string>();
    const expandedServiceGroups = new Set<string>();

    Object.entries(expandedGroups).forEach(([key, isExpanded]) => {
      if (isExpanded) {
        if (key.startsWith('chain-')) {
          expandedChains.add(key.replace('chain-', ''));
        } else if (key.startsWith('service-group-')) {
          expandedServiceGroups.add(key.replace('service-group-', ''));
        }
      }
    });

    // Group providers by service for each chain
    const serviceGroupsByChain: Record<string, ServiceGroup[]> = {};

    chains.forEach(chain => {
      const chainProviders = providers[chain.name] || [];
      const serviceGroups: Record<string, Provider[]> = {};
      const serviceInterfaces: Record<string, Set<string>> = {};

      // Group providers by service
      chainProviders.forEach(provider => {
        const service = provider.service || 'unknown';
        if (!serviceGroups[service]) {
          serviceGroups[service] = [];
          serviceInterfaces[service] = new Set<string>();
        }
        serviceGroups[service].push(provider);

        // Track unique interfaces for this service
        const interfaceName = provider.interface;
        serviceInterfaces[service].add(interfaceName);
      });

      // Convert to array of ServiceGroup objects
      serviceGroupsByChain[chain.name] = Object.entries(serviceGroups).map(
        ([service, providers]) => {
          const healthyCount = providers.filter(p => p.healthy).length;
          return {
            service,
            providers,
            allHealthy: healthyCount === providers.length,
            anyHealthy: healthyCount > 0,
            interfaces: serviceInterfaces[service],
          };
        },
      );

      // Sort service groups alphabetically by service name
      serviceGroupsByChain[chain.name].sort((a, b) => a.service.localeCompare(b.service));

      // Also sort providers within each service group by interface
      serviceGroupsByChain[chain.name].forEach(group => {
        // Group providers by their interface
        const interfaceGroups: Record<string, Provider[]> = {};

        group.providers.forEach(provider => {
          const interfaceName = provider.interface;
          if (!interfaceGroups[interfaceName]) {
            interfaceGroups[interfaceName] = [];
          }
          interfaceGroups[interfaceName].push(provider);
        });

        // Update the providers array with a single representative provider per interface
        // Use the healthiest provider as the representative
        group.providers = Object.entries(interfaceGroups)
          .map(([interfaceName, providers]) => {
            // Pick the healthiest provider to represent this interface
            const healthyProviders = providers.filter(p => p.healthy);
            const representative = healthyProviders[0] || providers[0];

            // Aggregate health status (if any provider with this interface is healthy)
            representative.healthy = healthyProviders.length > 0;

            return representative;
          })
          .sort((a, b) => {
            const aInterface = a.interface;
            const bInterface = b.interface;
            return aInterface.localeCompare(bInterface);
          });
      });
    });

    // Calculate total height needed
    let totalHeight = 0;
    const chainSectionHeights: Record<string, number> = {};

    chains.forEach(chain => {
      const serviceGroups = serviceGroupsByChain[chain.name];
      const isExpanded = expandedChains.has(chain.name);

      let chainHeight = 0;
      if (isExpanded) {
        // If chain is expanded, calculate height for all service groups
        serviceGroups.forEach(group => {
          const isServiceExpanded = expandedServiceGroups.has(`${chain.name}-${group.service}`);
          // Calculate height based on whether service is expanded and how many interfaces it has
          const nodeHeight = calculateNodeHeight(group, isServiceExpanded);
          chainHeight += nodeHeight + 60; // Increased padding between nodes
        });
      } else {
        // Just one row for the collapsed chain
        chainHeight = providerVerticalGap;
      }

      chainSectionHeights[chain.name] = chainHeight;
      totalHeight += chainHeight;
    });

    // Add some vertical padding
    totalHeight = Math.max(totalHeight, 300);

    // Calculate Y positions
    let currentY = 50;
    const chainYPositions: Record<string, number> = {};
    const serviceGroupYPositions: Record<string, Record<string, number>> = {};

    chains.forEach(chain => {
      const serviceGroups = serviceGroupsByChain[chain.name];
      const isChainExpanded = expandedChains.has(chain.name);
      const sectionHeight = chainSectionHeights[chain.name];

      // Position chain in the middle of its section
      chainYPositions[chain.name] = currentY + sectionHeight / 2;

      // Initialize positions for this chain
      serviceGroupYPositions[chain.name] = {};

      if (isChainExpanded) {
        // Position service groups with variable heights
        let serviceY = currentY;

        serviceGroups.forEach(group => {
          // Store initial y position for this service group
          serviceGroupYPositions[chain.name][group.service] = serviceY;

          // Calculate height for this service group
          const isServiceExpanded = expandedServiceGroups.has(`${chain.name}-${group.service}`);
          const nodeHeight = calculateNodeHeight(group, isServiceExpanded);

          // Move to next position with appropriate spacing
          serviceY += nodeHeight + 60; // Increased padding between nodes
        });
      }

      // Move to next chain section
      currentY += sectionHeight;
    });

    // Create nodes and edges
    const userY = totalHeight / 2;

    // Add user node
    nodes.push({
      id: 'user',
      type: 'user',
      position: { x: sidesPadding, y: userY },
      data: {},
    });

    // Add chain and provider nodes
    chains.forEach(chain => {
      const chainId = `chain-${chain.name}`;
      const chainX = sidesPadding + horizontalGap;
      const chainY = chainYPositions[chain.name];
      const isChainExpanded = expandedChains.has(chain.name);
      const serviceGroups = serviceGroupsByChain[chain.name];
      const hasMultipleProviders =
        serviceGroups.reduce((total, group) => total + group.providers.length, 0) > 2;

      // Use calculated width for chain nodes
      const chainWidth = finalChainNodeWidth;

      // Get the original chain data to check for mixed health state
      const originalChain = apiData?.chains?.find((chainInfo: ChainInfo) => chainInfo.id === chain.name);
      const backendMixedHealth = originalChain?.health_status === "mixed";
      
      // Add chain node
      nodes.push({
        id: chainId,
        type: 'chain',
        position: { x: chainX, y: chainY },
        data: {
          label: chain.label,
          chainName: chain.name,
          icon: chain.icon,
          healthy: chain.healthy,
          hasExpandedProviders: isChainExpanded,
          hasMultipleProviders: hasMultipleProviders,
          hasMixedHealth: backendMixedHealth,
          width: chainWidth,
          onToggleExpand: hasMultipleProviders
            ? () => {
                setExpandedGroups(prev => {
                  const newState = { ...prev };
                  const chainKey = `chain-${chain.name}`;
                  newState[chainKey] = !prev[chainKey];
                  return newState;
                });
              }
            : undefined,
        },
      });

      // Connect user to chain
      edges.push({
        id: `edge-user-${chainId}`,
        source: 'user',
        target: chainId,
        animated: chain.healthy || backendMixedHealth || serviceGroups.some(group => group.anyHealthy),
        style:
          chain.healthy && !backendMixedHealth && serviceGroups.every(group => group.allHealthy)
            ? {
                stroke: 'green',
                strokeDasharray: '5 5',
                animation: 'dashdraw 0.5s linear infinite',
              }
            : backendMixedHealth || serviceGroups.some(group => group.anyHealthy)
              ? {
                  stroke: 'orange',
                  strokeDasharray: '5 5',
                  animation: 'dashdraw 0.5s linear infinite',
                }
              : { stroke: 'red' },
      });

      if (isChainExpanded) {
        // If chain is expanded, add service groups
        const serviceGroups = serviceGroupsByChain[chain.name];
        const serviceX = chainX + horizontalGap;

        serviceGroups.forEach(group => {
          const serviceId = `service-group-${chain.name}-${group.service}`;
          const serviceY = serviceGroupYPositions[chain.name][group.service];
          const isServiceExpanded = expandedServiceGroups.has(`${chain.name}-${group.service}`);

          // Add service group node
          nodes.push({
            id: serviceId,
            type: 'providerGroup',
            position: { x: serviceX, y: serviceY },
            data: {
              label: chain.name,
              service: group.service,
              providers: group.providers,
              interfaces: group.interfaces,
              isExpanded: isServiceExpanded,
              maxWidth: finalChainNodeWidth,
              onToggle: () => {
                setExpandedGroups(prev => {
                  const newState = { ...prev };
                  const serviceKey = `service-group-${chain.name}-${group.service}`;
                  newState[serviceKey] = !prev[serviceKey];
                  return newState;
                });
              },
            },
          });

          // Connect chain to service group
          edges.push({
            id: `edge-${chainId}-${serviceId}`,
            source: chainId,
            target: serviceId,
            type: 'straight',
            animated: group.anyHealthy,
            style: group.allHealthy
              ? {
                  stroke: 'green',
                  strokeDasharray: '5 5',
                  animation: 'dashdraw 0.5s linear infinite',
                }
              : group.anyHealthy
                ? {
                    stroke: 'orange',
                    strokeDasharray: '5 5',
                    animation: 'dashdraw 0.5s linear infinite',
                  }
                : { stroke: 'red' },
          });
        });
      } else {
        // If chain is collapsed, always show a provider count node regardless of count
        const providerCountNodeId = `provider-count-${chain.name}`;
        const providerCountX = chainX + horizontalGap;
        const providerCountY = chainY;

        // Calculate total provider count and healthy count
        const totalProviders = serviceGroups.reduce(
          (total, group) => total + group.interfaces.size,
          0,
        );
        const healthyProviders = serviceGroups.reduce(
          (total, group) => total + group.providers.filter(p => p.healthy).length,
          0,
        );

        // Calculate if any providers are unhealthy
        const anyUnhealthy = serviceGroups.some(group =>
          group.providers.some(provider => !provider.healthy),
        );

        // Add provider count node
        nodes.push({
          id: providerCountNodeId,
          type: 'providerCount',
          position: { x: providerCountX, y: providerCountY },
          data: {
            chain: chain.name,
            count: totalProviders,
            healthyCount: healthyProviders,
            isHealthy: !anyUnhealthy && !backendMixedHealth,
            hasMixedHealth: backendMixedHealth || (healthyProviders > 0 && healthyProviders < totalProviders),
            onExpand: () => {
              setExpandedGroups(prev => {
                const newState = { ...prev };
                const chainKey = `chain-${chain.name}`;
                newState[chainKey] = true;
                return newState;
              });
            },
          },
        });

        // Connect chain to provider count node
        edges.push({
          id: `edge-${chainId}-${providerCountNodeId}`,
          source: chainId,
          target: providerCountNodeId,
          type: 'straight',
          animated:
            !anyUnhealthy || backendMixedHealth || (anyUnhealthy && serviceGroups.some(group => group.anyHealthy)),
          style: !anyUnhealthy && !backendMixedHealth
            ? {
                stroke: 'green',
                strokeDasharray: '5 5',
                animation: 'dashdraw 0.5s linear infinite',
              }
            : backendMixedHealth || serviceGroups.some(group => group.anyHealthy)
              ? {
                  stroke: 'orange',
                  strokeDasharray: '5 5',
                  animation: 'dashdraw 0.5s linear infinite',
                }
              : { stroke: 'red' },
        });
      }
    });

    return { nodes, edges };
  }, [expandedGroups, apiData, setExpandedGroups]);

  // Adjust containerHeight dynamically based on expanded nodes
  useEffect(() => {
    if (nodesInitialized && renderedNodes && renderedNodes.length > 0) {
      const bounds = getRectOfNodes(renderedNodes);
      const verticalPadding = 40;
      const totalHeight = Math.max(600, bounds.height + verticalPadding * 2);
      setContainerHeight(totalHeight);
    }
  }, [nodesInitialized, renderedNodes, expandedGroups]);

  return (
    <div className='w-full overflow-hidden' style={{ height: containerHeight }}>
      <ReactFlow
        key={key}
        nodes={flowNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        className='bg-transparent'
        defaultViewport={{ x: -20, y: 0, zoom: 1 }}
        defaultEdgeOptions={{
          type: 'straight',
          style: { strokeWidth: 2 },
        }}
        fitView
        panOnDrag={true}
        preventScrolling={false}
        zoomOnScroll={true}
        panOnScroll={false}
        zoomOnPinch={true}
        minZoom={0.3}
        maxZoom={2}
        onNodeClick={(event, node) => {
          // TODO: Implement node click handler for future API integration
          console.log('Node clicked:', node);
        }}
        onEdgeClick={(event, edge) => {
          // TODO: Implement edge click handler for future API integration
          console.log('Edge clicked:', edge);
        }}
      >
        <Controls 
          position="bottom-right"
          showZoom={true}
          showFitView={true}
          showInteractive={false}
        />
      </ReactFlow>

      <style>{`
        @keyframes dashdraw {
          0% {
            stroke-dashoffset: 10;
          }
          100% {
            stroke-dashoffset: 0;
          }
        }
        
        /* Glassmorphism effects */
        .react-flow__node {
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
        }
        
        .react-flow__node:hover {
          transform: translateY(-2px);
          box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
        }
        
        /* Edge hover effects with glassmorphism */
        .react-flow__edge:hover .react-flow__edge-path {
          stroke-width: 3 !important;
          filter: drop-shadow(0 0 8px rgba(0, 0, 0, 0.15));
        }
        
        /* Subtle glow for animated edges */
        .react-flow__edge.animated .react-flow__edge-path {
          filter: drop-shadow(0 0 4px rgba(34, 197, 94, 0.3));
        }
        
        /* Controls glassmorphism */
        .react-flow__controls {
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          background: rgba(255, 255, 255, 0.1) !important;
          border: 1px solid rgba(255, 255, 255, 0.2) !important;
        }
        
        .react-flow__controls-button {
          background: rgba(255, 255, 255, 0.1) !important;
          border: 1px solid rgba(255, 255, 255, 0.2) !important;
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
        }
        
        .react-flow__controls-button:hover {
          background: rgba(255, 255, 255, 0.2) !important;
        }
        
        /* Hide React Flow attribution */
        .react-flow__attribution {
          display: none !important;
        }
      `}</style>
    </div>
  );
}

export function FlowVisualization({ data, isAllExpanded = false }: FlowVisualizationProps) {
  const isUsingMockData = !data || !data.chains || data.chains.length === 0;
  
  return (
    <div className='space-y-4 w-full'>
      {isUsingMockData && (
        <div className='bg-blue-50/10 border border-blue-200/30 rounded-lg p-3 mb-4'>
          <div className='flex items-center gap-2 text-blue-600'>
            <div className='w-2 h-2 bg-blue-500 rounded-full'></div>
            <span className='text-sm font-medium'>Demo Mode</span>
          </div>
          <p className='text-xs text-blue-500/80 mt-1'>
            Showing mock data for UI/UX testing. Connect to API to see real metrics.
          </p>
        </div>
      )}
      <ReactFlowProvider>
        <FlowInner apiData={data} isAllExpanded={isAllExpanded} />
      </ReactFlowProvider>
    </div>
  );
}
