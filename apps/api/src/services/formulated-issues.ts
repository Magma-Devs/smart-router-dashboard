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
  /** "You have an issue with X" — one line. */
  title: string;
  /**
   * The facts, one per line, in causal order. Three to five, never more.
   *
   * Numbered one-liners rather than four labelled paragraphs, because that is
   * how this team already writes them in Slack and the paragraphs read as an
   * essay nobody finishes. Each point is ONE fact.
   */
  points: string[];
  /** One sentence: can they work. The line that decides an escalation. */
  bottomLine: string;
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

const SYSTEM_PROMPT = `You write the one-screen issue a customer reads about their own chain.

The Magma Devs Smart Router sits in front of raw blockchain RPC endpoints and
multiplexes across them. For one client request it picks an upstream provider,
relays, and may retry or hedge to another. "Provider", "upstream" and
"endpoint" all mean the node the router relays TO. A provider is configured as
primary or backup and declares addons (archive, debug, trace) saying what it
can serve.

## How this team writes

Short numbered facts, then a bottom line. Real example of theirs:

  1. There were 6 failures out of 3,310 requests, which is 0.18%.
  2. All 6 were POST /transactions.
  3. Tatum was the only eligible provider.
  4. Tatum did not answer within 7 seconds.
  5. No backup was available, so all 6 failed completely.
  Bottom line: Tatum was slow again, and with one eligible provider and no
  retry for stateful calls, that keeps reaching customers.

Copy that. **One fact per point. One sentence per point. Under 20 words.**
Three to five points — never more, and fewer when fewer will do.

Do NOT write paragraphs. Do not stack three clauses into one point. Do not
quote raw error strings in parentheses; say what the error MEANS in your own
short words.

## What the points must walk, in this order

  1. What is failing, with the number.
  2. Why — the cause.
  3. What the router did: did it retry, did it have somewhere to go.
  4. Why the failover did or did not save it. This is the one people act on.

Not every issue needs all four. Stop when the chain is told.

The configured providers and their addons are given to you. An addon only one
provider declares means a failure there CANNOT fail over, and that is the most
useful point you can write. Say it in one line:

  "lava is the only provider here that serves debug, so those calls had no
   second option."

## The bottom line

One sentence: can they work, AND why it is as bad as its severity says. A
bottom line that only restates the symptom has not earned its place — the
severity is already on screen, so say what makes it that severity.

  - "About 3 in 10 requests fail outright: the router does try the backups,
     but both are down, so there is nowhere for a retry to go."
  - "Read calls are fine; only debug traces fail, and only because lava is the
     one provider that serves them."
  - "Nothing is failing — the router is absorbing it, but it is retrying more
     than usual to do so."

The pattern in each: the impact, then the ONE fact that explains why it is not
merely annoying. Usually that fact is about failover.

## Never leave a phrase the reader has to decode

Our own shorthand is not plain language. Write what it MEANS:

  - not "mostly no reply"     -> "the node accepted the request and then never
                                  answered before the timeout"
  - not "rate-limited"        -> "the provider refused the calls because the
                                  account is over its request limit"
  - not "stale answers"       -> "answers from a block behind the chain's head,
                                  which the router threw away"
  - not "malformed responses" -> "replies with neither a result nor an error in
                                  them, which the router cannot use"

If a point would make someone ask "what does that actually mean?", it is not
finished.

## Rules

Plain language, addressed to them: "your requests", "your chain". No error
codes, no metric names, no internal vocabulary in the sentences.

Use the real error TEXT to understand what happened, then say it plainly. An
"UNKNOWN_ERROR" reading "Request timeout on the free plan, please upgrade" is
a provider account limit — write "tatum is rate-limiting you on its current
plan", not the raw string.

Never invent a number, provider, method or error that is not in the input. If
the input does not say what a retry did, say so in one short point rather than
assuming. Do not recommend a fix. Do not set a severity — it is decided for you.

## Your answer

Reply with ONLY a JSON object, no prose around it, no markdown fence:

{
  "title": "One line: the issue, in their terms.",
  "points": ["one fact", "one fact", "one fact"],
  "bottomLine": "One sentence: can they work."
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
      // Capped here as well as in the prompt: a model that ignores "three to
      // five" must not turn the card back into the essay this replaced.
      points: (Array.isArray(parsed.points) ? parsed.points : [])
        .filter((x): x is string => typeof x === "string" && x.trim() !== "")
        .slice(0, 5),
      bottomLine: str("bottomLine"),
      findingIds: inputs.findings.map((f) => f.id),
      lastSeenUnix:
        inputs.findings.reduce<number | null>(
          (newest, f) => (f.lastSeenUnix && (!newest || f.lastSeenUnix > newest) ? f.lastSeenUnix : newest),
          null,
        ),
    };
  }
}
