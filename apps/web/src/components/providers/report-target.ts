/** What the provider report opens on: a chain row's Report button, or a bar on one of the provider's graphs. */
export interface ReportTarget {
  providerId: string;
  providerName: string;
  spec: string;
  /** A graph bar's span, unix ms. Absent: the page's window. */
  range?: { from: number; to: number };
  /** Chains to choose from, worst first - a graph bar covers every chain. */
  chains?: string[];
}
