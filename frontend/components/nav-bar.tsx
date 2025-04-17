"use client"

import Link from "next/link"
import Image from "next/image"
import { usePathname } from "next/navigation"
import { Settings, Wand2, LayoutDashboard } from "lucide-react"
import { ThemeToggle } from "@/components/theme-toggle"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export function NavBar() {
  const pathname = usePathname()

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container mx-auto px-4 flex h-14 items-center max-w-7xl">
        <div className="mr-4 flex">
          <Link href="/" className="flex items-center space-x-2">
            <Image
              src="/lava-icon.png"
              alt="Lava Logo"
              width={24}
              height={24}
              className="h-6 w-6"
            />
            <span className="font-bold">Lava Infra Manager</span>
          </Link>
        </div>
        <div className="flex items-center space-x-4 flex-1">
          <nav className="flex items-center space-x-2">
            <Link href="/">
              <Button
                variant={pathname === "/" ? "default" : "ghost"}
                className="flex items-center gap-1.5"
              >
                <LayoutDashboard className="h-4 w-4" />
                Dashboard
              </Button>
            </Link>
            <Link href="/wizard">
              <Button
                variant={pathname === "/wizard" ? "default" : "ghost"}
                className="flex items-center gap-1.5"
              >
                <Wand2 className="h-4 w-4" />
                Configuration Wizard
              </Button>
            </Link>
            <Link href="/configuration">
              <Button
                variant={pathname === "/configuration" ? "default" : "ghost"}
                className="flex items-center gap-1.5"
              >
                <Settings className="h-4 w-4" />
                Settings
              </Button>
            </Link>
          </nav>
        </div>
        <div className="flex items-center">
          <ThemeToggle />
        </div>
      </div>
    </header>
  )
}
