import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { MetricsResponse, ProcessedMetric } from './types';

// Utility function for combining class names
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Process the metrics data from the API response
export function processMetricsData(response: MetricsResponse): ProcessedMetric[] {
  if (!response.data || !response.data.result) {
    return [];
  }

  return response.data.result.map(item => {
    const { spec, apiInterface } = item.metric;

    // Convert values from [timestamp, string] to TimeSeriesPoint
    const values = item.values.map(([timestamp, valueStr]) => ({
      timestamp: timestamp * 1000, // Convert to milliseconds
      value: Number.parseFloat(valueStr),
    }));

    return {
      spec,
      apiInterface,
      values,
    };
  });
}

// Add this function at the end of the file
// Generate mock data for demonstration when API is not available
export function generateMockData(): ProcessedMetric[] {
  const specs = ['NEAR', 'ETH', 'BTC', 'SOL'];
  const apiInterfaces = ['jsonrpc', 'rest', 'grpc'];
  const now = Date.now();
  const mockData: ProcessedMetric[] = [];

  // Generate data for the last 24 hours with 5-minute intervals
  const timePoints = 288; // 24 hours * 12 (5-minute intervals)
  const interval = 5 * 60 * 1000; // 5 minutes in milliseconds

  // Create metrics for each spec and API interface combination
  specs.forEach(spec => {
    apiInterfaces.forEach(apiInterface => {
      // Skip some combinations to make the data more realistic
      if (Math.random() > 0.7) return;

      const values = [];
      let currentHealth = Math.random() > 0.3 ? 1 : 0; // Start with mostly healthy

      // Generate time series data
      for (let i = 0; i < timePoints; i++) {
        const timestamp = now - (timePoints - i) * interval;

        // Occasionally change health status (10% chance)
        if (Math.random() < 0.1) {
          currentHealth = currentHealth === 1 ? 0 : 1;
        }

        values.push({
          timestamp,
          value: currentHealth,
        });
      }

      mockData.push({
        spec,
        apiInterface,
        values,
      });
    });
  });

  return mockData;
}
