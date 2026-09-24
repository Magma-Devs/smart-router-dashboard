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
import type { StatusFinding, StatusInsight } from "@sr/shared";
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
   * The facts, one per line, in causal order. Two to four, never more.
   *
   * Numbered one-liners rather than four labelled paragraphs, because that is
   * how this team already writes them in Slack and the paragraphs read as an
   * essay nobody finishes. Each point is ONE fact.
   *
   * All of them render — there is no disclosure — so the cap is not a display
   * detail, it is the length of the card.
   */
  points: string[];
  /** One sentence: can they work. The line that decides an escalation. */
  bottomLine: string;
  /**
   * Still happening as of the last read, from the findings behind it.
   *
   * The difference between "act now" and "read this later", and the page had
   * no way to say it — every card looked equally live.
   */
  ongoing: boolean;
  /** Every chain this issue covers — one for most, several when merged. */
  specs: string[];
  /** The findings this rests on, validated against the report. */
  findingIds: string[];
  /** Newest activity across those findings — what the by-time order reads. */
  lastSeenUnix: number | null;
}

/**
 * Severity by CUSTOMER IMPACT, not by a threshold being crossed.
 *
 * The tier on a finding says a rate went over a line — 5% errors is critical,
 * 1-5% degraded. That produced a red badge above "your requests are still
 * getting through" and an amber one above "your chain is fine", which is how
 * a status page teaches people to ignore its badges.
 *
 * The question that should decide the colour is whether the caller felt it:
 *
 *   critical  they got an error, a timeout, or bad data. The router did not
 *             save them. Worst case, nothing on this chain works at all.
 *   degraded  it still works, but worse — the router is absorbing something,
 *             or there is a risk it will not be able to next time.
 *   config    nothing is failing because of us or the provider. The setup or
 *             the caller's own requests are what to change.
 *
 * `FindingKind` already encodes exactly this, because the rules were written
 * around "what reached the caller" in the first place — `answered-error` IS
 * an error in the body the caller received, while `no-backup` is "serving
 * fine, nowhere to go if it stops". Reading the kind rather than the rate is
 * what lines the badge up with the sentence under it.
 */
const REACHED_THE_CALLER: ReadonlyArray<StatusFinding["kind"]> = [
  "dead", // nothing served it — the request died
  "answered-error", // an error in the body they got back
];

// `answered-late` is deliberately NOT here either. It is a latency percentile
// crossing a line, not a proven failure — the answer arrived. Measured on GK8
// it produced "Slow answers on Tezos, but no confirmed failures" under a red
// badge, which is the contradiction this whole ladder exists to remove. Slow
// is "works, but worse": degraded.

// `answered-stale` is deliberately NOT here. Its own headline reads "3 stale
// answers caught" — the consistency check REJECTED those answers, so nothing
// wrong reached anybody. That is the system working, and colouring it critical
// puts a red badge on the one mechanism that prevented harm.

/**
 * An error the CHAIN produced answering correctly, not a failure of ours.
 *
 * `answered-error` covers both "the provider fell over" and "the chain refused
 * a transaction whose nonce was too low", so the kind alone cannot decide.
 * CHAIN_ and USER_ codes are the caller's; everything else is ours.
 */
const CALLER_SIDE = /^(CHAIN|USER)_/;

/**
 * Is this finding mostly the caller's doing?
 *
 * By EVENT COUNT, not by which codes appear. Presence was not enough: measured
 * on GK8, StarkNet's answered-error is 581 events of which every one is a
 * CHAIN_STARKNET_* rejection, while Ethereum's is 28 CHAIN_TX_REJECTED against
 * 22 NODE_SERVER_ERROR. Reading the list rather than the counts made the first
 * critical — a red badge over "your requests are working fine".
 *
 * Without counts, fall back to the codes themselves; a finding with neither
 * counts as ours, because silence is not evidence the caller was at fault.
 */
function mostlyCallerSide(f: StatusFinding): boolean {
  const counts = f.codeCounts;
  if (counts && Object.keys(counts).length > 0) {
    let theirs = 0;
    let total = 0;
    for (const [code, n] of Object.entries(counts)) {
      total += n;
      if (CALLER_SIDE.test(code)) theirs += n;
    }
    return total > 0 && theirs / total > 0.5;
  }
  return f.codes.length > 0 && f.codes.every((c) => CALLER_SIDE.test(c));
}

export function severityOf(findings: StatusFinding[]): IssueSeverity {
  const ours = findings.filter((f) => !mostlyCallerSide(f));
  if (ours.some((f) => REACHED_THE_CALLER.includes(f.kind))) return "critical";
  if (ours.some((f) => f.kind !== "config")) return "degraded";
  return "config";
}

