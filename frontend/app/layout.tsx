import type React from "react"
import type { Metadata } from "next"
import { Inter, Poppins, JetBrains_Mono, Outfit } from "next/font/google"
import "./globals.css"
import { NavBar } from "@/components/nav-bar"
import { ThemeProvider } from "@/components/theme-provider"
import { AuthProvider } from "@/lib/auth-context"

const inter = Inter({ subsets: ["latin"] })
const poppins = Poppins({ 
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-poppins"
})
const outfit = Outfit({ 
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
  variable: "--font-outfit"
})
const jetbrainsMono = JetBrains_Mono({ 
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-jetbrains-mono"
})

export const metadata: Metadata = {
  title: "Smart Router",
  description: "Real-time monitoring of Smart Router infrastructure health and uptime",
  icons: {
    icon: [
      { url: "/magma-icon.png", type: "image/png" },
    ],
    apple: [
      { url: "/magma-icon.png", type: "image/png" },
    ],
    shortcut: [
      { url: "/magma-icon.png", type: "image/png" },
    ],
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="icon" href="/magma-icon.png" sizes="any" />
      </head>
      <body className={`${outfit.className} ${poppins.variable} ${jetbrainsMono.variable}`}>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <AuthProvider>
            <div className="relative min-h-screen flex flex-col">
              <NavBar />
              <main className="flex-1">{children}</main>
            </div>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}