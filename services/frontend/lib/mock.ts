import type { ProcessedMetric } from "./types"

// Generate mock data for demonstration when API is not available
export function generateMockData(): ProcessedMetric[] {
  const specs = ["NEAR", "ETH", "BTC", "SOL"]
  const apiInterfaces = ["jsonrpc", "rest", "grpc"]
  const now = Date.now()
  const mockData: ProcessedMetric[] = []

  // Generate data for the last 24 hours with 5-minute intervals
  const timePoints = 288 // 24 hours * 12 (5-minute intervals)
  const interval = 5 * 60 * 1000 // 5 minutes in milliseconds

  // Create metrics for each spec and API interface combination
  for (const spec of specs) {
    // For each spec, create 1-3 API interfaces
    const numInterfaces = 1 + Math.floor(Math.random() * 3)
    const selectedInterfaces = apiInterfaces.sort(() => 0.5 - Math.random()).slice(0, numInterfaces)

    for (const apiInterface of selectedInterfaces) {
      const values = []
      let currentHealth = Math.random() > 0.3 ? 1 : 0 // Start with mostly healthy

      // Generate time series data
      for (let i = 0; i < timePoints; i++) {
        const timestamp = now - (timePoints - i) * interval

        // Occasionally change health status (10% chance)
        if (Math.random() < 0.1) {
          currentHealth = currentHealth === 1 ? 0 : 1
        }

        values.push({
          timestamp,
          value: currentHealth,
        })
      }

      mockData.push({
        spec,
        apiInterface,
        values,
      })
    }
  }

  return mockData
}
