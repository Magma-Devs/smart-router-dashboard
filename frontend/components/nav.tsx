import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Icons } from '@/components/icons';
import { siteConfig } from '@/config/site';
import { useConfig } from '@/hooks/use-config';

export function Nav() {
  const { config } = useConfig();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <header className='sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60'>
      <div className='container flex h-14 items-center'>
        <div className='mr-4 hidden md:flex'>
          <a href='/' className='mr-6 flex items-center space-x-2'>
            <Icons.logo className='h-6 w-6' />
            <span className='hidden font-bold sm:inline-block'>{siteConfig.name}</span>
          </a>
          <nav className='flex items-center space-x-6 text-sm font-medium'>
            <a
              href='/live-test'
              className={cn('transition-colors hover:text-foreground/80', 'text-foreground')}
            >
              Live Test
            </a>
          </nav>
        </div>
        <button
          className='mr-2 px-0 text-base hover:bg-transparent focus-visible:bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 md:hidden'
          onClick={() => setIsOpen(!isOpen)}
        >
          <Icons.menu className='h-5 w-5' />
          <span className='sr-only'>Toggle Menu</span>
        </button>
        <div className='flex flex-1 items-center justify-between space-x-2 md:justify-end'>
          <div className='w-full flex-1 md:w-auto md:flex-none'>
            <div className='text-sm text-muted-foreground'>API: {config.apiEndpoint}</div>
          </div>
        </div>
      </div>
    </header>
  );
}
