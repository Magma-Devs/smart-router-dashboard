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

/**
 * What happened to the requests that failed on a provider, chain-wide.
 *
 * A provider failing and a CALLER failing are different facts. The router
 * retries a request that got no answer on another provider, so "blockdaemon
 * gave no reply to 75%" can end in nothing reaching the caller at all, or in
 * every one of them failing. Only these two counters say which, and before
 * them the card could only write "we weren't told whether the router
 * retried" — which is the line the reader acts on, left blank.
 *
 * Null is "not measured on this deployment" (the family has never fired),
 * never zero.
 */
export interface ChainOutcome {
  /** Failed on one provider, succeeded when the router retried it on another. */
  recovered: number | null;
  /** Got no answer from any provider after every attempt. */
  failures: number | null;
  /** Client requests on the chain in the window — what `failures` is a share of. */
  requests: number | null;
  /**
   * Calls that need an add-on, by add-on: sent, and how many got no answer.
   * Empty when none were sent or the counters are absent.
   */
  addonCalls: AddonCalls[];
}

/** One kind of add-on call on one chain — `debug_*` or `trace_*`. */
export interface AddonCalls {
  addon: "debug" | "trace";
  sent: number;
  /** Got no answer from any provider after every attempt; null when unmeasured. */
  failed: number | null;
}

/**
 * A kind of request that cannot be served. Fewer than this many calls in the
 * window is a blip, not a verdict — one failed call of one sent says little.
 */
export const MIN_ADDON_CALLS = 3;

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
  /** Measured, not written — the numbers the severity was decided on. */
  outcome: ChainOutcome;
}

/**
 * Severity by whether what the caller sends can still be served. Omer,
 * 27 Sep: "does it make the chain inaccessible? If the system can fail over,
 * then it's not critical" — and "if there is a debug call and no provider can
 * serve it, it's critical, because the transaction can't be fulfilled."
 *
 *   critical  the chain cannot be served: every provider on it is failing, or
 *             at least half its requests got no answer after every retry. Or
 *             one KIND of request cannot be: at least half the debug (or
 *             trace) calls got no answer — reads may be fine, but a caller
 *             sending those calls has nothing that works.
 *   degraded  a provider is failing, slow or wrong, and the router still has
 *             somewhere to send traffic — even when some requests reached the
 *             caller as errors on the way.
 *   config    nothing is failing because of us or a provider; the setup or the
 *             caller's own requests are what to change.
 *
 * The line used to be "an error reached the caller". Measured in production
 * that put Critical over a card reading "nothing is failing for you right
 * now", and over a chain where the router saved half the failed requests.
 * A red badge on a chain that works teaches people to ignore red badges.
 *
 * No finding kind is critical by itself any more. Stale answers the router
 * caught, slow answers, and error answers from one provider all leave the
 * chain usable. Known gap: a chain where EVERY provider answers with an error
 * body, rather than no answer, is caught by neither test below — error bodies
 * count as transport successes. Rare; it would show as degraded.
 */
export const INACCESSIBLE_SHARE = 0.5;

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
 * in production, StarkNet's answered-error is 581 events of which every one is a
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

/** Share of the chain's requests that got no answer at all, or null when unmeasured. */
export function shareFailed(outcome?: Partial<Pick<ChainOutcome, "failures" | "requests">>): number | null {
  if (outcome?.failures == null || outcome.requests == null) return null;
  // The two counters are scraped apart, so failures can edge past requests.
  const of = Math.max(outcome.requests, outcome.failures);
  return of > 0 ? outcome.failures / of : null;
}

/** The kinds of add-on call on this chain that cannot be served. */
export function blockedAddons(outcome?: Partial<Pick<ChainOutcome, "addonCalls">>): AddonCalls[] {
  return (outcome?.addonCalls ?? []).filter(
    (a) => a.failed != null && a.sent >= MIN_ADDON_CALLS && a.failed / Math.max(a.sent, a.failed) >= INACCESSIBLE_SHARE,
  );
}

