import { useState } from "react"
import { SortField, SortDirection, ProviderMetrics, ChainMetrics } from "@/types/metrics"

export function useSorting() {
  const [sortField, setSortField] = useState<SortField>('name')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      // Cycle through: asc -> desc -> asc
      if (sortDirection === 'asc') {
        setSortDirection('desc')
      } else {
        setSortDirection('asc')
      }
    } else {
      setSortField(field)
      setSortDirection('asc')
    }
  }

  const sortData = <T extends ProviderMetrics | ChainMetrics>(data: T[]): T[] => {
    return [...data].sort((a, b) => {
      let aValue: string | number
      let bValue: string | number

      switch (sortField) {
        case 'name':
          aValue = 'provider' in a ? a.provider : a.chain
          bValue = 'provider' in b ? b.provider : b.chain
          break
        case 'traffic':
          aValue = parseFloat(a.traffic.replace('M req/day', ''))
          bValue = parseFloat(b.traffic.replace('M req/day', ''))
          break
        case 'uptime':
          aValue = parseFloat(a.uptime.replace('%', ''))
          bValue = parseFloat(b.uptime.replace('%', ''))
          break
        case 'latency':
          aValue = parseFloat(a.latency.replace('ms', ''))
          bValue = parseFloat(b.latency.replace('ms', ''))
          break
        case 'dataFreshness':
          const aFreshness = 'sync' in a ? a.sync : a.freshness
          const bFreshness = 'sync' in b ? b.sync : b.freshness
          aValue = parseFloat(aFreshness.replace('%', ''))
          bValue = parseFloat(bFreshness.replace('%', ''))
          break
        default:
          return 0
      }

      if (typeof aValue === 'string' && typeof bValue === 'string') {
        return sortDirection === 'asc' 
          ? aValue.localeCompare(bValue)
          : bValue.localeCompare(aValue)
      }

      if (typeof aValue === 'number' && typeof bValue === 'number') {
        return sortDirection === 'asc' 
          ? aValue - bValue
          : bValue - aValue
      }

      return 0
    })
  }

  return {
    sortField,
    sortDirection,
    handleSort,
    sortData
  }
}
