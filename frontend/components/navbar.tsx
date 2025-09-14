'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function Navbar() {
  const pathname = usePathname();

  return (
    <nav className='border-b px-4'>
      <div className='flex h-14 items-center'>
        <div className='flex items-center gap-2 font-medium'>
          <Activity className='h-5 w-5' />
          <span>Smart Router</span>
        </div>
        <div className='ml-8 flex items-center space-x-1'>
          <Link href='/'>
            <Button variant={pathname === '/' ? 'default' : 'ghost'} className='h-9'>
              Dashboard
            </Button>
          </Link>
          <Link href='/config'>
            <Button variant={pathname === '/config' ? 'default' : 'ghost'} className='h-9'>
              <Settings className='mr-2 h-4 w-4' />
              Configuration
            </Button>
          </Link>
        </div>
      </div>
    </nav>
  );
}
