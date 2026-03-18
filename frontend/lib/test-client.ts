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
  crossValidationMaxParticipants?: number;
  crossValidationAgreementThreshold?: number;
  /**
   * Maximum number of response bytes to read for HTTP requests (streaming).
   * This prevents debug/trace payloads from OOM-crashing the browser.
   */
  maxResponseBytes?: number;
  /**
   * Maximum number of characters to keep for WebSocket responses.
   * WebSocket payloads are delivered as a single message, so this is a char cap.
   */
  maxResponseChars?: number;
}

export interface TestResponse {
  status_code: number;
  latency_ms: number;
  success: boolean;
  response_data: any;
  headers: Record<string, string>;
  error?: string;
  /** Whether the client truncated the response payload for safety. */
  truncated?: boolean;
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

const DEFAULT_MAX_HTTP_RESPONSE_BYTES = 256 * 1024; // 256KB
const DEFAULT_MAX_WS_RESPONSE_CHARS = 200_000; // 200k chars

function truncateStringByChars(
  input: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (maxChars <= 0) return { text: '', truncated: input.length > 0 };
  if (input.length <= maxChars) return { text: input, truncated: false };
  return { text: input.slice(0, maxChars), truncated: true };
}

/**
 * Read response text with a hard byte limit using streaming.
 * This avoids loading massive debug/trace payloads into memory.
 */
async function readTextWithLimit(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean; bytesRead: number }> {
  const clampMax = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;

  // If no body stream is available, fall back to response.text() then truncate by bytes.
  if (!response.body || typeof response.body.getReader !== 'function') {
    const full = await response.text();
    const encoder = new TextEncoder();
    const bytes = encoder.encode(full);
    if (clampMax > 0 && bytes.length > clampMax) {
      // Approximate truncation by characters; safe enough for UI display.
      // (Exact byte truncation would require re-encoding per slice.)
      const approxChars = Math.max(1, Math.floor((full.length * clampMax) / bytes.length));
      const { text } = truncateStringByChars(full, approxChars);
      return { text, truncated: true, bytesRead: clampMax };
    }
    return { text: full, truncated: false, bytesRead: bytes.length };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      // Enforce byte cap before decoding to avoid buffering too much.
      if (clampMax > 0 && bytesRead + value.byteLength > clampMax) {
        const remaining = clampMax - bytesRead;
        if (remaining > 0) {
          chunks.push(decoder.decode(value.subarray(0, remaining), { stream: true }));
          bytesRead += remaining;
        }
        truncated = true;
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        break;
      }

      bytesRead += value.byteLength;
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    try {
      chunks.push(decoder.decode());
    } catch {
      // ignore
    }
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  return { text: chunks.join(''), truncated, bytesRead };
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
  maxResponseChars?: number,
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    let statusCode = 0;
    let responseData: any = null;
    let errorMessage: string | undefined = undefined;
    const responseHeaders: Record<string, string> = {};
    let truncated = false;
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
        // WebSocket payloads can be huge (debug/trace). Keep as string and cap size.
        const raw = typeof event.data === 'string' ? event.data : String(event.data);
        const cap = maxResponseChars ?? DEFAULT_MAX_WS_RESPONSE_CHARS;
        const res = truncateStringByChars(raw, cap);
        responseData = res.text;
        truncated = res.truncated;
        statusCode = 200; // WebSocket message received successfully

        ws.close();
        resolve({
          status_code: statusCode,
          latency_ms: latencyMs,
          success: true,
          response_data: responseData,
          headers: responseHeaders,
          ...(truncated ? { truncated: true } : {}),
        });
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
          ...(truncated ? { truncated: true } : {}),
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
            ...(truncated ? { truncated: true } : {}),
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
    crossValidationMaxParticipants,
    crossValidationAgreementThreshold,
    maxResponseBytes,
    maxResponseChars,
  } = options;

  const startTime = performance.now();
  const chainIdLower = chainId.toLowerCase();

  // Handle WebSocket connections for jsonrpc/wss and tendermintrpc/wss
  if (
    interfaceType === 'jsonrpc/wss' ||
    interfaceType === 'jsonrpc-wss' ||
    interfaceType === 'tendermintrpc/wss' ||
    interfaceType === 'tendermintrpc-wss'
  ) {
    // Determine the base interface type for URL construction
    const baseInterface = interfaceType.includes('jsonrpc') ? 'jsonrpc' : 'tendermintrpc';
    const curlHost = `${chainIdLower}-${baseInterface}.${domain}`;
    const wsUrl = `wss://${curlHost}:${port}/websocket`;

    try {
      return await makeWebSocketRequest(
        wsUrl,
        interfaceCommand,
        startTime,
        skipCache,
        requestType,
        maxResponseChars,
      );
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
  const curlHost = `${chainIdLower}-${interfaceType}.${domain}`;
  let url = `https://${curlHost}:${port}`;

  // Initialize with defaults (network error state)
  let statusCode = 0;
  let latencyMs = 0;
  let responseData: any = null;
  let errorMessage: string | undefined = undefined;
  const responseHeaders: Record<string, string> = {};
  let truncated = false;

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

    // Add cross-validation headers
    if (crossValidationMaxParticipants !== undefined) {
      headers['lava-cross-validation-max-participants'] = crossValidationMaxParticipants.toString();
    }
    if (crossValidationAgreementThreshold !== undefined) {
      headers['lava-cross-validation-agreement-threshold'] =
        crossValidationAgreementThreshold.toString();
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

    // Read response body with a hard cap to prevent OOM on debug/trace payloads.
    try {
      const capBytes = maxResponseBytes ?? DEFAULT_MAX_HTTP_RESPONSE_BYTES;
      const read = await readTextWithLimit(response, capBytes);
      responseData = read.text;
      truncated = read.truncated;
    } catch {
      // If body read fails, responseData remains null
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
    ...(truncated ? { truncated: true } : {}),
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

// ============================================================================
// BATCH REQUEST TYPES AND FUNCTIONS
// ============================================================================

export interface BatchRequestItem {
  id: number;
  method: string;
  params: any;
}

export interface BatchRequestOptions {
  chainId: string;
  domain?: string;
  port?: string;
  skipCache?: boolean;
  maxResponseBytes?: number;
  addonType?: 'none' | 'archive' | 'debug' | 'trace';
}

export interface BatchResponseItem {
  id: number;
  method: string;
  success: boolean;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface BatchResponse {
  status_code: number;
  latency_ms: number;
  success: boolean;
  headers: Record<string, string>;
  responses: BatchResponseItem[];
  error?: string;
  truncated?: boolean;
}

/**
 * Makes a batch JSON-RPC request (multiple calls in a single HTTP request)
 */
export async function makeBatchRequest(
  options: BatchRequestOptions,
  requests: BatchRequestItem[],
): Promise<BatchResponse> {
  const {
    chainId,
    domain = 'lava.lavapro.xyz',
    port = '443',
    skipCache = false,
    maxResponseBytes,
    addonType = 'none',
  } = options;

  const startTime = performance.now();
  const chainIdLower = chainId.toLowerCase();
  const curlHost = `${chainIdLower}-jsonrpc.${domain}`;
  const url = `https://${curlHost}:${port}`;

  // Build batch request payload
  const batchPayload = requests.map(req => ({
    jsonrpc: '2.0',
    id: req.id,
    method: req.method,
    params: req.params,
  }));

  let statusCode = 0;
  let latencyMs = 0;
  let responseData: any[] = [];
  let errorMessage: string | undefined = undefined;
  const responseHeaders: Record<string, string> = {};
  let truncated = false;

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (skipCache) {
      headers['lava-force-cache-refresh'] = 'true';
    }

    // Add lava-extension header for addon types
    if (addonType && addonType !== 'none') {
      headers['lava-extension'] = addonType;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(batchPayload),
      mode: 'cors',
      signal: AbortSignal.timeout(60000),
    });

    statusCode = response.status;

    try {
      latencyMs = await getRequestLatency(url, startTime);
    } catch {
      latencyMs = performance.now() - startTime;
    }

    // Read response body
    try {
      const capBytes = maxResponseBytes ?? DEFAULT_MAX_HTTP_RESPONSE_BYTES * 2; // Larger cap for batch
      const read = await readTextWithLimit(response, capBytes);
      truncated = read.truncated;

      try {
        responseData = JSON.parse(read.text);
        // Ensure responseData is an array
        if (!Array.isArray(responseData)) {
          responseData = [responseData];
        }
      } catch {
        responseData = [];
        errorMessage = 'Failed to parse batch response';
      }
    } catch {
      responseData = [];
      errorMessage = 'Failed to read response body';
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
    errorMessage = error instanceof Error ? error.message : 'Unknown error';
    try {
      latencyMs = await getRequestLatency(url, startTime);
    } catch {
      latencyMs = performance.now() - startTime;
    }
  }

  // Map responses to our format
  const batchResponses: BatchResponseItem[] = requests.map(req => {
    const matchingResponse = responseData.find((r: any) => r.id === req.id);
    if (!matchingResponse) {
      return {
        id: req.id,
        method: req.method,
        success: false,
        error: { code: -1, message: 'No response received for this request' },
      };
    }

    if (matchingResponse.error) {
      return {
        id: req.id,
        method: req.method,
        success: false,
        error: matchingResponse.error,
      };
    }

    return {
      id: req.id,
      method: req.method,
      success: true,
      result: matchingResponse.result,
    };
  });

  const allSuccess = batchResponses.every(r => r.success) && statusCode >= 200 && statusCode < 300;

  return {
    status_code: statusCode,
    latency_ms: latencyMs,
    success: allSuccess,
    headers: responseHeaders,
    responses: batchResponses,
    ...(errorMessage && { error: errorMessage }),
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * Makes multiple batch requests for load testing
 */
export async function makeBatchLoadTestRequests(
  options: BatchRequestOptions,
  requests: BatchRequestItem[],
  numberOfBatches: number,
  concurrency: number = 5,
): Promise<BatchResponse[]> {
  const results: BatchResponse[] = new Array(numberOfBatches);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const current = nextIndex;
      if (current >= numberOfBatches) return;
      nextIndex = current + 1;
      results[current] = await makeBatchRequest(options, requests);
    }
  }

  const workerCount = Math.min(concurrency, Math.max(1, numberOfBatches));
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Calculates statistics from batch load test responses
 */
export function calculateBatchLoadTestStats(responses: BatchResponse[], methods: string[]) {
  const latencies = responses.map(r => r.latency_ms);
  const successfulBatches = responses.filter(r => r.success).length;
  const totalBatches = responses.length;
  const batchSuccessRate = (successfulBatches / totalBatches) * 100;

  // Calculate latency statistics for overall batches
  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const min = Math.min(...latencies);
  const max = Math.max(...latencies);
  const avg = latencies.reduce((sum, lat) => sum + lat, 0) / latencies.length;
  const p50 = calculatePercentile(sortedLatencies, 50);
  const p90 = calculatePercentile(sortedLatencies, 90);
  const p95 = calculatePercentile(sortedLatencies, 95);

  // Calculate per-method statistics
  const methodStats: Record<
    string,
    {
      method: string;
      total: number;
      successful: number;
      failed: number;
      successRate: number;
    }
  > = {};

  methods.forEach(method => {
    methodStats[method] = {
      method,
      total: 0,
      successful: 0,
      failed: 0,
      successRate: 0,
    };
  });

  responses.forEach(batchResponse => {
    batchResponse.responses.forEach(itemResponse => {
      const stats = methodStats[itemResponse.method];
      if (stats) {
        stats.total++;
        if (itemResponse.success) {
          stats.successful++;
        } else {
          stats.failed++;
        }
      }
    });
  });

  // Calculate success rates
  Object.values(methodStats).forEach(stats => {
    if (stats.total > 0) {
      stats.successRate = (stats.successful / stats.total) * 100;
    }
  });

  // Count cached vs non-cached
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
        providerDistribution[providerValue] = (providerDistribution[providerValue] || 0) + 1;
      }
    } else {
      nonCachedCount++;
      providerDistribution['unknown'] = (providerDistribution['unknown'] || 0) + 1;
    }
  });

  return {
    batch_success_rate: batchSuccessRate,
    total_batches: totalBatches,
    successful_batches: successfulBatches,
    failed_batches: totalBatches - successfulBatches,
    latency_stats: {
      min,
      max,
      avg,
      p50,
      p90,
      p95,
    },
    method_stats: methodStats,
    cached_count: cachedCount,
    non_cached_count: nonCachedCount,
    provider_distribution: providerDistribution,
    responses,
  };
}

/**
 * Generates a cURL command for a batch request with readable formatting
 */
export function generateBatchCurlCommand(
  chainId: string,
  domain: string,
  port: string,
  requests: BatchRequestItem[],
  skipCache: boolean = false,
  addonType: 'none' | 'archive' | 'debug' | 'trace' = 'none',
): string {
  const chainIdLower = chainId.toLowerCase();
  const curlHost = `${chainIdLower}-jsonrpc.${domain}`;
  const url = `https://${curlHost}:${port}`;

  const batchPayload = requests.map(req => ({
    jsonrpc: '2.0',
    id: req.id,
    method: req.method,
    params: req.params,
  }));

  const headerParts: string[] = [];
  if (skipCache) {
    headerParts.push('-H "lava-force-cache-refresh: true"');
  }
  if (addonType && addonType !== 'none') {
    headerParts.push(`-H "lava-extension: ${addonType}"`);
  }
  const headers = headerParts.length > 0 ? headerParts.join(' ') + ' ' : '';

  // Format each request on its own line for readability
  const formattedPayload =
    '[\n' + batchPayload.map(req => '  ' + JSON.stringify(req)).join(',\n') + '\n]';

  return `curl -X POST ${headers}-H "Content-Type: application/json" \\\n  ${url} \\\n  -d '${formattedPayload}'`;
}
