"use client"

import { useState, useEffect } from "react"
import { useLocalStorage } from "./use-local-storage"

interface Config {
  apiEndpoint: string
  refreshInterval: number
}

export function useConfig() {
  // Use the same local storage keys as the configuration page
  const [apiHost, setApiHost] = useLocalStorage<string>("api-host", "http://dashboard-api.lava.infra:8080")
  const [refreshInterval, setRefreshInterval] = useLocalStorage<number>("refresh-interval", 60)

  useEffect(() => {
    console.log("Config initialized with:", { apiHost, refreshInterval })
  }, [apiHost, refreshInterval])

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
    setApiHost("http://dashboard-api.lava.infra:8080")
    setRefreshInterval(60)
  }

  // Initialize the API host if it's empty
  useEffect(() => {
    if (!apiHost) {
      console.log("Initializing empty API host")
      setApiHost("http://dashboard-api.lava.infra:8080")
    }
  }, [apiHost, setApiHost])

  return {
    config: {
      apiEndpoint: apiHost || "http://dashboard-api.lava.infra:8080",
      refreshInterval: typeof refreshInterval === 'string' ? parseInt(refreshInterval, 10) : refreshInterval,
    },
    updateApiEndpoint,
    updateRefreshInterval,
    resetConfig,
  }
} 