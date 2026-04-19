'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { Settings, LayoutDashboard, Zap, LogOut, User, Wand2, BarChart3, Info, Key } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth-context';
import { useDebug } from '@/hooks/use-debug';
import { apiClient } from '@/lib/api-client';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function NavBar() {
  const pathname = usePathname();
  const { isAuthenticated, username, logout } = useAuth();
  const { debugMode } = useDebug();
  const [version, setVersion] = useState<string | null>(null);

  // Fetch version from backend API
  useEffect(() => {
    if (isAuthenticated) {
      apiClient
        .get<{ version: string }>('/api/settings/version')
        .then(data => setVersion(data.version))
        .catch(() => setVersion('unknown'));
    }
  }, [isAuthenticated]);

  return (
    <header className='sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60'>
      <div className='container mx-auto px-4 flex h-14 items-center max-w-7xl'>
        <div className='mr-4 flex'>
          <Link href='/' className='flex items-center space-x-2'>
            <Image
              src='/magma-logo.png'
              alt='Magma Devs Logo'
              width={120}
              height={24}
              className='h-6 w-auto'
            />
            <span className='font-outfit font-bold text-lg tracking-tight'>Smart Router</span>
          </Link>
        </div>
        <div className='flex items-center space-x-4 flex-1'>
          {isAuthenticated && (
            <nav className='flex items-center space-x-2'>
              <Link href='/'>
                <Button
                  variant={pathname === '/' ? 'default' : 'ghost'}
                  className='flex items-center gap-1.5'
                >
                  <LayoutDashboard className='h-4 w-4' />
                  Dashboard
                </Button>
              </Link>
              <Link href='/live-test'>
                <Button
                  variant={pathname === '/live-test' ? 'default' : 'ghost'}
                  className='flex items-center gap-1.5'
                >
                  <Zap className='h-4 w-4' />
                  Live Test
                </Button>
              </Link>
              <Link href='/usage'>
                <Button
                  variant={pathname === '/usage' ? 'default' : 'ghost'}
                  className='flex items-center gap-1.5'
                >
                  <BarChart3 className='h-4 w-4' />
                  Usage
                </Button>
              </Link>
              <Link href='/api-keys'>
                <Button
                  variant={pathname === '/api-keys' ? 'default' : 'ghost'}
                  className='flex items-center gap-1.5'
                >
                  <Key className='h-4 w-4' />
                  API Keys
                </Button>
              </Link>
              <Link href='/configuration'>
                <Button
                  variant={pathname === '/configuration' ? 'default' : 'ghost'}
                  className='flex items-center gap-1.5'
                >
                  <Settings className='h-4 w-4' />
                  Settings
                </Button>
              </Link>
              {debugMode && (
                <Link href='/wizard'>
                  <Button
                    variant={pathname === '/wizard' ? 'default' : 'ghost'}
                    className='flex items-center gap-1.5'
                  >
                    <Wand2 className='h-4 w-4' />
                    Configuration Wizard
                  </Button>
                </Link>
              )}
            </nav>
          )}
        </div>
        <div className='flex items-center space-x-2'>
          {isAuthenticated && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant='ghost' className='flex items-center gap-2'>
                  <User className='h-4 w-4' />
                  <span className='hidden sm:inline'>{username}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align='end'>
                <DropdownMenuLabel>Account</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled className='text-muted-foreground cursor-default'>
                  <Info className='mr-2 h-4 w-4' />
                  Version {version || '...'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={logout} className='text-red-600'>
                  <LogOut className='mr-2 h-4 w-4' />
                  Logout
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </header>
  );
}
