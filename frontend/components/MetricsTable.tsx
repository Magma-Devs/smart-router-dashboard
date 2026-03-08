'use client';

import { ChevronUp, ChevronDown } from 'lucide-react';
import { NodeMetrics, RouterMetrics, SortField, SortDirection } from '@/types/metrics';
import { getUptimeColor, getReachabilityColor, getLatencyColor } from '@/utils/colors';
import { getChainIcon } from '@/app/config/chains';

interface MetricsTableProps {
  data: NodeMetrics[] | RouterMetrics[];
  type: 'providers' | 'chains';
  sortField: SortField | null;
  sortDirection: SortDirection;
  onSort: (field: SortField) => void;
  loading?: boolean;
}

export function MetricsTable({
  data,
  type,
  sortField,
  sortDirection,
  onSort,
  loading = false,
}: MetricsTableProps) {
  const getSortIcon = (field: SortField) => {
    if (sortField !== field) return null;
    if (sortDirection === 'asc') return <ChevronUp className='h-4 w-4' />;
    if (sortDirection === 'desc') return <ChevronDown className='h-4 w-4' />;
    return null;
  };

  if (loading) {
    return (
      <div className='flex items-center justify-center py-12'>
        <div className='animate-spin rounded-full h-8 w-8 border-b-2 border-primary'></div>
      </div>
    );
  }

  return (
    <div className='overflow-x-auto'>
      <table className='w-full table-fixed border-collapse'>
        <colgroup>
          <col style={{ width: type === 'providers' ? '20%' : '20%' }} />
          {/* Second column for both providers (chain) and chains (network) */}
          <col style={{ width: '20%' }} />
          <col style={{ width: '15%' }} />
          <col style={{ width: '15%' }} />
          <col style={{ width: '15%' }} />
          <col style={{ width: '15%' }} />
        </colgroup>
        <thead>
          <tr className='border-b'>
            <th
              className='text-left p-3 font-medium cursor-pointer hover:bg-white/10 hover:text-white transition-colors select-none group'
              onClick={() => onSort('name')}
            >
              <div className='flex items-center gap-1'>
                {type === 'providers' ? 'Node' : 'Router'}
                <div className='opacity-0 group-hover:opacity-100 transition-opacity'>
                  {getSortIcon('name')}
                </div>
              </div>
            </th>
            {/* Second column heading */}
            <th className='text-left p-3 font-medium'>Chain</th>
            <th className='text-left p-3 font-medium'>Latest Block</th>
            <th className='text-left p-3 font-medium'>Total Requests</th>
            <th className='text-left p-3 font-medium'>Uptime</th>
            <th className='text-left p-3 font-medium'>Latency</th>
          </tr>
        </thead>
        <tbody>
          {data.map((item, index) => {
            const isProvider = 'provider' in item;
            const name = isProvider ? item.provider : item.chain; // chain: router id for chains
            const uptime = item.uptime;
            const latency = item.latency;

            return (
              <tr key={index} className='border-b hover:bg-muted/50'>
                {/* First column */}
                <td className='p-3 font-medium'>{name}</td>
                {/* Second column: Chain/network */}
                <td className='p-3'>
                  {(() => {
                    const chainLabel = isProvider ? (item as any).chain : (item as any).chainLabel;
                    const chainValue = (item as any).chainValue;
                    return chainValue ? (
                      <div className='flex items-center gap-2'>
                        <img
                          src={getChainIcon(chainValue)}
                          alt={chainLabel || ''}
                          className='w-5 h-5 flex-shrink-0'
                          onError={e => {
                            e.currentTarget.style.display = 'none';
                          }}
                        />
                        <span className='text-sm'>{chainLabel}</span>
                      </div>
                    ) : (
                      <span className='text-sm'>{chainLabel}</span>
                    );
                  })()}
                </td>
                <td className='p-3'>{(item as any).latest_block}</td>
                <td className='p-3'>{(item as any).traffic}</td>
                <td
                  className={`p-3 ${isProvider ? getReachabilityColor(uptime) : getUptimeColor(uptime)}`}
                >
                  {uptime}
                </td>
                <td className={`p-3 ${getLatencyColor(latency)}`}>{latency}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
