"use client"

import type React from "react"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { useLocalStorage } from "@/hooks/use-local-storage"
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
  const [apiUrl, setApiUrl] = useLocalStorage(
    "api-url",
    "http://localhost:8000/api/metrics/last_minutes?query=lava_provider_overall_health_breakdown",
  )
  const [refreshInterval, setRefreshInterval] = useLocalStorage("refresh-interval", "60")
  const [inputValue, setInputValue] = useState(apiUrl)
  const [isPreviewEnvironment, setIsPreviewEnvironment] = useState(false)

  useEffect(() => {
    setInputValue(apiUrl)
    // Check if we're in a preview environment
    if (typeof window !== "undefined") {
      setIsPreviewEnvironment(window.location.hostname !== "localhost")
    }
  }, [apiUrl])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    // Basic validation
    if (!inputValue.trim()) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "API URL cannot be empty",
      })
      return
    }

    try {
      const url = new URL(inputValue)

      // Warn about localhost URLs in non-localhost environments
      if ((url.hostname === "localhost" || url.hostname === "127.0.0.1") && isPreviewEnvironment) {
        toast({
          variant: "warning",
          title: "Warning",
          description: "Localhost URLs may not be accessible in preview/deployed environments.",
        })
      }

      setApiUrl(inputValue)
      toast({
        title: "Configuration saved",
        description: "Your API endpoint has been updated successfully",
      })
      router.push("/")
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Invalid URL",
        description: "Please enter a valid URL",
      })
    }
  }

  const handleReset = () => {
    const defaultUrl = "http://localhost:8000/api/metrics/last_minutes?query=lava_provider_overall_health_breakdown"
    setInputValue(defaultUrl)
    setApiUrl(defaultUrl)
    toast({
      title: "Configuration reset",
      description: "API endpoint has been reset to default",
    })
  }

  const handleRefreshIntervalChange = (value: string) => {
    setRefreshInterval(value)
    toast({
      title: "Refresh interval updated",
      description: `Data will now refresh every ${value === "1" ? "second" : value + " seconds"}`,
    })
  }

  return (
    <div className="container mx-auto px-4 py-6">
      <h1 className="text-3xl font-bold mb-6">Configuration Wizard</h1>

      {isPreviewEnvironment && (
        <Alert className="mb-6">
          <Info className="h-4 w-4" />
          <AlertTitle>Preview Environment Detected</AlertTitle>
          <AlertDescription>
            You are running in a preview environment. Localhost URLs may not work here. For production use, configure a
            publicly accessible API endpoint.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>API Configuration</CardTitle>
            <CardDescription>Configure the backend endpoint for fetching infrastructure health metrics</CardDescription>
          </CardHeader>
          <form onSubmit={handleSubmit}>
            <CardContent>
              <div className="grid w-full items-center gap-4">
                <div className="flex flex-col space-y-1.5">
                  <Label htmlFor="apiUrl">API Endpoint URL</Label>
                  <Input
                    id="apiUrl"
                    placeholder="Enter API endpoint URL"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                  />
                  {isPreviewEnvironment && inputValue.includes("localhost") && (
                    <p className="text-sm text-amber-500 mt-1">
                      Note: This localhost URL may not be accessible in this environment.
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

        <Card>
          <CardHeader>
            <CardTitle>Refresh Settings</CardTitle>
            <CardDescription>Configure how frequently the dashboard refreshes data</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid w-full items-center gap-4">
              <div className="flex flex-col space-y-1.5">
                <Label htmlFor="refresh-interval">Refresh Interval</Label>
                <Select value={refreshInterval} onValueChange={handleRefreshIntervalChange}>
                  <SelectTrigger id="refresh-interval">
                    <SelectValue placeholder="Select interval" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 second</SelectItem>
                    <SelectItem value="5">5 seconds</SelectItem>
                    <SelectItem value="10">10 seconds</SelectItem>
                    <SelectItem value="30">30 seconds</SelectItem>
                    <SelectItem value="60">1 minute</SelectItem>
                    <SelectItem value="300">5 minutes</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
      <Toaster />
    </div>
  )
}
