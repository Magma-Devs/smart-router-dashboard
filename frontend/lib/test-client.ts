/**
 * Frontend HTTP client for making direct requests to provider endpoints
 */

export interface TestRequestOptions {
  chainId: string;
  interface: string;
  interfaceCommand: string;
  domain?: string;
  port?: string;
  skipCache?: boolean;
  requestType?: string; // Add request type parameter
  quorumMin?: number;
  quorumMax?: number;
  quorumRate?: number;
}

export interface TestResponse {
  status_code: number;
  latency_ms: number;
  success: boolean;
  response_data: any;
  headers: Record<string, string>;
  error?: string;
}

/**
 * Return latency (ms) using manual timing primarily,
 * falling back to a valid PerformanceResourceTiming entry when available.
 */
async function getRequestLatency(url: string, startTime: number): Promise<number> {
  const manual = () => performance.now() - startTime;

  try {
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    if (!entries || entries.length === 0) return manual();

    const normalize = (u: string) => u.replace(/\/$/, '').replace(/:\d+$/, '');
    const target = normalize(url);
    const host = new URL(url).host;

    // Most recent matching entry
    const match = [...entries].reverse().find(e => {
      const name = normalize(e.name);
      return name === target || name.includes(host);
    });

    if (!match) return manual();
    if (!match.requestStart || match.requestStart <= 0) return manual();

    const perfLatency = match.responseEnd - match.requestStart; // ms
    return perfLatency > 0 ? perfLatency : manual();
  } catch {
    return manual();
  }
}

/**
 * Makes a WebSocket request for JSON-RPC/WSS
 */
async function makeWebSocketRequest(
  url: string,
  interfaceCommand: string,
  startTime: number,
  skipCache: boolean,
  requestType?: string,
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    let statusCode = 0;
    let responseData: any = null;
    let errorMessage: string | undefined = undefined;
    const responseHeaders: Record<string, string> = {};
    let ws: WebSocket;

    try {
      // Create WebSocket connection
      ws = new WebSocket(url);

      // Set a connection timeout
      const connectTimeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket connection timeout'));
      }, 30000);

      ws.onopen = () => {
        clearTimeout(connectTimeout);
        try {
          // Parse the command to add any necessary headers/extensions
          const command = JSON.parse(interfaceCommand);

          // Add extensions if needed
          if (requestType && ['archive', 'trace', 'debug'].includes(requestType)) {
            command.extensions = { [requestType]: true };
          }

          // Send the JSON-RPC request
          ws.send(JSON.stringify(command));
        } catch (error) {
          ws.close();
          reject(error);
        }
      };

      ws.onmessage = event => {
        const latencyMs = performance.now() - startTime;
        try {
          responseData = JSON.parse(event.data);
          statusCode = 200; // WebSocket message received successfully

          ws.close();
          resolve({
            status_code: statusCode,
            latency_ms: latencyMs,
            success: true,
            response_data: responseData,
            headers: responseHeaders,
          });
        } catch (error) {
          ws.close();
          reject(new Error('Failed to parse WebSocket response'));
        }
      };

      ws.onerror = () => {
        const latencyMs = performance.now() - startTime;
        statusCode = 0;
        errorMessage = 'WebSocket connection error';

        resolve({
          status_code: statusCode,
          latency_ms: latencyMs,
          success: false,
          response_data: responseData,
          headers: responseHeaders,
          error: errorMessage,
        });
      };

      ws.onclose = event => {
        const latencyMs = performance.now() - startTime;
        if (!event.wasClean && statusCode === 0) {
          errorMessage = `WebSocket closed unexpectedly: ${event.reason || 'Unknown reason'}`;
          resolve({
            status_code: statusCode,
            latency_ms: latencyMs,
            success: false,
            response_data: responseData,
            headers: responseHeaders,
            error: errorMessage,
          });
        }
      };
    } catch (error) {
      const latencyMs = performance.now() - startTime;
      reject(error);
    }
  });
}

/**
 * Makes a single test request directly to a provider endpoint
 */