export interface FormulatedInputs {
  spec: string;
  chain: string;
  /**
   * Other chains carrying the SAME caller-side problem, folded in.
   *
   * Nonce and funds rejections are the client's own doing, so they recur
   * identically wherever that client sends transactions — GK8 had 1,066 on
   * Ethereum, 254 on Polygon and 79 on Base, rendered as three cards saying
   * one thing. One problem, one fix, one card.
   */
  alsoOnChains?: { spec: string; chain: string; findings: StatusFinding[] }[];
  findings: StatusFinding[];
  errorGroups: ErrorGroup[];
  configured: { upstream: string; role: "primary" | "backup" | null; addons: string[] }[];
  /**
   * Week-over-week drift on this chain. Not a finding — nothing has crossed a
   * line — but "this provider is 5x slower than it was last week" is the
   * sentence that turns a degraded issue into one worth acting on, and it had
   * nowhere to appear once the Insights tab went.
   */
  insights: StatusInsight[];
  /** Requests the router recovered by retrying on this chain, when known. */
  recovered: number | null;
  /** Final customer failures on this chain, when known. */
  failures: number | null;
}

const CROSS_CHAIN_NOTE = `

## This one spans several chains

You are given more than one chain because the SAME problem is happening on all
of them, and it is the caller's own requests that are being rejected — not any
provider. Write ONE issue about that, not one per chain.

Name the chains and give the total. "Your signing code is reusing nonces: 1,399
transactions rejected across Ethereum, Base and Polygon" is the issue. Three
cards each saying the same thing about one chain is the thing this replaces.`;

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

Copy that. **One fact per point. One sentence per point. Under 14 words.**
Two to four points — never more, and fewer when fewer will do. Every point is
on screen at once, with no "show more" to hide behind: a fourth point costs
the reader the first three.

Do NOT write paragraphs. Do not stack three clauses into one point. Do not
quote raw error strings in parentheses; say what the error MEANS in your own
short words.

## What the points must walk, in this order

  1. What is failing, with the number.
  2. Why — the cause.
  3. What the router did: did it retry, did it have somewhere to go.
  4. Why the failover did or did not save it. This is the one people act on.

Not every issue needs all four. Stop when the chain is told — three points
that finish the story beat four padded to look thorough.

**Never write the title again as a point.** The title is on screen directly
above them. If the title already names what is failing and the number, start
at the cause.

Drift against last week, when given, is worth one point — a provider several
times slower than its own past is a different story from one that is simply
slow. Use the numbers as given.

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

Say it in different words from the point it came from. A bottom line that
repeats point four verbatim has made the card longer without making it
clearer.

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

The severity you are given follows ONE rule: critical means the caller felt it
— they got an error, a timeout, or bad data, and the router did not save them.
Degraded means it still works and the router is absorbing something. Config
means nothing is failing because of us or the provider.

Write a bottom line that agrees with that. On a critical issue, name what the
caller actually got. Never write "your requests are still getting through" on
one — if that is genuinely true, the finding behind it is not critical and you
should say what DID reach them instead.

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
      ...(i.alsoOnChains?.length
        ? {
            sameProblemOnTheseChainsToo: i.alsoOnChains.map((c) => ({
              chain: c.chain,
              whatWeMeasured: c.findings.map((f) => `${f.headline} (${f.metric.value} ${f.metric.label})`),
            })),
          }
        : {}),
      // Roles and addons: an addon only one provider declares is why a failure
      // there has nowhere to go, which is the answer to question three.
      providersConfigured: i.configured,
      whatWeMeasured: i.findings.map((f) => ({
        upstream: f.upstream,
        headline: f.headline,
        metric: `${f.metric.value} ${f.metric.label}`,
        ongoing: f.ongoing,
      })),
      driftAgainstLastWeek: i.insights.map((x) => ({
        upstream: x.upstream,
        headline: x.headline,
        now: x.value,
        weekEarlier: x.baseline,
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
      // The cross-chain instruction is appended only when it applies, so a
      // single-chain issue is never told about a shape it cannot produce.
      system: inputs.alsoOnChains?.length ? SYSTEM_PROMPT + CROSS_CHAIN_NOTE : SYSTEM_PROMPT,
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
      specs: [inputs.spec, ...(inputs.alsoOnChains ?? []).map((c) => c.spec)],
      ongoing: [...inputs.findings, ...(inputs.alsoOnChains ?? []).flatMap((c) => c.findings)].some(
        (f) => f.ongoing === true,
      ),
      title: str("title"),
      // Capped here as well as in the prompt: a model that ignores "two to
      // four" must not turn the card back into the essay this replaced. Four,
      // not five — every point renders, so the cap IS what the reader sees.
      points: (Array.isArray(parsed.points) ? parsed.points : [])
        .filter((x): x is string => typeof x === "string" && x.trim() !== "")
        .slice(0, 4),
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
