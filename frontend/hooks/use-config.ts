"use client"

import { useState, useEffect } from "react"
import { useLocalStorage } from "@/hooks/use-local-storage"

interface Config {
  apiEndpoint: string
  refreshInterval: number
}

export function useConfig() {
  // Initialize with the environment variable or null
  const [apiHost, setApiHost] = useLocalStorage<string | null>("api-host", process.env.NEXT_PUBLIC_API_URL || null)
  const [refreshInterval, setRefreshInterval] = useLocalStorage<number>("refresh-interval", 60)

  // Initialize the API host only once if it's null
  useEffect(() => {
    if (apiHost === null) {
      const defaultEndpoint = process.env.NEXT_PUBLIC_API_URL
      if (defaultEndpoint) {
        console.log("Initializing API host with environment variable:", defaultEndpoint)
        setApiHost(defaultEndpoint)
      }
    }
  }, [apiHost, setApiHost])

  const updateApiEndpoint = (value: string) => {
    console.log("Updating API endpoint to:", value)
    // Ensure the host doesn't end with a slash
    const cleanHost = value.replace(/\/+$/, '')
    setApiHost(cleanHost)
  }

  const updateRefreshInterval = (value: number) => {
    console.log("Updating refresh interval to:", value)
    setRefreshInterval(value)
  }

  const resetConfig = () => {
    console.log("Resetting config to defaults")
    const defaultEndpoint = process.env.NEXT_PUBLIC_API_URL
    if (defaultEndpoint) {
      setApiHost(defaultEndpoint)
    }
    setRefreshInterval(60)
  }

  return {
    config: {
      apiEndpoint: apiHost || process.env.NEXT_PUBLIC_API_URL || "",
      refreshInterval: typeof refreshInterval === 'string' ? parseInt(refreshInterval, 10) : refreshInterval,
    },
    updateApiEndpoint,
    updateRefreshInterval,
    resetConfig,
    apiHost,
    setApiHost,
  }
} 