"use client"

<<<<<<< HEAD
import { useMemo } from "react"
import type { ProcessedMetric } from "@/lib/types"
import { User, Server, Database, CheckCircle, XCircle } from "lucide-react"

// Since ReactFlow is causing issues in the preview environment,
// let's create a simpler custom flow visualization
interface FlowVisualizationProps {
  data: ProcessedMetric[]
}

// Replace the entire FlowVisualization component with this improved version
export function FlowVisualization({ data }: FlowVisualizationProps) {
  // Add a check to handle empty data
  const isEmptyData = !data || data.length === 0

  // Process data to get unique specs and their providers
  const processedData = useMemo(() => {
    if (isEmptyData) {
      return []
    }
    // Initialize the Map correctly
    const specGroups = new Map<string, { apiInterface: string; isHealthy: boolean }[]>()

    // Process each metric
    data.forEach((metric) => {
      if (!specGroups.has(metric.spec)) {
        specGroups.set(metric.spec, [])
      }

      // Get the latest health value
      const latestValue = metric.values.length > 0 ? metric.values[metric.values.length - 1].value : 0
      const isHealthy = latestValue === 1

      specGroups.get(metric.spec)!.push({
        apiInterface: metric.apiInterface,
        isHealthy,
      })
    })

    // Convert the Map to an array of objects
    return Array.from(specGroups.entries()).map(([spec, providers]) => ({
      spec,
      providers,
    }))
  }, [data, isEmptyData])

  if (isEmptyData) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">No data available to display</p>
      </div>
    )
  }

  return (
    <div className="w-full h-full overflow-auto">
      <div className="relative min-h-[350px] w-full flex items-center justify-center">
        <div className="flex flex-col md:flex-row items-start justify-center gap-8 p-4">
          {/* User node - fixed on the left */}
          <div className="md:self-center">
            <UserNode />
          </div>

          {/* Consumer and Provider nodes */}
          <div className="flex flex-col items-start justify-center gap-8 mt-8 md:mt-0">
            {processedData.map((specGroup, specIndex) => (
              <div key={specGroup.spec} className="flex flex-col md:flex-row items-start md:items-center gap-4">
                {/* Consumer node */}
                <div className="relative">
                  <ConsumerNode label={specGroup.spec} />

                  {/* Line from User to Consumer - only visible on md and up */}
                  <div className="absolute hidden md:block left-0 top-1/2 w-16 h-0.5 bg-green-500 -translate-x-full -translate-y-1/2">
                    <div className="absolute top-0 left-0 h-full w-1/4 bg-green-400 animate-flow"></div>
                  </div>
                </div>

                {/* Provider nodes */}
                <div className="flex flex-wrap gap-4 ml-0 md:ml-8 mt-4 md:mt-0">
                  {specGroup.providers.map((provider, providerIndex) => (
                    <div key={`${specGroup.spec}-${provider.apiInterface}`} className="relative">
                      <ProviderNode
                        label={specGroup.spec}
                        apiInterface={provider.apiInterface}
                        isHealthy={provider.isHealthy}
                      />

                      {/* Line from Consumer to Provider - only visible on md and up */}
                      <div
                        className={`absolute hidden md:block left-0 top-1/2 w-8 h-0.5 ${
                          provider.isHealthy ? "bg-green-500" : "bg-red-500"
                        } -translate-x-full -translate-y-1/2`}
                      >
                        {provider.isHealthy && (
                          <div className="absolute top-0 left-0 h-full w-1/3 bg-green-400 animate-flow"></div>
                        )}
                        {!provider.isHealthy && (
                          <div className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1/2">
                            <XCircle className="h-4 w-4 text-red-500" />
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
=======
import { useEffect, useMemo, useState } from "react"
import { Check, Network, Server, User, X, ChevronDown, ChevronRight } from "lucide-react"
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
  useNodesState,
  getRectOfNodes,
} from "reactflow"
import "reactflow/dist/style.css"

interface FlowVisualizationProps {
  data: any
}

interface Provider {
  interface: string
  healthy: boolean
}

interface Consumer {
  name: string
  healthy: boolean
}

type Providers = {
  [key: string]: Provider[]
}

function UserNode({ data }: { data: any }) {
  return (
    <div className="px-4 py-2 shadow-lg rounded-lg border bg-background min-w-44">
      <div className="flex items-center gap-2">
        <User className="h-4 w-4" />
        <div className="font-medium">User</div>
      </div>
      <Handle type="source" position={Position.Right} className="!bg-muted-foreground" />
>>>>>>> 793562b (Add Dashboard)
    </div>
  )
}

<<<<<<< HEAD
// Update the node components to be more compact
function UserNode() {
  return (
    <div className="p-2 rounded-lg border-2 border-gray-300 bg-background shadow-md flex items-center">
      <User className="mr-2 h-5 w-5 text-primary" />
      <div className="font-semibold text-sm">User</div>
    </div>
  )
}

function ConsumerNode({ label }: { label: string }) {
  return (
    <div className="p-2 rounded-lg border-2 border-gray-300 bg-background shadow-md flex items-center">
      <Server className="mr-2 h-5 w-5 text-primary" />
      <div>
        <div className="font-semibold text-sm">{label}</div>
        <div className="text-xs text-muted-foreground">Consumer</div>
      </div>
    </div>
  )
}

function ProviderNode({ label, apiInterface, isHealthy }: { label: string; apiInterface: string; isHealthy: boolean }) {
  return (
    <div
      className={`p-2 rounded-lg border-2 ${
        isHealthy ? "border-green-500" : "border-red-500"
      } bg-background shadow-md flex items-center`}
    >
      <Database className={`mr-2 h-5 w-5 ${isHealthy ? "text-green-500" : "text-red-500"}`} />
      <div>
        <div className="font-semibold text-sm">{label}</div>
        <div className="text-xs text-muted-foreground">{apiInterface}</div>
      </div>
      {isHealthy ? (
        <CheckCircle className="ml-2 h-4 w-4 text-green-500" />
      ) : (
        <XCircle className="ml-2 h-4 w-4 text-red-500" />
      )}
    </div>
  )
}
=======
function ConsumerNode({ data }: { data: { label: string; healthy: boolean } }) {
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
        {data.healthy ? (
          <Check className="h-4 w-4 text-green-500 ml-auto" />
        ) : (
          <X className="h-4 w-4 text-red-500 ml-auto" />
        )}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-muted-foreground" />
    </div>
  )
}

function ProviderNode({ data }: { data: { label: string; interface: string; healthy: boolean } }) {
  return (
    <div
      className={cn(
        "px-4 py-2 shadow-lg rounded-lg border bg-background min-w-44",
        data.healthy ? "border-green-200" : "border-red-200"
      )}
    >
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground" />
      <div className="flex items-center gap-2">
        <Server className="h-4 w-4" />
        <div className="flex flex-col">
          <span className="font-medium">{data.label}</span>
          <span className="text-xs text-muted-foreground">{data.interface}</span>
        </div>
        {data.healthy ? (
          <Check className="h-4 w-4 text-green-500 ml-auto" />
        ) : (
          <X className="h-4 w-4 text-red-500 ml-auto" />
        )}
      </div>
    </div>
  )
}

function ProviderGroupNode({ data }: { data: { label: string; providers: Provider[]; isExpanded: boolean; onToggle: () => void } }) {
  return (
    <div
      className={cn(
        "px-4 py-2 shadow-lg rounded-lg border bg-background min-w-44",
        data.providers.some(p => !p.healthy) ? "border-red-200" : "border-green-200"
      )}
    >
      <Handle type="target" position={Position.Left} className="!bg-muted-foreground" />
      <div className="flex items-center gap-2">
        <Server className="h-4 w-4" />
        <div className="flex flex-col">
          <span className="font-medium">{data.label}</span>
          <span className="text-xs text-muted-foreground">{data.providers.length} providers</span>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            data.onToggle();
          }}
          className="ml-auto p-1 hover:bg-muted rounded"
        >
          {data.isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
      </div>
    </div>
  )
}

const nodeTypes = {
  user: UserNode,
  consumer: ConsumerNode,
  provider: ProviderNode,
  providerGroup: ProviderGroupNode,
}

function FlowInner() {
  const [containerHeight, setContainerHeight] = useState(800);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [nodes, setNodes] = useNodesState([]);
  const [edges, setEdges] = useState<Edge[]>([]);

  useEffect(() => {
    // Mock data
    const consumers: Consumer[] = [
      { name: "NEAR", healthy: true },
      { name: "ETH", healthy: true },
      { name: "BTC", healthy: false },
      { name: "SOL", healthy: true },
      { name: "LAVA", healthy: true },
    ];

    const providers: Providers = {
      NEAR: [
        { interface: "jsonrpc", healthy: true },
        { interface: "grpc", healthy: true },
        { interface: "rest", healthy: false },
      ],
      ETH: [
        { interface: "grpc", healthy: true },
        { interface: "rest", healthy: true },
        { interface: "jsonrpc", healthy: true },
        { interface: "websocket", healthy: false },
        { interface: "quicknode", healthy: true },
      ],
      BTC: [
        { interface: "anker", healthy: false },
        { interface: "core-lightning", healthy: true }
      ],
      SOL: [
        { interface: "jsonrpc", healthy: false },
        { interface: "rest", healthy: true },
        { interface: "websocket", healthy: true },
      ],
      LAVA: [
        { interface: "grpc", healthy: true },
        { interface: "rest", healthy: true },
        { interface: "jsonrpc", healthy: true },
        { interface: "websocket", healthy: true },
      ],
    };

    const newNodes: Node[] = [];
    const newEdges: Edge[] = [];

    const leftPadding = 50;
    const horizontalGap = 300;
    
    // Use a very large gap between consumers to prevent any overlap
    const consumerGap = 600;
    
    // Add user node
    newNodes.push({
      id: "user",
      type: "user",
      position: { x: leftPadding, y: (consumers.length * consumerGap) / 2 },
      data: {},
    });

    // Add consumer and provider nodes
    consumers.forEach((consumer, index) => {
      const consumerId = `consumer-${consumer.name}`;
      const consumerX = leftPadding + horizontalGap;
      const consumerY = index * consumerGap;

      // Add consumer node
      newNodes.push({
        id: consumerId,
        type: "consumer",
        position: { x: consumerX, y: consumerY },
        data: { label: consumer.name, healthy: consumer.healthy },
      });

      // Add edge from user to consumer
      newEdges.push({
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
      });

      const consumerProviders = providers[consumer.name];
      const isExpanded = expandedGroups[consumerId] || false;

      if (consumerProviders.length > 2 && !isExpanded) {
        // Create a group node
        const groupId = `group-${consumerId}`;
        newNodes.push({
          id: groupId,
          type: "providerGroup",
          position: {
            x: consumerX + horizontalGap,
            y: consumerY,
          },
          data: {
            label: consumer.name,
            providers: consumerProviders,
            isExpanded,
            onToggle: () => {
              setExpandedGroups(prev => ({
                ...prev,
                [consumerId]: !prev[consumerId]
              }));
            }
          },
        });

        newEdges.push({
          id: `edge-${consumerId}-${groupId}`,
          source: consumerId,
          target: groupId,
          animated: consumer.healthy,
          style: consumer.healthy
            ? {
                stroke: "green",
                strokeDasharray: "5 5",
                animation: "dashdraw 0.5s linear infinite",
              }
            : { stroke: "red" },
        });
      } else {
        // HORIZONTAL layout - providers in a row
        const providerHorizontalSpacing = 170; // Space between providers horizontally
        const sortedProviders = [...consumerProviders].sort((a, b) => 
          a.interface.localeCompare(b.interface)
        );
        
        // Calculate total width to center the row
        const totalWidth = sortedProviders.length * providerHorizontalSpacing;
        const startX = consumerX + horizontalGap - (totalWidth / 2) + (providerHorizontalSpacing / 2);
        
        sortedProviders.forEach((provider, providerIndex) => {
          const providerId = `provider-${consumer.name}-${provider.interface}`;
          const providerX = startX + (providerIndex * providerHorizontalSpacing);
          
          newNodes.push({
            id: providerId,
            type: "provider",
            position: {
              x: providerX,
              y: consumerY,
            },
            data: {
              label: consumer.name,
              interface: provider.interface,
              healthy: provider.healthy,
            },
          });

          newEdges.push({
            id: `edge-${consumerId}-${providerId}`,
            source: consumerId,
            target: providerId,
            animated: provider.healthy,
            style: provider.healthy
              ? {
                  stroke: "green",
                  strokeDasharray: "5 5",
                  animation: "dashdraw 0.5s linear infinite",
                }
              : { stroke: "red" },
          });
        });
      }
    });

    setNodes(newNodes);
    setEdges(newEdges);
  }, [setNodes, expandedGroups]);

  useEffect(() => {
    if (nodes.length > 0) {
      const bounds = getRectOfNodes(nodes);
      const verticalPadding = 40;
      const totalHeight = Math.max(600, bounds.height + (verticalPadding * 2));
      setContainerHeight(totalHeight);
    }
  }, [nodes]);

  return (
    <div className="border rounded-lg w-full" style={{ height: containerHeight }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        className="bg-muted/10"
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        defaultEdgeOptions={{
          type: "smoothstep",
          style: { strokeWidth: 2 },
        }}
        minZoom={0.5}
        maxZoom={1.2}
        fitView
        fitViewOptions={{
          padding: 100,
          minZoom: 1,
          maxZoom: 1.2,
          includeHiddenNodes: true,
        }}
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
  );
}

export function FlowVisualization({ data }: FlowVisualizationProps) {
  return (
    <div className="space-y-4 w-full">
      <ReactFlowProvider>
        <FlowInner />
      </ReactFlowProvider>
    </div>
  );
} 
>>>>>>> 793562b (Add Dashboard)
