// Types for the API response
export interface MetricsResponse {
  status: string
  data: {
    resultType: string
    result: MetricResult[]
  }
}

export interface MetricResult {
  metric: {
    __name__: string
    apiInterface: string
    spec: string
    [key: string]: string
  }
  values: [number, string][]
}

// Processed data types
export interface ProcessedMetric {
  spec: string
  apiInterface: string
  values: TimeSeriesPoint[]
}

export interface TimeSeriesPoint {
  timestamp: number
  value: number
}
