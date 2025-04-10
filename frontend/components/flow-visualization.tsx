"use client"

import { useEffect, useMemo, useState } from "react"
import { Check, Network, Server, User, X, ChevronDown, ChevronRight, ChevronUp } from "lucide-react"
import { cn } from "@/lib/utils"
import ReactFlow, {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlowProvider,
  Edge,
  Node,
  useReactFlow,
  useNodesInitialized,
  useStore,
  getRectOfNodes,
} from "reactflow"
import type { NodeChange, NodePositionChange } from "reactflow"
import "reactflow/dist/style.css"
import React from "react"

interface FlowVisualizationProps {
  data: any
}

// Types for the flow visualization
interface Consumer {
  name: string
  healthy: boolean
}

interface Provider {
  interface: string
  healthy: boolean
  service?: string
  apiInterface?: string
}

interface Providers {
  [key: string]: Provider[]
}

interface ServiceGroup {
  service: string
  providers: Provider[]
  allHealthy: boolean
  anyHealthy: boolean
  interfaces: Set<string> // Track unique interfaces in this service
}

function UserNode({ data }: { data: any }) {
  return (
    <div className="px-4 py-2 shadow-lg rounded-lg border bg-background min-w-44">
      <div className="flex items-center gap-2">
        <User className="h-4 w-4" />
        <div className="font-medium">User</div>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-muted-foreground" />
    </div>
  )
}

function ConsumerNode({ data }: { data: { label: string; healthy: boolean; hasExpandedProviders?: boolean; onToggleExpand?: () => void; hasMultipleProviders?: boolean } }) {
  return (
    <div
      className={cn(
        "px-4 py-2 shadow-lg rounded-lg border bg-background min-w-44",
        data.healthy ? "border-green-200" : "border-red-200"
      )}
    >
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground" />
      <div className="flex items-center gap-2">
        <Network className="h-4 w-4" />
        <div className="flex flex-col">
          <span className="font-medium">{data.label}</span>
          <span className="text-xs text-muted-foreground">Consumer</span>
        </div>
        <div className="flex items-center ml-auto">
          {data.hasMultipleProviders && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (data.onToggleExpand) data.onToggleExpand();
              }}
              className="mr-2 p-1 hover:bg-muted rounded"
              title={data.hasExpandedProviders ? "Collapse providers" : "Expand providers"}
            >
              {data.hasExpandedProviders ? (
                <ChevronUp className="h-4 w-4 text-gray-500" />
              ) : (
                <ChevronDown className="h-4 w-4 text-gray-500" />
              )}
            </button>
          )}
        {data.healthy ? (
            <Check className="h-4 w-4 text-green-500" />
        ) : (
            <X className="h-4 w-4 text-red-500" />
        )}
        </div>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-muted-foreground" />
    </div>
  )
}

function ProviderNode({ data }: { data: { label: string; interface: string; apiInterface?: string; healthy: boolean; isCollapseButton?: boolean; onCollapse?: () => void; service?: string } }) {
  return (
    <div
      className={cn(
        "px-4 py-2 shadow-lg rounded-lg border bg-background min-w-44",
        data.isCollapseButton ? "border-gray-200 cursor-pointer" : (data.healthy ? "border-green-200" : "border-red-200")
      )}
      onClick={data.isCollapseButton ? data.onCollapse : undefined}
    >
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground" />
      <div className="flex items-center gap-2">
        <Server className="h-4 w-4" />
        <div className="flex flex-col">
          <span className="font-medium">{data.isCollapseButton ? data.label : (data.service || data.interface)}</span>
          <span className="text-xs text-muted-foreground">
            {data.isCollapseButton ? (
              <div className="flex items-center gap-1">
                <ChevronUp className="h-3 w-3" />
                <span>Collapse</span>
              </div>
            ) : (
              data.apiInterface || data.interface
            )}
          </span>
        </div>
        {data.isCollapseButton ? (
          <ChevronUp className="h-4 w-4 text-gray-500 ml-auto" />
        ) : (
          data.healthy ? (
          <Check className="h-4 w-4 text-green-500 ml-auto" />
        ) : (
          <X className="h-4 w-4 text-red-500 ml-auto" />
          )
        )}
      </div>
    </div>
  )
}