export async function makeTestRequest(options: TestRequestOptions): Promise<TestResponse> {
  const {
    chainId,
    interface: interfaceType,
    interfaceCommand,
    domain = 'lava.lavapro.xyz',
    port = '443',
    skipCache = false,
    requestType,
    quorumMin,
    quorumMax,
    quorumRate,
  } = options;

  const startTime = performance.now();

  // Handle WebSocket connections for jsonrpc/wss and tendermintrpc/wss
  if (
    interfaceType === 'jsonrpc/wss' ||
    interfaceType === 'jsonrpc-wss' ||
    interfaceType === 'tendermintrpc/wss' ||
    interfaceType === 'tendermintrpc-wss'
  ) {
    // Determine the base interface type for URL construction
    const baseInterface = interfaceType.includes('jsonrpc') ? 'jsonrpc' : 'tendermintrpc';
    const curlHost = `${chainId}-${baseInterface}.${domain}`;
    const wsUrl = `wss://${curlHost}:${port}/websocket`;

    try {
      return await makeWebSocketRequest(wsUrl, interfaceCommand, startTime, skipCache, requestType);
    } catch (error) {
      const latencyMs = performance.now() - startTime;
      return {
        status_code: 0,
        latency_ms: latencyMs,
        success: false,
        response_data: null,
        headers: {},
        error: error instanceof Error ? error.message : 'WebSocket error',
      };
    }
  }

  // Build the URL (moved outside try block for error handling)
  const curlHost = `${chainId}-${interfaceType}.${domain}`;
  let url = `https://${curlHost}:${port}`;

  // Initialize with defaults (network error state)
  let statusCode = 0;
  let latencyMs = 0;
  let responseData: any = null;
  let errorMessage: string | undefined = undefined;
  const responseHeaders: Record<string, string> = {};

  try {
    let method: string;
    let body: string | undefined;

    // Handle different interface types
    if (interfaceType === 'rest') {
      // For REST, check if it has a path (GET) or method (POST)
      const commandData = JSON.parse(interfaceCommand);
      if (commandData.path) {
        // REST GET with path (e.g., Aptos, TON, TRON)
        const path = commandData.path;
        url = `${url}${path}`;
        method = 'GET';
        body = undefined;
      } else {
        // REST POST with JSON body (e.g., XRP)
        method = 'POST';
        body = interfaceCommand;
      }
    } else {
      // For other interfaces, use POST with interfaceCommand as body
      method = 'POST';
      body = interfaceCommand;
    }

    // Prepare headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add cache refresh header if skip_cache is enabled
    if (skipCache) {
      headers['lava-force-cache-refresh'] = 'true';
    }

    // Add lava-extension header based on request type
    if (requestType && ['archive', 'trace', 'debug'].includes(requestType)) {
      headers['lava-extension'] = requestType;
    }

    // Add quorum headers for cross validation
    if (quorumMin !== undefined) {
      headers['lava-quorum-min'] = quorumMin.toString();
    }
    if (quorumMax !== undefined) {
      headers['lava-quorum-max'] = quorumMax.toString();
    }
    if (quorumRate !== undefined) {
      headers['lava-quorum-rate'] = quorumRate.toString();
    }

    // Make the request
    const response = await fetch(url, {
      method,
      headers,
      body,
      mode: 'cors',
      signal: AbortSignal.timeout(60000),
    });

    statusCode = response.status;

    try {
      latencyMs = await getRequestLatency(url, startTime);
    } catch {
      latencyMs = performance.now() - startTime;
    }

    // Parse response data
    const contentType = response.headers.get('content-type') || '';
    try {
      if (contentType.startsWith('application/json')) {
        try {
          responseData = await response.json();
        } catch (jsonError) {
          responseData = await response.text();
        }
      } else {
        responseData = await response.text();
      }
    } catch {
      // If parsing fails, responseData remains null
    }

    // Convert headers to plain object
    try {
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
    } catch {
      // If headers parsing fails, responseHeaders remains empty
    }
  } catch (error) {
    // Network error - statusCode already initialized to 0
    errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Try to get latency even for failed requests
    try {
      latencyMs = await getRequestLatency(url, startTime);
    } catch {
      latencyMs = performance.now() - startTime;
    }
  }

  // Single return point
  return {
    status_code: statusCode,
    latency_ms: latencyMs,
    success: statusCode >= 200 && statusCode < 300,
    response_data: responseData,
    headers: responseHeaders,
    ...(errorMessage && { error: errorMessage }),
  };
}

