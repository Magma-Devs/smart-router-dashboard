"use client"

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
    </div>
  )
}

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
