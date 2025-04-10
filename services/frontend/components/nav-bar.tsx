"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Activity, Settings } from "lucide-react"
import { ThemeToggle } from "@/components/theme-toggle"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function NavBar() {
  const pathname = usePathname()

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-14 items-center">
        <div className="mr-4 flex">
          <Link href="/" className="flex items-center space-x-2">
            <Activity className="h-6 w-6" />
            <span className="font-bold">Health Monitor</span>
          </Link>
        </div>
        <div className="flex items-center space-x-4 flex-1">
          <nav className="flex items-center space-x-2">
            <Link href="/" passHref>
              <Button
                variant={pathname === "/" ? "default" : "ghost"}
                className={cn("text-sm font-medium transition-colors")}
              >
                Dashboard
              </Button>
            </Link>
            <Link href="/configuration" passHref>
              <Button
                variant={pathname === "/configuration" ? "default" : "ghost"}
                className={cn("text-sm font-medium transition-colors")}
              >
                <Settings className="mr-2 h-4 w-4" />
                Configuration
              </Button>
            </Link>
          </nav>
        </div>
        <div className="flex items-center space-x-2">
          <ThemeToggle />
        </div>
      </div>
    </header>
  )
}