export function severityOf(
  findings: StatusFinding[],
  outcome?: Partial<ChainOutcome>,
): IssueSeverity {
  const ours = findings.filter((f) => !mostlyCallerSide(f));
  // The chain-down rule in status.ts: every configured provider was tried and
  // none served. Matched by its id, which status.ts keeps stable so the page
  // can key rows — the other `dead` finding ("no provider could answer" for
  // some requests) carries an upstream only when one dominates, so matching
  // on a null upstream would catch it on quiet chains.
  const everyProviderFailing = ours.some((f) => f.id.endsWith(":chain:down"));
  const share = shareFailed(outcome);
  if (everyProviderFailing || (share != null && share >= INACCESSIBLE_SHARE)) return "critical";
  if (blockedAddons(outcome).length > 0) return "critical";
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
   * identically wherever that client sends transactions — one deployment had 1,066 on
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
  /** Client requests on this chain in the window, when known. */
  requests: number | null;
  /** Debug / trace calls on this chain, when any were sent. */
  addonCalls?: AddonCalls[];
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

  1. What is failing, with the number — and WHICH provider, by name.
  2. Why — the cause.
  3. What happened to those requests: saved by a retry, or reached the caller.
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

## What happened to the failed requests

When you are given \`outcome\`, it is the most useful fact you have. It says how
many requests the router saved by retrying them on another provider
(savedByRetry) and how many still failed for the caller (reachedCaller).

  - reachedCaller is 0: the provider failed and the caller never saw it. Say
    so plainly: "The router retried every one on another provider; none
    reached you."
  - reachedCaller above 0: say how many still failed, out of totalRequests,
    and why the retry could not save them when the input shows why.
  - callsNeedingAnAddon, when given, splits out debug and trace calls. When
    most of one kind got no answer, that is the point to lead with.

reachedCaller counts requests that got NO answer. An error answer is not in
it — that went back to the caller as an error. So when a provider is answering
with errors, reachedCaller of 0 never means "no errors reached you".

Name the provider that took the retries only when exactly one other provider
is configured on the chain; otherwise write "another provider".

The outcome is for the whole chain. It does not say which problem caused each
failure, and savedByRetry of 0 does not mean a retry was even attempted:

  - Never write that the router retried unless savedByRetry is above 0.
  - Tie the failures to one cause only when the input gives exactly one.
    Otherwise put the two facts side by side and let the reader join them.

When there is no \`outcome\`, you were not told what the retries did. Say
nothing about it — not "we weren't told", not "it is unclear". A line about
what you do not know is a line the reader has to read for nothing.

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

The severity you are given follows ONE rule: can what they send still be
served. Critical means it cannot — every provider is failing, or at least half
the requests got no answer even after retries, or one kind of request cannot be
served at all: at least half of their debug (or trace) calls got no answer.
When it is that last one, say so by name: reads may work, but their debug calls
have no provider that can answer them. Degraded means the chain still
works: a provider is failing, slow or wrong, and the router has somewhere else
to send traffic, even if some requests reached the caller as errors. Config
means nothing is failing because of us or a provider.

Write a bottom line that agrees with that. On a critical issue, say plainly
that the chain is not usable right now, and why failover could not help. On a
degraded issue, say that it still works, and what did reach them, with the
number.

Plain language, addressed to them: "your requests", "your chain". No error
codes, no metric names, no internal vocabulary in the sentences.

Name the provider that is failing, every time. They hold the contract with it,
so "one of your providers" is a sentence they cannot act on.

Use the real error TEXT to understand what happened, then say it plainly. An
"UNKNOWN_ERROR" reading "Request timeout on the free plan, please upgrade" is
a provider account limit — write "tatum is rate-limiting you on its current
plan", not the raw string.

Never invent a number, provider, method or error that is not in the input.
Do not recommend a fix. Do not set a severity — it is decided for you.

## When the provider list is missing

\`providersConfigured\` is absent on a deployment with no values file mounted.
Absent is NOT empty: you do not know the roles, the addons, or whether a
failover existed — you do not know that there are none.

So write nothing about failover at all. Leave that point out and write a
shorter issue; two points that finish are better than four where two say you
were not told something. In particular:

  - Never write "no providers are configured" or "no backup exists". You were
    not given the list. Naming a provider in one point and denying the list
    exists in another is the card contradicting itself.
  - Never spend the bottom line on what you could not check. It is the one
    line that has to say whether they can work.
  - Never write that you were not told something. Leave it out.

## Your answer

Reply with ONLY a JSON object, no prose around it, no markdown fence:

{
  "title": "One line: the issue, in their terms.",
  "points": ["one fact", "one fact", "one fact"],
  "bottomLine": "One sentence: can they work."
}`;

/**
 * What each finding kind means, in the model's terms. The kind decides the
 * severity, so a model that cannot see it writes a bottom line that argues
 * with the badge above it.
 */
const KIND_MEANING: Record<StatusFinding["kind"], string> = {
  dead: "this provider gave no answer (timeout or dropped connection); whether the caller felt it is in `outcome`",
  "answered-error": "this provider answered with an error, and that error went back to the caller",
  "answered-stale": "this provider answered from a block behind the chain's head; the headline says whether the router caught it",
  "answered-late": "this provider's answers arrived, but slowly",
  "answered-unchecked": "nothing verified that these answers were current",
  "no-backup": "serving fine, with nothing to fail over to if it stops",
  config: "a request for something no provider here serves, or the caller's own request rejected by the chain",
};

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
      //
      // OMITTED when empty, never sent as []. No values file mounted means we
      // do not know the roster; an empty array reads as "this chain has no
      // providers", and the model duly wrote "no providers are configured for
      // Solana" one line under two points naming them. The key being absent
      // is what the prompt is told to stay quiet about.
      ...(i.configured.length ? { providersConfigured: i.configured } : {}),
      whatWeMeasured: i.findings.map((f) => ({
        upstream: f.upstream,
        whatItMeans: KIND_MEANING[f.kind],
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
      // Omitted, not null, when unmeasured — the same reason as the provider
      // list: a null the model can see is a null it writes a sentence about.
      ...(i.recovered == null && i.failures == null
        ? {}
        : {
            outcome: {
              note: "Chain-wide, this window. totalRequests: client requests. savedByRetry: got no answer from one provider and went through on another. reachedCaller: got no answer from ANY provider after every attempt. An error ANSWER is not in reachedCaller — it went back to the caller as an error. null = not measured.",
              totalRequests: i.requests,
              savedByRetry: i.recovered,
              reachedCaller: i.failures,
              ...(i.addonCalls?.length
                ? {
                    callsNeedingAnAddon: i.addonCalls.map((a) => ({
                      kind: `${a.addon}_* calls`,
                      sent: a.sent,
                      gotNoAnswer: a.failed,
                    })),
                  }
                : {}),
            },
          }),
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
      severity: severityOf(inputs.findings, {
        failures: inputs.failures,
        requests: inputs.requests,
        addonCalls: inputs.addonCalls ?? [],
      }),
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
      outcome: {
        recovered: inputs.recovered,
        failures: inputs.failures,
        requests: inputs.requests,
        addonCalls: inputs.addonCalls ?? [],
      },
      lastSeenUnix:
        inputs.findings.reduce<number | null>(
          (newest, f) => (f.lastSeenUnix && (!newest || f.lastSeenUnix > newest) ? f.lastSeenUnix : newest),
          null,
        ),
    };
  }
}