/**
 * Makes multiple parallel test requests for load testing
 */
export async function makeLoadTestRequests(
  options: TestRequestOptions,
  numberOfRequests: number,
  concurrency: number = 5,
): Promise<TestResponse[]> {
  const results: TestResponse[] = new Array(numberOfRequests);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const current = nextIndex;
      if (current >= numberOfRequests) return;
      nextIndex = current + 1;
      results[current] = await makeTestRequest(options);
    }
  }

  const workerCount = Math.min(concurrency, Math.max(1, numberOfRequests));
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Measures latency for multiple URLs in controlled batches to avoid resource competition
 * @param urls Array of URL strings to test
 * @param batchSize Number of requests to send in parallel per batch (default: 5)
 * @returns Array of latency measurements in milliseconds
 */
export async function measureBatchedLatencies(
  urls: string[],
  batchSize: number = 5,
): Promise<number[]> {
  const latencies: number[] = [];

  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize);
    const batchPromises = batch.map(async url => {
      const start = performance.now();
      try {
        await fetch(url, {
          method: 'GET',
          mode: 'cors',
          signal: AbortSignal.timeout(60000),
        });
      } finally {
        return performance.now() - start;
      }
    });

    const batchLatencies = await Promise.all(batchPromises);
    latencies.push(...batchLatencies);

    console.log(
      `Batch ${Math.floor(i / batchSize) + 1}: ${batchLatencies.map(l => l.toFixed(2)).join(', ')} ms`,
    );
  }

  console.log('--- Batched Latency Measurement Results ---');
  latencies.forEach((latency, index) => {
    const url = urls[index];
    console.log(`⏱️ ${url}: ${latency.toFixed(2)} ms`);
  });

  return latencies;
}

/**
 * Calculates statistics from multiple test responses
 */
export function calculateLoadTestStats(responses: TestResponse[]) {
  const latencies = responses.map(r => r.latency_ms);
  const successfulCount = responses.filter(r => r.success).length;
  const totalRequests = responses.length;
  const successRate = (successfulCount / totalRequests) * 100;

  // Calculate latency statistics
  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const min = Math.min(...latencies);
  const max = Math.max(...latencies);
  const avg = latencies.reduce((sum, lat) => sum + lat, 0) / latencies.length;

  // Calculate percentiles
  const p50 = calculatePercentile(sortedLatencies, 50);
  const p90 = calculatePercentile(sortedLatencies, 90);
  const p95 = calculatePercentile(sortedLatencies, 95);

  // Count cached vs non-cached responses and track provider distribution
  let cachedCount = 0;
  let nonCachedCount = 0;
  const providerDistribution: Record<string, number> = {};

  responses.forEach(response => {
    const headers = response.headers || {};
    const providerHeader = Object.keys(headers).find(
      key => key.toLowerCase() === 'lava-provider-address',
    );
    const providerValue = providerHeader ? headers[providerHeader] : null;

    if (providerValue) {
      if (providerValue.toLowerCase() === 'cached') {
        cachedCount++;
        providerDistribution['cached'] = (providerDistribution['cached'] || 0) + 1;
      } else {
        nonCachedCount++;
        // Track actual provider addresses
        const provider = providerValue.toString();
        providerDistribution[provider] = (providerDistribution[provider] || 0) + 1;
      }
    } else {
      nonCachedCount++;
      // No provider header - just count as non-cached
      providerDistribution['unknown'] = (providerDistribution['unknown'] || 0) + 1;
    }
  });

  return {
    success_rate: successRate,
    total_requests: totalRequests,
    successful_requests: successfulCount,
    failed_requests: totalRequests - successfulCount,
    latency_stats: {
      min,
      max,
      avg,
      p50,
      p90,
      p95,
    },
    cached_count: cachedCount,
    non_cached_count: nonCachedCount,
    provider_distribution: providerDistribution,
    responses,
  };
}

/**
 * Helper function to calculate percentiles
 */
function calculatePercentile(sortedArray: number[], percentile: number): number {
  if (sortedArray.length === 0) return 0;

  const index = (percentile / 100) * (sortedArray.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index % 1;

  if (upper >= sortedArray.length) {
    return sortedArray[sortedArray.length - 1];
  }

  return sortedArray[lower] * (1 - weight) + sortedArray[upper] * weight;
}
