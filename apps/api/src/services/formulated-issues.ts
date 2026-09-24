/**
 * The formulated issue: what a customer reads first, in the order they ask.
 *
 * The page today shows a row per rule that crossed a line. That answers "what
 * did we measure". The question actually being asked is a sequence:
 *
 *   I have errors on my chain          → whatHappened
 *   Why?                               → whyItHappened
 *   Did it move to another provider?   → whatTheRouterTried
 *   So can I work or not?              → impact
 *
 * The fourth is the one nothing on the page answers today, and it is the only
 * one that decides whether someone escalates. "tatum is at 39% errors" does
 * not say whether traffic is being served; "both providers timed out, so these
 * calls are failing outright" does.
 *
 * Severity is NOT the model's to choose. It comes from the findings' own tier,
 * because the page already has one vocabulary for it — over 5% is critical,
 * 1-5% degraded, structural is config — and a model re-deriving that would
 * quietly produce a second scale that disagrees with the rows beneath it.
 */
import type { StatusFinding } from "@sr/shared";
import type { ErrorGroup } from "./loki.js";
import { BedrockService, parseModelJson, type BedrockLogger } from "./bedrock.js";

export type IssueSeverity = "critical" | "degraded" | "config";

export interface FormulatedIssue {
  severity: IssueSeverity;
  spec: string;
  chain: string;
  /** One line, addressed to the person whose traffic this is. */
  title: string;
  /** The symptom, in their terms. */
  whatHappened: string;
  /** The cause, from the error text and the config. */
  whyItHappened: string;
  /**
   * Whether the router failed over, and what happened when it did. The step
   * people ask for immediately and the page never answers.
   */
  whatTheRouterTried: string;
  /** Can they work. The line that decides whether this gets escalated. */
  impact: string;
  /** The findings this rests on, validated against the report. */
  findingIds: string[];
  /** Newest activity across those findings — what the by-time order reads. */
  lastSeenUnix: number | null;
}

/** The tier a chain's worst finding carries, mapped to the page's own words. */
export function severityOf(findings: StatusFinding[]): IssueSeverity {
  if (findings.some((f) => f.tier === "critical")) return "critical";
  if (findings.some((f) => f.tier === "attention")) return "degraded";
  return "config";
}

export interface FormulatedInputs {
  spec: string;
  chain: string;
  findings: StatusFinding[];
  errorGroups: ErrorGroup[];
  configured: { upstream: string; role: "primary" | "backup" | null; addons: string[] }[];
  /** Requests the router recovered by retrying on this chain, when known. */
  recovered: number | null;
  /** Final customer failures on this chain, when known. */
  failures: number | null;
}

const SYSTEM_PROMPT = `You write the issue statement a customer reads first about their own chain.

The Magma Devs Smart Router sits in front of raw blockchain RPC endpoints and
multiplexes across them. For one client request it picks an upstream provider,
relays, and may retry or hedge to another. "Provider", "upstream" and
"endpoint" all mean the node the router relays TO. A provider is configured as
primary or backup, and declares addons (archive, debug, trace) saying what it
can serve.

## Who is reading and what they ask

Someone whose traffic runs on this chain. They ask, in this order:

  1. I am getting errors on my chain.     → whatHappened
  2. Why?                                  → whyItHappened
  3. Did it move to another provider?      → whatTheRouterTried
  4. So can I work, or not?                → impact

Answer those four, in those words, in that order. Number three and four are
the ones nothing else tells them, so do not skimp on either.

## Number three is the important one

They want to know whether the router did its job. Say whether it retried,
whether it had somewhere to go, and what happened when it got there:

  - "The router retried on blockdaemon, the backup, and those calls succeeded."
  - "Both providers timed out, so the retry had nowhere better to land."
  - "lava is the only provider here that declares debug, so when it failed
     these calls had no second option — tatum and blockdaemon do not serve it."

The configured providers and their addons are given to you. An addon only one
provider declares means a failure there CANNOT fail over, and that is the most
useful sentence you can write.

If the input does not say what the retry did, say so plainly rather than
assuming it worked or did not.

## Number four decides whether someone escalates

"Can I work" is the point. Be concrete:

  - "Read calls are being served normally; only debug traces are failing."
  - "Roughly 4 in 10 requests on this chain are failing outright."
  - "Nothing is failing outright — the router is absorbing this, but it is
     working harder than usual to do it."

## Rules

Plain language, addressed to them. "your requests", "your chain". No error
codes in the sentences, no metric names, no internal vocabulary.

Use the real error TEXT you are given. It is far more specific than a code —
an "UNKNOWN_ERROR" reading "Request timeout on the free plan, please upgrade"
is a provider account problem and the code says none of that.

Never invent a number, a provider, a method or an error that is not in the
input. Do not recommend a fix. Do not set a severity — it is decided for you.

## Your answer

Reply with ONLY a JSON object, no prose around it, no markdown fence:

{
  "title": "One line naming the issue, in their terms.",
  "whatHappened": "The symptom.",
  "whyItHappened": "The cause.",
  "whatTheRouterTried": "Whether it failed over, where, and what happened.",
  "impact": "Whether they can work."
}`;

export function digestForIssue(i: FormulatedInputs): string {
  return JSON.stringify(
    {
      chain: { spec: i.spec, name: i.chain },
      // Roles and addons: an addon only one provider declares is why a failure
      // there has nowhere to go, which is the answer to question three.
      providersConfigured: i.configured,
      whatWeMeasured: i.findings.map((f) => ({
        upstream: f.upstream,
        headline: f.headline,
        metric: `${f.metric.value} ${f.metric.label}`,
        ongoing: f.ongoing,
      })),
      routerRecoveredByRetry: i.recovered,
      finalCustomerFailures: i.failures,
      errorsFromLogs: {
        note: "A SAMPLE of recent error lines, not every failure. Read them for WHICH errors and their mix; take totals from the numbers above.",
        groups: i.errorGroups.map((g) => ({
          code: g.errorName,
          count: g.count,
          methods: g.methods.slice(0, 5),
          text: g.example.slice(0, 220),
          provider: g.provider,
        })),
      },
    },
    null,
    1,
  );
}

export class FormulatedIssueService {
  constructor(
    private readonly bedrock: BedrockService,
    private readonly logger?: BedrockLogger,
  ) {}

  async formulate(inputs: FormulatedInputs): Promise<FormulatedIssue> {
    const answer = await this.bedrock.complete({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: digestForIssue(inputs) }],
      maxTokens: 2000,
    });
    const parsed = parseModelJson(answer, "issue statement", this.logger);
    const str = (k: string): string => (typeof parsed[k] === "string" ? (parsed[k] as string) : "");

    return {
      // From the findings, never from the model — the page already owns this
      // vocabulary and a second scale would disagree with the rows beneath.
      severity: severityOf(inputs.findings),
      spec: inputs.spec,
      chain: inputs.chain,
      title: str("title"),
      whatHappened: str("whatHappened"),
      whyItHappened: str("whyItHappened"),
      whatTheRouterTried: str("whatTheRouterTried"),
      impact: str("impact"),
      findingIds: inputs.findings.map((f) => f.id),
      lastSeenUnix:
        inputs.findings.reduce<number | null>(
          (newest, f) => (f.lastSeenUnix && (!newest || f.lastSeenUnix > newest) ? f.lastSeenUnix : newest),
          null,
        ),
    };
  }
}
