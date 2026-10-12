/** Keep the configured dashboard URL intact, including Grafana's query variables. */
export function normalizeGrafanaDashboardUrl(value: string | null | undefined): string | null {
  const url = value?.trim();
  if (!url || !/^https?:\/\//i.test(url)) return null;

  try {
    const parsed = new URL(url);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && !parsed.username && !parsed.password
      ? url
      : null;
  } catch {
    return null;
  }
}