function ProviderGroupNode({ data }: { data: { label: string; providers: Provider[]; isExpanded: boolean; onToggle: () => void; service?: string; interfaces?: Set<string>; maxWidth?: number } }) {
  const healthyCount = data.providers.filter(p => p.healthy).length
  const totalCount = data.providers.length
  const interfaceCount = data.interfaces ? data.interfaces.size : totalCount
  const allHealthy = healthyCount === totalCount
  const anyHealthy = healthyCount > 0

  // Clean up service name by removing "-provider" substring
  const displayService = (data.service || data.label || "").replace(/-provider/g, "")

  // Group interfaces by health status
  const interfacesByHealth: { healthy: string[]; unhealthy: string[] } = { 
    healthy: [], 
    unhealthy: [] 
  }
  
  data.providers.forEach(provider => {
    const interfaceName = provider.apiInterface || provider.interface
    if (provider.healthy) {
      interfacesByHealth.healthy.push(interfaceName)
    } else {
      interfacesByHealth.unhealthy.push(interfaceName)
    }
  })
  
  // Sort interfaces alphabetically
  interfacesByHealth.healthy.sort()
  interfacesByHealth.unhealthy.sort()
  
  // Determine if interfaces should be shown
  const showInterfaces = data.isExpanded
  // Set max height for the interface list
  const maxListHeight = 150

  return (
    <div
      className={cn(
        "px-4 py-2 shadow-lg rounded-lg border bg-background cursor-pointer",
        allHealthy ? "border-green-200" : anyHealthy ? "border-yellow-200" : "border-red-200"
      )}
      style={{ width: data.maxWidth ? `${data.maxWidth}px` : 'auto' }}
      onClick={data.onToggle}
    >
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground" />
      <div className="flex flex-col">
        <div className="flex items-center gap-2">
          <div className="relative">
            <Server className="h-4 w-4" />
            <ChevronRight className="h-3 w-3 absolute -bottom-1 -right-1" />
          </div>
          <div className="flex flex-col">
            <span className="font-medium whitespace-nowrap overflow-hidden text-ellipsis">{displayService}</span>
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              {showInterfaces ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
              <span>Provider {interfaceCount > 1 ? `(${interfaceCount} interfaces)` : ""}</span>
            </span>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <span className="text-xs font-medium">
              {healthyCount}/{totalCount}
            </span>
            {allHealthy ? (
              <Check className="h-4 w-4 text-green-500" />
            ) : anyHealthy ? (
              <Check className="h-4 w-4 text-yellow-500" />
            ) : (
              <X className="h-4 w-4 text-red-500" />
            )}
          </div>
        </div>
        
        {showInterfaces && (
          <div className="mt-2 border-t pt-2 text-xs">
            <div style={{ maxHeight: maxListHeight, overflowY: 'auto' }} className="pr-1">
              {interfacesByHealth.healthy.length > 0 && (
                <div>
                  {interfacesByHealth.healthy.map((name, idx) => (
                    <div key={`healthy-${idx}`} className="flex items-center gap-1 py-1">
                      <Check className="h-3 w-3 text-green-500 flex-shrink-0" />
                      <span className="truncate">{name}</span>
                    </div>
                  ))}
                </div>
              )}
              
              {interfacesByHealth.unhealthy.length > 0 && (
                <div>
                  {interfacesByHealth.unhealthy.map((name, idx) => (
                    <div key={`unhealthy-${idx}`} className="flex items-center gap-1 py-1">
                      <X className="h-3 w-3 text-red-500 flex-shrink-0" />
                      <span className="truncate">{name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// Update the ProviderCountNode to remove "-provider" from titles
function ProviderCountNode({ data }: { data: { consumer: string; count: number; onExpand: () => void; isHealthy: boolean } }) {
  // Clean up consumer name by removing "-provider" substring
  const displayConsumer = data.consumer.replace(/-provider/g, "")

  return (
    <div
      className={cn(
        "px-4 py-2 shadow-lg rounded-lg border bg-background cursor-pointer",
        data.isHealthy ? "border-green-200" : "border-red-200"
      )}
      onClick={data.onExpand}
    >
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground" />
      <div className="flex items-center gap-2">
        <div className="relative">
          <Server className="h-4 w-4" />
          <ChevronRight className="h-3 w-3 absolute -bottom-1 -right-1" />
        </div>
        <div className="flex flex-col">
          <span className="font-medium">{displayConsumer}</span>
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            <ChevronDown className="h-3 w-3" />
            <span>{data.count} {data.count === 1 ? "Provider" : "Providers"}</span>
          </span>
        </div>
        <div className="ml-auto">
          {data.isHealthy ? (
            <Check className="h-4 w-4 text-green-500" />
          ) : (
            <X className="h-4 w-4 text-red-500" />
          )}
        </div>
      </div>
    </div>
  )
}

const nodeTypes = {
  user: UserNode,
  consumer: ConsumerNode,
  provider: ProviderNode,
  providerGroup: ProviderGroupNode,
  providerCount: ProviderCountNode,
}

function FlowInner({ apiData, isAllExpanded }: { apiData: any; isAllExpanded: boolean }): React.ReactElement {
  // Store expansion state in localStorage to persist between re-renders
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({})
  const nodesInitialized = useNodesInitialized()
  const renderedNodes = useStore((state: any) => state.nodes)
  const [containerHeight, setContainerHeight] = useState(800)
  
  // Get previous expansion state from localStorage
  useEffect(() => {
    try {
      const savedState = localStorage.getItem('flowVisualizationExpandedState')
      if (savedState) {
        // When loading from localStorage, don't overwrite with defaults
        setExpandedGroups(JSON.parse(savedState))
      }
    } catch (error) {
      console.error('Failed to load expanded state from localStorage:', error)
    }
  }, []) // Keep this dependency array empty to only run on mount
  
  // Save expansion state to localStorage whenever it changes
  useEffect(() => {
    try {
      if (Object.keys(expandedGroups).length > 0) {
        localStorage.setItem('flowVisualizationExpandedState', JSON.stringify(expandedGroups))
      }
    } catch (error) {
      console.error('Failed to save expanded state to localStorage:', error)
    }
  }, [expandedGroups])
  
  // Update expansion state when isAllExpanded changes
  useEffect(() => {
    if (apiData) {
      const newExpandedState: Record<string, boolean> = {}
      
      // First collect all possible keys that should be affected
      const consumerKeys: string[] = []
      const serviceGroupKeys: string[] = []
      
      if (apiData?.status === 'success' && apiData.data?.result) {
        // Extract keys from API data
        const uniqueSpecs = new Set<string>()
        const servicesBySpec: Record<string, Set<string>> = {}
        
        apiData.data.result.forEach((result: any) => {
          if (result.metric?.spec) {
            const spec = result.metric.spec
            uniqueSpecs.add(spec)
            
            if (!servicesBySpec[spec]) {
              servicesBySpec[spec] = new Set<string>()
            }
            
            const service = result.metric?.service || result.metric?.job || "unknown"
            servicesBySpec[spec].add(service)
          }
        })
        
        // Create keys for all consumers and service groups
        uniqueSpecs.forEach(spec => {
          consumerKeys.push(`consumer-${spec}`)
          
          if (servicesBySpec[spec]) {
            servicesBySpec[spec].forEach(service => {
              serviceGroupKeys.push(`service-group-${spec}-${service}`)
            })
          }
        })
      } else {
        // For sample data
        const sampleData = [
          { consumer: 'NEAR', services: ['lava'] },
          { consumer: 'ETH', services: ['quicknodes', 'anker'] },
          { consumer: 'BTC', services: ['anker'] },
          { consumer: 'SOL', services: ['lava', 'anker'] },
          { consumer: 'LAVA', services: ['anker', 'anker2'] }
        ]
        
        sampleData.forEach(item => {
          consumerKeys.push(`consumer-${item.consumer}`)
          
          item.services.forEach(service => {
            serviceGroupKeys.push(`service-group-${item.consumer}-${service}`)
          })
        })
      }
      
      // Set all consumer and service group keys based on isAllExpanded
      [...consumerKeys, ...serviceGroupKeys].forEach(key => {
        newExpandedState[key] = isAllExpanded
      })
      
      // Update the state all at once
      setExpandedGroups(prev => ({
        ...prev,
        ...newExpandedState
      }))
    }
  }, [apiData, isAllExpanded])
  
  // Modify the initialization logic to not overwrite existing states
  useEffect(() => {
    if (apiData) {
      const newExpandedState: Record<string, boolean> = {}
      
      // Check if data follows the expected Prometheus format
      if (apiData?.status === 'success' && apiData.data?.result) {
        // Extract unique consumer names and service providers
        const uniqueSpecs = new Set<string>()
        const servicesBySpec: Record<string, Set<string>> = {}
        const providerCountBySpec: Record<string, number> = {}
        
        apiData.data.result.forEach((result: any) => {
          if (result.metric?.spec) {
            const spec = result.metric.spec
            uniqueSpecs.add(spec)
            
            // Track services for this spec
            if (!servicesBySpec[spec]) {
              servicesBySpec[spec] = new Set<string>()
              providerCountBySpec[spec] = 0
            }
            
            const service = result.metric?.service || result.metric?.job || "unknown"
            servicesBySpec[spec].add(service)
            providerCountBySpec[spec]++
          }
        })
        
        // Set default states for new consumers and service groups
        uniqueSpecs.forEach((spec: string) => {
          const consumerKey = `consumer-${spec}`
          // Always collapse by default
          newExpandedState[consumerKey] = false
          
          // Set service groups to expanded by default (for when consumer is expanded)
          if (servicesBySpec[spec]) {
            servicesBySpec[spec].forEach(service => {
              const serviceKey = `service-group-${spec}-${service}`
              // Always expand interfaces (service groups) by default
              newExpandedState[serviceKey] = true
            })
          }
        })
      } else {
        // For sample data
        const sampleData = [
          { consumer: 'NEAR', services: ['lava'], count: 1 },
          { consumer: 'ETH', services: ['quicknodes', 'anker'], count: 2 },
          { consumer: 'BTC', services: ['anker'], count: 1 },
          { consumer: 'SOL', services: ['lava', 'anker'], count: 3 },
          { consumer: 'LAVA', services: ['anker', 'anker2'], count: 4 }
        ]
        
        sampleData.forEach(item => {
          const consumerKey = `consumer-${item.consumer}`
          // Always collapse by default
          newExpandedState[consumerKey] = false
          
          // Always expand service groups by default (for when consumer is expanded)
          item.services.forEach(service => {
            const serviceKey = `service-group-${item.consumer}-${service}`
            // Always expand interfaces (service groups) by default
            newExpandedState[serviceKey] = true
          })
        })
      }
      
      // Only update state for keys that don't already exist in expandedGroups
      setExpandedGroups(prev => {
        // Keep all existing expanded states
        const merged = { ...prev }
        
        // Only add new keys that don't exist in the current state
        Object.entries(newExpandedState).forEach(([key, value]) => {
          if (!(key in merged)) {
            merged[key] = value
          }
        })
        
        return merged
      })
    }
  }, []) // Only run on component mount, not when apiData changes
  
  // Force re-layout when expanded groups change
  const [key, setKey] = useState(0)
  
  useEffect(() => {
    // Reset the flow when expanded groups change to recalculate layout
    setKey(prev => prev + 1)
  }, [expandedGroups])

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
    // Process the API data to extract consumers and providers
    const consumers: Consumer[] = []
    const providers: Providers = {}
    
    // Detect if we have Prometheus API response format
    if (apiData && apiData.status === 'success' && apiData.data?.result) {
      const results = apiData.data.result
      
      // First pass: Identify unique consumers (specs)
      const uniqueSpecs = new Set<string>()
      results.forEach((result: any) => {
        if (result.metric?.spec) {
          uniqueSpecs.add(result.metric.spec)
        }
      })
      
      // Create consumers and empty provider arrays
      uniqueSpecs.forEach((spec: string) => {
        consumers.push({ name: spec, healthy: true })
        providers[spec] = []
      })
      
      // Second pass: Map providers to consumers
      results.forEach((result: any) => {
        const spec = result.metric?.spec
        if (!spec) return
        
        // Determine if provider is healthy based on latest value
        const values = result.values || []
        const lastValue = values.length > 0 ? values[values.length - 1][1] : "0"
        const isHealthy = lastValue === "1"
        
        // Get unique identifier for this provider
        const apiInterface = result.metric?.apiInterface || "unknown"
        const service = result.metric?.service || result.metric?.job || "unknown"
        const instance = result.metric?.instance || ""
        
        // Create a unique provider interface name with service as the main identifier
        const interfaceName = `${service}:${apiInterface}${instance ? `:${instance.split(':')[0]}` : ''}`
        
        // Add to providers, avoiding duplicates
        const existingProviderIndex = providers[spec].findIndex(
          p => p.interface === interfaceName
        )
        
        if (existingProviderIndex === -1) {
          providers[spec].push({
            interface: interfaceName,
            apiInterface: apiInterface,
            healthy: isHealthy,
            service: service
          })
        } else {
          // Update existing provider if it exists
          providers[spec][existingProviderIndex].healthy = isHealthy
        }
        
        // Update consumer health based on provider health
        if (!isHealthy) {
          const consumerIndex = consumers.findIndex(c => c.name === spec)
          if (consumerIndex !== -1) {
            consumers[consumerIndex].healthy = false
          }
        }
      })
    } else {
      // Fallback to sample data if API format is not recognized
      consumers.push(
      { name: "NEAR", healthy: true },
      { name: "ETH", healthy: true },
      { name: "BTC", healthy: false },
      { name: "SOL", healthy: true },
        { name: "LAVA", healthy: true }
      )

      providers['NEAR'] = [{ interface: "lava", apiInterface: "lava", healthy: true, service: "lava" }]
      providers['ETH'] = [
        { interface: "quicknodes", apiInterface: "quicknodes", healthy: true, service: "quicknodes" },
        { interface: "anker", apiInterface: "anker", healthy: true, service: "anker" },        
      ]
      providers['BTC'] = [{ interface: "anker", apiInterface: "anker", healthy: false, service: "anker" }]
      providers['SOL'] = [
        { interface: "lava", apiInterface: "lava", healthy: false, service: "lava" },
        { interface: "anker", apiInterface: "anker", healthy: true, service: "anker" },
        { interface: "anker2", apiInterface: "anker2", healthy: true, service: "anker" },
      ]
      providers['LAVA'] = [
        { interface: "anker", apiInterface: "anker", healthy: true, service: "anker" }, 
        { interface: "anker2", apiInterface: "anker2", healthy: true, service: "anker" }, 
        { interface: "anker3", apiInterface: "anker3", healthy: true, service: "anker" },
        { interface: "anker4", apiInterface: "anker4", healthy: true, service: "anker2" }
      ]
    }

    const nodes: Node[] = []
    const edges: Edge[] = []

    const sidesPadding = 40
    const horizontalGap = 250
    const providerVerticalGap = 180 // Increased vertical gap for better spacing
    const serviceGroupGap = 100 // Gap between service groups
    
    // Create a map of expanded states for consumers and service groups
    const expandedConsumers = new Set<string>()
    const expandedServiceGroups = new Set<string>()
    
    Object.entries(expandedGroups).forEach(([key, isExpanded]) => {
      if (isExpanded) {
        if (key.startsWith('consumer-')) {
          expandedConsumers.add(key.replace('consumer-', ''))
        } else if (key.startsWith('service-group-')) {
          expandedServiceGroups.add(key.replace('service-group-', ''))
        }
      }
    })
    
    // Group providers by service for each consumer
    const serviceGroupsByConsumer: Record<string, ServiceGroup[]> = {}
    
    consumers.forEach(consumer => {
      const consumerProviders = providers[consumer.name] || []
      const serviceGroups: Record<string, Provider[]> = {}
      const serviceInterfaces: Record<string, Set<string>> = {}
      
      // Group providers by service
      consumerProviders.forEach(provider => {
        const service = provider.service || 'unknown'
        if (!serviceGroups[service]) {
          serviceGroups[service] = []
          serviceInterfaces[service] = new Set<string>()
        }
        serviceGroups[service].push(provider)
        
        // Track unique interfaces for this service
        const apiInterface = provider.apiInterface || provider.interface
        serviceInterfaces[service].add(apiInterface)
      })
      
      // Convert to array of ServiceGroup objects
      serviceGroupsByConsumer[consumer.name] = Object.entries(serviceGroups).map(([service, providers]) => {
        const healthyCount = providers.filter(p => p.healthy).length
        return {
          service,
          providers,
          allHealthy: healthyCount === providers.length,
          anyHealthy: healthyCount > 0,
          interfaces: serviceInterfaces[service]
        }
      })
      
      // Sort service groups alphabetically by service name
      serviceGroupsByConsumer[consumer.name].sort((a, b) => a.service.localeCompare(b.service))
      
      // Also sort providers within each service group by apiInterface
      serviceGroupsByConsumer[consumer.name].forEach(group => {
        // Group providers by their apiInterface
        const interfaceGroups: Record<string, Provider[]> = {}
        
        group.providers.forEach(provider => {
          const apiInterface = provider.apiInterface || provider.interface
          if (!interfaceGroups[apiInterface]) {
            interfaceGroups[apiInterface] = []
          }
          interfaceGroups[apiInterface].push(provider)
        })
        
        // Update the providers array with a single representative provider per apiInterface
        // Use the healthiest provider as the representative
        group.providers = Object.entries(interfaceGroups).map(([apiInterface, providers]) => {
          // Choose the healthiest provider as representative
          const healthyProviders = providers.filter(p => p.healthy)
          const representative = healthyProviders.length > 0 ? 
            healthyProviders[0] : providers[0]
          
          // Aggregate health status (if any provider with this interface is healthy)
          representative.healthy = healthyProviders.length > 0
          
          return representative
        }).sort((a, b) => {
          const aInterface = a.apiInterface || a.interface
          const bInterface = b.apiInterface || b.interface
          return aInterface.localeCompare(bInterface)
        })
      })
    })
    
    // Calculate the max width needed for provider nodes
    // First, get all unique service names and interface names
    const allServiceNames = new Set<string>()
    const allInterfaceNames = new Set<string>()
    
    consumers.forEach(consumer => {
      const consumerProviders = providers[consumer.name] || []
      consumerProviders.forEach(provider => {
        allServiceNames.add(provider.service || '')
        allInterfaceNames.add(provider.apiInterface || provider.interface)
      })
    })
    
    // Estimate the width based on the longest service and interface names
    const maxServiceNameLength = Array.from(allServiceNames).reduce((max, name) => 
      name.length > max ? name.length : max, 0)
    const maxInterfaceNameLength = Array.from(allInterfaceNames).reduce((max, name) => 
      name.length > max ? name.length : max, 0)
    
    // Calculate approximate width in pixels (this is an estimation)
    // Base width + character width estimate * longest name + padding
    const baseWidth = 60 // Base width for icons and padding
    const charWidth = 8 // Approximate width of a character
    const maxLabelWidth = Math.max(maxServiceNameLength, maxInterfaceNameLength)
    const providerNodeWidth = baseWidth + (maxLabelWidth * charWidth)
    
    // Apply a minimum width constraint
    const finalProviderNodeWidth = Math.max(180, providerNodeWidth)

    // Calculate total height needed
    let totalHeight = 0
    const consumerSectionHeights: Record<string, number> = {}
    
    consumers.forEach(consumer => {
      const serviceGroups = serviceGroupsByConsumer[consumer.name]
      const isExpanded = expandedConsumers.has(consumer.name)
      
      let consumerHeight = 0
      if (isExpanded) {
        // If consumer is expanded, calculate height for all service groups
        serviceGroups.forEach(group => {
          const isServiceExpanded = expandedServiceGroups.has(`${consumer.name}-${group.service}`)
          // Calculate height based on whether service is expanded and how many interfaces it has
          const nodeHeight = calculateNodeHeight(group, isServiceExpanded);
          consumerHeight += nodeHeight + 60; // Increased padding between nodes
        })
      } else {
        // Just one row for the collapsed consumer
        consumerHeight = providerVerticalGap
      }
      
      consumerSectionHeights[consumer.name] = consumerHeight
      totalHeight += consumerHeight
    })
    
    // Add some vertical padding
    totalHeight = Math.max(totalHeight, 300)
    
    // Calculate Y positions
    let currentY = 50
    const consumerYPositions: Record<string, number> = {}
    const serviceGroupYPositions: Record<string, Record<string, number>> = {}
    
    consumers.forEach(consumer => {
      const serviceGroups = serviceGroupsByConsumer[consumer.name]
      const isConsumerExpanded = expandedConsumers.has(consumer.name)
      const sectionHeight = consumerSectionHeights[consumer.name]
      
      // Position consumer in the middle of its section
      consumerYPositions[consumer.name] = currentY + sectionHeight / 2
      
      // Initialize positions for this consumer
      serviceGroupYPositions[consumer.name] = {}
      
      if (isConsumerExpanded) {
        // Position service groups with variable heights
        let serviceY = currentY
        
        serviceGroups.forEach(group => {
          // Store initial y position for this service group
          serviceGroupYPositions[consumer.name][group.service] = serviceY
          
          // Calculate height for this service group
          const isServiceExpanded = expandedServiceGroups.has(`${consumer.name}-${group.service}`)
          const nodeHeight = calculateNodeHeight(group, isServiceExpanded);
          
          // Move to next position with appropriate spacing
          serviceY += nodeHeight + 60; // Increased padding between nodes
        })
      }
      
      // Move to next consumer section
      currentY += sectionHeight
    })
    
    // Create nodes and edges
    const userY = totalHeight / 2
    
    // Add user node
    nodes.push({
      id: "user",
      type: "user",
      position: { x: sidesPadding, y: userY },
      data: {},
    })

    // Add consumer and provider nodes
    consumers.forEach(consumer => {
      const consumerId = `consumer-${consumer.name}`
      const consumerX = sidesPadding + horizontalGap
      const consumerY = consumerYPositions[consumer.name]
      const isConsumerExpanded = expandedConsumers.has(consumer.name)
      const serviceGroups = serviceGroupsByConsumer[consumer.name]
      const hasMultipleProviders = serviceGroups.reduce((total, group) => total + group.providers.length, 0) > 2 // Changed threshold to >2
      
      // Add consumer node
      nodes.push({
        id: consumerId,
        type: "consumer",
        position: { x: consumerX, y: consumerY },
        data: { 
          label: consumer.name, 
          healthy: consumer.healthy,
          hasExpandedProviders: isConsumerExpanded,
          hasMultipleProviders: hasMultipleProviders,
          onToggleExpand: hasMultipleProviders ? () => {
            setExpandedGroups(prev => {
              const newState = { ...prev }
              const consumerKey = `consumer-${consumer.name}`
              newState[consumerKey] = !prev[consumerKey]
              return newState
            })
          } : undefined
        },
      })
      
      // Connect user to consumer
      edges.push({
        id: `edge-user-${consumerId}`,
        source: "user",
        target: consumerId,
        animated: consumer.healthy,
        style: consumer.healthy
          ? {
              stroke: "green",
              strokeDasharray: "5 5",
              animation: "dashdraw 0.5s linear infinite",
            }
          : { stroke: "red" },
      })

      if (isConsumerExpanded) {
        // If consumer is expanded, add service groups
        const serviceGroups = serviceGroupsByConsumer[consumer.name]
        const serviceX = consumerX + horizontalGap
        
        serviceGroups.forEach(group => {
          const serviceId = `service-group-${consumer.name}-${group.service}`
          const serviceY = serviceGroupYPositions[consumer.name][group.service]
          const isServiceExpanded = expandedServiceGroups.has(`${consumer.name}-${group.service}`)
          
          // Add service group node
          nodes.push({
            id: serviceId,
            type: "providerGroup",
            position: { x: serviceX, y: serviceY },
            data: {
              label: consumer.name,
              service: group.service,
              providers: group.providers,
              interfaces: group.interfaces,
              isExpanded: isServiceExpanded,
              maxWidth: finalProviderNodeWidth,
              onToggle: () => {
                setExpandedGroups(prev => {
                  const newState = { ...prev }
                  const serviceKey = `service-group-${consumer.name}-${group.service}`
                  newState[serviceKey] = !prev[serviceKey]
                  return newState
                })
              }
            }
          })
          
          // Connect consumer to service group
          edges.push({
            id: `edge-${consumerId}-${serviceId}`,
            source: consumerId,
            target: serviceId,
            type: "smoothstep",
            animated: consumer.healthy && group.anyHealthy,
            style: consumer.healthy && group.anyHealthy
              ? {
                  stroke: "green",
                  strokeDasharray: "5 5",
                  animation: "dashdraw 0.5s linear infinite",
                }
              : { stroke: "red" },
          })
        })
      } else {
        // If consumer is collapsed, always show a provider count node regardless of count
        const providerCountNodeId = `provider-count-${consumer.name}`
        const providerCountX = consumerX + horizontalGap
        const providerCountY = consumerY
        
        // Calculate total provider count
        const totalProviders = serviceGroups.reduce((total, group) => 
          total + group.interfaces.size, 0)
        
        // Calculate if any providers are unhealthy
        const anyUnhealthy = serviceGroups.some(group => 
          group.providers.some(provider => !provider.healthy)
        )
        
        // Add provider count node
        nodes.push({
          id: providerCountNodeId,
          type: "providerCount",
          position: { x: providerCountX, y: providerCountY },
          data: {
            consumer: consumer.name,
            count: totalProviders,
            isHealthy: !anyUnhealthy,
            onExpand: () => {
              setExpandedGroups(prev => {
                const newState = { ...prev }
                const consumerKey = `consumer-${consumer.name}`
                newState[consumerKey] = true
                return newState
              })
            }
          }
        })
        
        // Connect consumer to provider count node
        edges.push({
          id: `edge-${consumerId}-${providerCountNodeId}`,
          source: consumerId,
          target: providerCountNodeId,
          type: "smoothstep",
          animated: consumer.healthy,
          style: consumer.healthy
            ? {
                stroke: "green",
                strokeDasharray: "5 5",
                animation: "dashdraw 0.5s linear infinite",
              }
            : { stroke: "red" },
        })
      }
    })

    return { nodes, edges }
  }, [expandedGroups, apiData, setExpandedGroups])

  // Adjust containerHeight dynamically based on expanded nodes
  useEffect(() => {
    if (nodesInitialized && renderedNodes && renderedNodes.length > 0) {
      const bounds = getRectOfNodes(renderedNodes)
      const verticalPadding = 40
      const totalHeight = Math.max(600, bounds.height + (verticalPadding * 2))
      setContainerHeight(totalHeight)
    }
  }, [nodesInitialized, renderedNodes, expandedGroups])

  return (
    <div className="border rounded-lg w-full" style={{ height: containerHeight }}>
      <ReactFlow 
        key={key}
        nodes={flowNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        className="bg-muted/10"
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        defaultEdgeOptions={{
          type: "smoothstep",
          style: { strokeWidth: 2 },
        }}
        fitView
        panOnDrag={false}
        preventScrolling={true}
        zoomOnScroll={false}
      >
        <Background />
        <Controls />
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
      `}</style>
    </div>
  )
}

export function FlowVisualization({ data }: FlowVisualizationProps) {
  const [isAllExpanded, setIsAllExpanded] = useState(false);
  
  return (
    <div className="space-y-4 w-full">
      <div className="flex mb-2">
        <div className="ml-auto">
          <button 
            onClick={() => setIsAllExpanded(prev => !prev)}
            className="flex items-center gap-1.5 px-4 py-1.5 text-sm bg-secondary hover:bg-secondary/90 rounded-md border shadow-sm"
          >
            {isAllExpanded ? (
              <>
                <ChevronUp className="h-4 w-4" />
                <span>Collapse All</span>
              </>
            ) : (
              <>
                <ChevronDown className="h-4 w-4" />
                <span>Expand All</span>
              </>
            )}
          </button>
        </div>
      </div>
      <ReactFlowProvider>
        <FlowInner apiData={data} isAllExpanded={isAllExpanded} />
      </ReactFlowProvider>
    </div>
  )
}
