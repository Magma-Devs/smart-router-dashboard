import { apiClient } from '@/lib/api-client';

interface PromInstantResponse {
  status: string;
  data: {
    resultType: string;
    result: Array<{ metric: Record<string, string>; value: [number, string] }>;
  };
}

interface PromRangeResponse {
  status: string;
  data: {
    resultType: string;
    result: Array<{ metric: Record<string, string>; values: Array<[number, string]> }>;
  };
}

interface PromErrorEntry {
  status: 'error';
  errorType: string;
  error: string;
}

export interface ExportResult {
  filename: string;
  total: number;
  succeeded: number;
  failed: number;
  failedMetrics: string[];
}

function calcStep(minutes: number): string {
  if (minutes <= 60) return '5s';
  if (minutes <= 360) return '30s';
  if (minutes <= 1440) return '2m';
  if (minutes <= 10080) return '15m';
  return '1h';
}

function toErrorEntry(e: unknown): PromErrorEntry {
  return {
    status: 'error',
    errorType: e instanceof Error ? e.name : typeof e,
    error: e instanceof Error ? e.message : String(e),
  };
}

async function fetchMetricWithRetry(
  name: string,
  minutes: number,
  step: string,
  retries: number,
): Promise<PromRangeResponse | PromErrorEntry> {
  const url = `/api/metrics/last_minutes?query=${encodeURIComponent(name)}&minutes=${minutes}&step=${step}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await apiClient.get<PromRangeResponse>(url);
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        // Small backoff with jitter to avoid hammering the backend on retry.
        const delay = 250 + Math.floor(Math.random() * 250);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  return toErrorEntry(lastErr);
}

async function fetchAllMetrics(
  names: string[],
  minutes: number,
  step: string,
  concurrency: number,
  retries: number,
): Promise<Record<string, PromRangeResponse | PromErrorEntry>> {
  const out: Record<string, PromRangeResponse | PromErrorEntry> = {};
  let idx = 0;
  const runners = Array.from({ length: Math.min(concurrency, names.length) }, async () => {
    while (idx < names.length) {
      const i = idx++;
      const name = names[i];
      out[name] = await fetchMetricWithRetry(name, minutes, step, retries);
    }
  });
  await Promise.all(runners);
  return out;
}

export async function exportLavaMetrics(timeFrame: string, minutes: number): Promise<ExportResult> {
  const discoveryQuery = `group by (__name__) (last_over_time({__name__=~"(smartrouter|rpc)_.*"}[${timeFrame}]))`;
  const discovery = await apiClient.get<PromInstantResponse>(
    `/api/metrics/instant?query=${encodeURIComponent(discoveryQuery)}`,
  );

  const metricNames = Array.from(
    new Set(
      (discovery.data?.result || []).map(r => r.metric?.__name__).filter((n): n is string => !!n),
    ),
  ).sort();

  if (metricNames.length === 0) {
    throw new Error(`No smartrouter_* / rpc_* metrics found for the last ${timeFrame}`);
  }

  const step = calcStep(minutes);
  const metrics = await fetchAllMetrics(metricNames, minutes, step, 6, 1);

  const failedMetrics = metricNames.filter(
    name => (metrics[name] as PromErrorEntry | undefined)?.status === 'error',
  );

  const payload = {
    exported_at: new Date().toISOString(),
    time_frame: timeFrame,
    window_minutes: minutes,
    step,
    metric_count: metricNames.length,
    metric_names: metricNames,
    metrics,
  };

  const jsonBlob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const gzStream = jsonBlob.stream().pipeThrough(new CompressionStream('gzip'));
  const gzBlob = await new Response(gzStream).blob();

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `smartrouter-metrics-${timeFrame}-${ts}.json.gz`;
  const url = URL.createObjectURL(gzBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return {
    filename,
    total: metricNames.length,
    succeeded: metricNames.length - failedMetrics.length,
    failed: failedMetrics.length,
    failedMetrics,
  };
}
