'use client';

import { ChevronUp, ChevronDown } from 'lucide-react';
import { ProviderMetrics, ChainMetrics, SortField, SortDirection } from '@/types/metrics';
import { getUptimeColor, getReachabilityColor, getLatencyColor } from '@/utils/colors';
import { getChainIcon } from '@/app/config/chains';

interface MetricsTableProps {
  data: ProviderMetrics[] | ChainMetrics[];
  type: 'providers' | 'chains';
  sortField: SortField;
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
    if (field !== 'name') return null;
    if (sortDirection === 'asc') return <ChevronUp className='h-4 w-4' />;
    if (sortDirection === 'desc') return <ChevronDown className='h-4 w-4' />;
    return <ChevronUp className='h-4 w-4' />;
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
          <col style={{ width: type === 'providers' ? '20%' : '25%' }} />
          {type === 'providers' && <col style={{ width: '20%' }} />}
          <col style={{ width: '20%' }} />
          <col style={{ width: '20%' }} />
          <col style={{ width: '20%' }} />
          <col style={{ width: '15%' }} />
        </colgroup>
        <thead>
          <tr className='border-b'>
            <th
              className='text-left p-3 font-medium cursor-pointer hover:bg-white/10 hover:text-white transition-colors select-none group'
              onClick={() => onSort('name')}
            >
              <div className='flex items-center gap-1'>
                {type === 'providers' ? 'Provider' : 'Chain'}
                <div className='opacity-0 group-hover:opacity-100 transition-opacity'>
                  {getSortIcon('name')}
                </div>
              </div>
            </th>
            {type === 'providers' && (
              <th className='text-left p-3 font-medium'>Chain</th>
            )}
            <th className='text-left p-3 font-medium'>Latest Block</th>
            <th className='text-left p-3 font-medium'>Total Requests</th>
            <th className='text-left p-3 font-medium'>Uptime</th>
            <th className='text-left p-3 font-medium'>Latency</th>
          </tr>
        </thead>
        <tbody>
          {data.map((item, index) => {
            const isProvider = 'provider' in item;
            const name = isProvider ? item.provider : item.chain;
            const uptime = item.uptime;
            const latency = item.latency;

            return (
              <tr key={index} className='border-b hover:bg-muted/50'>
                <td className='p-3 font-medium'>
                  {isProvider ? (
                    name
                  ) : (
                    // For chains, show icon + name
                    item.chainValue && (
                      <div className='flex items-center gap-2'>
                        <img
                          src={getChainIcon(item.chainValue)}
                          alt={name}
                          className='w-5 h-5 flex-shrink-0'
                          onError={(e) => {
                            // Hide image if it fails to load
                            e.currentTarget.style.display = 'none';
                          }}
                        />
                        <span>{name}</span>
                      </div>
                    )
                  )}
                </td>
                {isProvider && (
                  <td className='p-3'>
                    {item.chainValue && (
                      <div className='flex items-center gap-2'>
                        <img
                          src={getChainIcon(item.chainValue)}
                          alt={item.chain || ''}
                          className='w-5 h-5 flex-shrink-0'
                          onError={(e) => {
                            // Hide image if it fails to load
                            e.currentTarget.style.display = 'none';
                          }}
                        />
                        <span className='text-sm'>{item.chain}</span>
                      </div>
                    )}
                  </td>
                )}
                <td className='p-3'>{item.latest_block}</td>
                <td className='p-3'>{item.traffic}</td>
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
