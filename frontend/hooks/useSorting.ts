import { useState } from 'react';
import { SortField, SortDirection, ProviderMetrics, ChainMetrics } from '@/types/metrics';

export function useSorting() {
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      // Cycle through: asc -> desc -> asc
      if (sortDirection === 'asc') {
        setSortDirection('desc');
      } else {
        setSortDirection('asc');
      }
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const sortData = <T extends ProviderMetrics | ChainMetrics>(data: T[]): T[] => {
    return [...data].sort((a, b) => {
      // Only support name sorting
      const aValue = 'provider' in a ? a.provider : a.chain;
      const bValue = 'provider' in b ? b.provider : b.chain;

      return sortDirection === 'asc' ? aValue.localeCompare(bValue) : bValue.localeCompare(aValue);
    });
  };

  return {
    sortField,
    sortDirection,
    handleSort,
    sortData,
  };
}
