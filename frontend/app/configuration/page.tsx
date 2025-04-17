"use client"

import type React from "react"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { useConfig } from "@/hooks/use-config"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { toast } from "@/components/ui/use-toast"
import { Toaster } from "@/components/ui/toaster"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Info } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export default function ConfigurationPage() {
  const router = useRouter()
  const { config, updateApiEndpoint, updateRefreshInterval } = useConfig()
  const [inputValue, setInputValue] = useState(config.apiEndpoint)
  const [isPreviewEnvironment, setIsPreviewEnvironment] = useState(false)

  useEffect(() => {
    setInputValue(config.apiEndpoint)
    // Check if we're in a preview environment
    if (typeof window !== "undefined") {
      setIsPreviewEnvironment(window.location.hostname !== "localhost")
    }
  }, [config.apiEndpoint])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    // Basic validation
    if (!inputValue.trim()) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "API host cannot be empty",
      })
      return
    }

    updateApiEndpoint(inputValue)
    toast({
      title: "Configuration saved",
      description: "Your API host has been updated successfully",
    })
    router.push("/")
  }

  const handleReset = () => {
    const defaultHost = "http://localhost:8000"
    setInputValue(defaultHost)
    updateApiEndpoint(defaultHost)
    toast({
      title: "Configuration reset",
      description: "API host has been reset to default",
    })
  }

  return (
    <div className="container mx-auto px-4 py-6 max-w-7xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-muted-foreground">
          Configure your dashboard settings and preferences.
        </p>
      </div>

      {isPreviewEnvironment && (
        <Alert className="mb-6">
          <Info className="h-4 w-4" />
          <AlertTitle>Preview Environment Detected</AlertTitle>
          <AlertDescription>
            You are running in a preview environment. Localhost URLs may not work here. For production use, configure a
            publicly accessible API host.
          </AlertDescription>
        </Alert>
      )}

      <Card className="ml-0 mr-auto max-w-2xl">
        <CardHeader>
          <CardTitle>API Host</CardTitle>
          <CardDescription>Configure the backend host for fetching infrastructure health metrics</CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent>
            <div className="grid w-full items-center gap-4">
              <div className="flex flex-col space-y-1.5">
                <Label htmlFor="apiHost">API Host</Label>
                <Input
                  id="apiHost"
                  placeholder="http://localhost:8000"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                />
                {isPreviewEnvironment && inputValue.includes("localhost") && (
                  <p className="text-sm text-amber-500 mt-1">
                    Note: This localhost host may not be accessible in this environment.
                  </p>
                )}
              </div>
            </div>
          </CardContent>
          <CardFooter className="flex justify-between">
            <Button variant="outline" type="button" onClick={handleReset}>
              Reset to Default
            </Button>
            <Button type="submit">Save Configuration</Button>
          </CardFooter>
        </form>
      </Card>
      <Toaster />
    </div>
  )
}
