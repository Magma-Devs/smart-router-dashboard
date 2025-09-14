'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, Settings, Sun, Moon } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function Navbar() {
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();

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
        <div className='ml-auto'>
          <Button
            variant='ghost'
            size='icon'
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          >
            {theme === 'light' ? <Moon className='h-5 w-5' /> : <Sun className='h-5 w-5' />}
          </Button>
        </div>
      </div>
    </nav>
  );
}
