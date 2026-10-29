/* Sample answers for the Ask your data preview. Nothing here is read from a
 * store: the preview shows how a question, its steps and its answer will look,
 * so the backend can be built behind it (Bedrock, the client's MCP, budgets,
 * history, prompt logs - see docs/ASK-YOUR-DATA.md). The panel says so on
 * screen. Chains and providers are generic on purpose. */

export interface AnswerSection {
  title: string;
  body: string;
  /** Short facts under the body, in order. */
  points?: string[];
  /** One figure the section is about. */
  stat?: { value: string; label: string; tone?: "ok" | "warn" | "err" };
}

export interface SampleAnswer {
  /** One line that answers the question before any detail. */
  summary: string;
  sections: AnswerSection[];
  /** What the answer read: shown under it. */
  sources: string[];
  /** The steps the panel plays while it "works". */
  steps: { label: string; detail: string; ms: number }[];
  /** What the answer would have cost, in dollars. */
  cost: number;
}

const STEPS = (reads: string[]) => [
  { label: "Understanding the question", detail: "Picking the chains, the window and what to compare", ms: 700 },
  ...reads.map((r) => ({ label: "Reading your data", detail: r, ms: 900 })),
  { label: "Writing the answer", detail: "Numbered, with the figures it used", ms: 800 },
];

const ANSWERS: { match: RegExp; answer: SampleAnswer }[] = [
  {
    match: /fail|error|wrong|broke/i,
    answer: {
      summary: "Two chains had requests the router couldn't serve in the last 24 hours. Everything else was served.",
      sections: [
        {
          title: "Ethereum: 41 requests not served",
          body: "All between 14:10 and 14:25. Both providers answered with a server error at the same time, so there was no provider left to retry on.",
          stat: { value: "99.97%", label: "served", tone: "warn" },
        },
        {
          title: "Solana: 6 requests not served",
          body: "Spread over the day, each a `getBlock` for a block the providers didn't have yet.",
          points: ["Usually a block asked for a few seconds after it was produced", "Retrying after 2 seconds would have served all 6"],
          stat: { value: "99.99%", label: "served", tone: "ok" },
        },
        {
          title: "What to do",
          body: "Nothing on your side for Ethereum: it was a provider outage, and it ended by itself. For Solana, retry `getBlock` once after a short wait when the answer is \"block not found\".",
        },
      ],
      sources: ["Failed requests, 24 h", "Errors by chain and provider", "Router logs, 47 requests"],
      steps: STEPS(["Failed requests per chain · 24 hours", "The router's logs for those 47 requests"]),
      cost: 0.021,
    },
  },
  {
    match: /latenc|slow|fast|p95|speed/i,
    answer: {
      summary: "Latency is normal on every chain. One provider on Polygon is twice as slow as its peers since this morning.",
      sections: [
        {
          title: "Every chain is within its usual range",
          body: "P95 over the last hour compared with the same hour last week.",
          points: ["Ethereum 163 ms (last week 158 ms)", "Solana 742 ms (last week 760 ms)", "Polygon 225 ms (last week 210 ms)"],
        },
        {
          title: "Polygon: provider-b is slow",
          body: "Its P95 rose from 180 ms to 410 ms at 08:30 and has stayed there. The router sends it less traffic as a result, so clients barely see it.",
          stat: { value: "410 ms", label: "provider-b P95", tone: "warn" },
        },
      ],
      sources: ["P95 latency per chain, 1 h and last week", "P95 per provider, 12 h"],
      steps: STEPS(["Latency per chain · now and last week", "Latency per provider · 12 hours"]),
      cost: 0.014,
    },
  },
  {
    match: /provider|upstream|traffic|most|served/i,
    answer: {
      summary: "provider-a served the most requests in the last hour: 54% of all traffic.",
      sections: [
        {
          title: "Share of requests, last hour",
          body: "Across all chains, by the provider that answered.",
          points: ["provider-a · 54%", "provider-b · 31%", "Cache · 12%", "Backups · 3%"],
        },
        {
          title: "Backups took traffic on one chain",
          body: "On Ethereum, a backup answered 3% of requests between 14:10 and 14:25, while both primaries returned errors.",
          stat: { value: "3%", label: "served by backups", tone: "ok" },
        },
      ],
      sources: ["Requests per provider, 1 h", "Backup share, 1 h"],
      steps: STEPS(["Requests per provider · 1 hour"]),
      cost: 0.009,
    },
  },
];

const FALLBACK: SampleAnswer = {
  summary: "Your router served 99.99% of requests in the last 24 hours, with no chain below its 99.9% target.",
  sections: [
    { title: "Requests", body: "20.1 million requests across 43 chains.", stat: { value: "20.1M", label: "requests" } },
    { title: "Requests not served", body: "47 in total, 41 of them on Ethereum during one 15-minute provider outage.", stat: { value: "47", label: "not served", tone: "warn" } },
    { title: "Nothing needs action", body: "Every chain is back to normal, and no provider is unhealthy right now." },
  ],
  sources: ["Requests and failed requests, 24 h", "Provider health, now"],
  steps: STEPS(["Requests and failures · 24 hours", "Provider health · now"]),
  cost: 0.012,
};

export function sampleAnswer(question: string): SampleAnswer {
  return ANSWERS.find((a) => a.match.test(question))?.answer ?? FALLBACK;
}

export const SUGGESTIONS = [
  { title: "Did any requests fail today?", hint: "Errors by chain and provider" },
  { title: "Which provider served the most traffic?", hint: "Last hour, all chains" },
  { title: "Is latency normal right now?", hint: "Compared with last week" },
  { title: "Summarise the last 24 hours", hint: "Requests, failures, health" },
];

/** The preview's monthly budget, and what it has "spent" so far. */
export const SAMPLE_BUDGET = { limit: 10, spent: 3.42 };
