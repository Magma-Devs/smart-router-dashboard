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
import { providerName } from "./provider-names.js";

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
  /**
   * Transactions: the methods the router itself flags as writes, sent, and
   * how many failed the caller after every retry. Null when the chain sent
   * none or nothing says which methods are writes.
   */
  writes: WriteCalls | null;
  /**
   * How the failed requests went through the router, traced from its log:
   * the provider each one tried first, the backup it moved to, how each
   * attempt ended. Grouped by path — six requests that all went "alchemy
   * timed out → quicknode timed out" are one row of six, not "3 on one
   * provider and 2 others". Null without the logs or without failures.
   */
  paths: FailurePaths | null;
  /**
   * Requests the chain itself refused (a nonce already used, an account
   * without funds), one per request, from the router's log. Null without the
   * logs, or when the chain refused nothing.
   */
  rejected: RefusedRequests | null;
}

export interface RefusedRequests {
  /** Distinct requests — not provider replies, which count each one twice on a chain with two primaries. */
  requests: number;
  /** By the chain's own reason code. */
  byCode: Record<string, number>;
  /**
   * Of the refused transactions checked, how many had been sent before — the
   * same signed transaction, earlier — and the most times one had been.
   */
  resent: { checked: number; resent: number; mostSends: number } | null;
  /** The newest few, for matching a caller's own log. */
  latest: { id: string; atUnix: number }[];
}

export interface FailurePaths {
  /** Requests traced — a sample in a bad hour, when fewer than failed. */
  traced: number;
  /** Most common first. */
  groups: FailurePath[];
}

/** Every traced request that went one way through the router. */
export interface FailurePath {
  count: number;
  /**
   * `tatum ✕ no answer → +7s blockdaemon (backup) ✕ timed out → failed` —
   * each step at its typical time across these requests.
   */
  flow: string;
  /** The same path without its times: what requests are grouped by, and what the fingerprint keys on. */
  route: string;
  /** The methods that went this way, most common first. */
  methods: string[];
  /** Fastest and slowest, from the request arriving to its final answer. */
  seconds: [number, number];
  /** The providers that failed on this path, in the order they were tried — who "Who acts" names, and what "many chains at once" looks for in common. */
  failedOn: string[];
  /** The newest few requests that went this way: what a caller's own log shows. */
  ids: { id: string; atUnix: number }[];
  /** The router's own error names for them ("PROTOCOL_CONTEXT_DEADLINE"). */
  errors: string[];
}

export interface WriteCalls {
  sent: number;
  /** Failed the caller, once per request, from the router's final-result log; null without it. */
  failed: number | null;
}

/** One kind of add-on call on one chain — `debug_*` or `trace_*`. */
export interface AddonCalls {
  addon: "debug" | "trace";
  sent: number;
  /**
   * Calls the caller got no usable answer to: error replies plus no-answer
   * attempts, minus the ones a retry saved. Null when unmeasured.
   *
   * Error replies count because they are how "no provider can serve this"
   * actually arrives — "the method does not exist" comes back as an answer,
   * so the final-result log calls it a success. Measured in production: one
   * chain's nodes returned 40,580 errors to 82,469 debug calls in a day, and
   * the router saved none of them.
   */
  failed: number | null;
  /** Of `failed`, the error replies. */
  errorReplies: number | null;
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
  /**
   * The chain's numbers as one line, written by code — `impactOf`. Printed
   * above the points with the time it covers. Null when nothing was measured.
   */
  impact: string | null;
  /** The time the numbers cover: the window of the cycle that last read them. */
  measured: { fromUnix: number; toUnix: number } | null;
  /**
   * Written from the measurements alone, without the model — it failed, or a
   * cycle's writing budget ran out. The next cycle writes it properly.
   */
  plain?: true;
  /**
   * A provider is failing and the router covered every request: nothing
   * failed, nothing came back as an error, no answer was left slow behind a
   * timeout. Shown without colour — amber on a chain that works every day
   * teaches people to ignore amber.
   */
  handled: boolean;
  /** Who can act on it, in one line — never how to fix it. Written by code. */
  whoActs: string | null;
  /** Error names a caller's own log would show, for matching it to this card. */
  codes: string[];
  /** Several chains failing at once — written by code, not the model. */
  together?: true;
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
 *             trace) calls got no usable answer — none, or an error reply no
 *             retry replaced — or at least half the transactions failed.
 *             Reads may be fine, but a caller sending those has nothing that
 *             works: "can't transact" is critical.
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

/** Transactions that cannot be sent: at least half failed the caller. */
export function writesBlocked(outcome?: Partial<Pick<ChainOutcome, "writes">>): boolean {
  const w = outcome?.writes;
  return w?.failed != null && w.sent >= MIN_ADDON_CALLS && w.failed / Math.max(w.sent, w.failed) >= INACCESSIBLE_SHARE;
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
  if (blockedAddons(outcome).length > 0 || writesBlocked(outcome)) return "critical";
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
  /** Transactions on this chain, when any were sent. */
  writes?: WriteCalls | null;
  /** The failed requests' paths through the router, when traced. */
  paths?: FailurePaths | null;
  /** The time the numbers above cover. */
  measured?: { fromUnix: number; toUnix: number } | null;
  /** Requests the chain refused, per request, from the router's log. */
  rejected?: RefusedRequests | null;
  /**
   * The version already on the customer's screen, when this issue is still
   * open. Given so a rewrite UPDATES the issue rather than writing a new one
   * with a new title for the same problem.
   */
  previous?: Pick<FormulatedIssue, "title" | "points" | "bottomLine">;
}

const CROSS_CHAIN_NOTE = `

## This one spans several chains

You are given more than one chain because the SAME problem is happening on all
of them: the chain refused the requests themselves, and every provider got
the same answer. Write ONE issue about that, not one per chain.

Name the chains; the total is printed above your points. "The same
transactions are being sent again on Ethereum, Base and Polygon" is the
issue, when the resend check says so. Three cards each saying the same thing
about one chain is the thing this replaces.`;

const SYSTEM_PROMPT = `You write the one-screen issue a customer reads about their own chain.

The Magma Devs Smart Router sits in front of raw blockchain RPC endpoints and
multiplexes across them. For one client request it picks an upstream provider,
relays, and may retry or hedge to another. "Provider", "upstream" and
"endpoint" all mean the node the router relays TO. A provider is configured as
primary or backup and declares addons (archive, debug, trace) saying what it
can serve.

## How this team writes

Short numbered facts, then a bottom line. Real example of theirs — its first
line, the chain's numbers, is one the card now prints for you (below):

  Printed: 6 of 3,310 requests (0.18%) failed: no provider answered them.
  1. All 6 were POST /transactions.
  2. Tatum was the only eligible provider.
  3. Tatum did not answer within 7 seconds.
  4. No backup was available for these calls.
  Bottom line: Tatum was slow again, and with one eligible provider and no
  retry for stateful calls, that keeps reaching customers.

Copy that. **One fact per point. One sentence per point. Under 14 words.**
Two to four points — never more, and fewer when fewer will do. Every point is
on screen at once, with no "show more" to hide behind: a fourth point costs
the reader the first three.

Do NOT write paragraphs. Do not stack three clauses into one point. Do not
quote raw error strings in parentheses; say what the error MEANS in your own
short words.

## The line above your points

The card prints the chain's numbers itself, in one line above your points,
with the time they cover. \`shownAboveYourPoints\` is that line: how many
requests failed, how many the router saved — and, when they apply, how many
debug calls or transactions did not work, or how many requests the chain
rejected.

  - Do not repeat those numbers: not in the title, not in a point, not in the
    bottom line. Say what they MEAN.
  - Never name a time: no "this week", "today", "last time", "again",
    "recently". Every number on the card covers the time the card prints.
    The one comparison you may make is the drift you are given, and you call
    that "last week".
  - The title must agree with that line. When it says every request got a
    reply, the title may not say requests fail: say what the provider is
    doing, and that the router covered it. When it says the router saved
    some, the title may not say nothing caught them: "no backup is catching
    it" over "the router saved 575 others" is two claims that disagree —
    name what the backups could NOT save.
  - A provider's OWN numbers are yours to use — its share of errors, its
    speed — because the line does not carry them. Say whose number it is:
    "8% of lava's answers", never "8% of requests".

## What the points must walk, in this order

  1. What is failing — WHICH provider, by name, with its own number.
  2. Why — the cause.
  3. Why the failover did or did not save the requests. This is the one
     people act on.

What happened to the requests — how many failed, how many a retry saved — is
already printed above you. Not every issue needs all three points. Stop when
the chain is told.

When you are given \`howTheFailedRequestsWent\`, the card prints those paths
under your points: which provider each failed request tried, the backups the
router added, how each attempt ended. For those requests, points 1 and 3 are
already on screen — write neither. Write only what a path cannot show: the
cause, and why failover had nothing left (one backup, and it failed the same
way).

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

\`outcome\` is what the printed line is made from: how many requests the router
saved by retrying them on another provider (savedByRetry) and how many still
failed for the caller (reachedCaller). The counts are on screen; use them to
understand what the router did.

  - reachedCaller is 0: the provider failed and the caller never saw it. Say
    what covered it — "the router moved them to lava" — not the count.
  - reachedCaller above 0: say WHY the retry could not save them, when the
    input shows why.
  - callsNeedingAnAddon, when given, splits out debug and trace calls.
    gotNoUsableAnswer counts no answer at all AND error replies no retry
    replaced — "the method does not exist" is how a provider that cannot
    serve debug usually says so. When most of one kind got no usable answer,
    lead with why.
  - howTheFailedRequestsWent, when given, is each failed request traced
    through the router: the provider it tried first, the backup it moved to,
    how each attempt ended. One path is ONE request going through every
    provider on it, in order. "+7s" is when the router sent it to that
    provider, counted from the request's arrival: the router adds a backup
    every few seconds WITHOUT cancelling the earlier attempts, so they
    overlap. "no answer" means nothing came back from that provider before
    the router gave up. The card prints every path under your points, word
    for word (see "What the points must walk"). Never split one path into
    per-provider counts ("alchemy on 3, quicknode on 2 others") — that reads
    as different requests. wholePathSeconds runs from the request
    arriving to the caller's error — every attempt together, never one
    provider's time. When traced is below ofFailed, it is a sample; do not
    present its counts as the total.
  - transactions, when given, are the calls that change the chain (sending a
    transaction). When most failed the caller, lead with it: they cannot
    transact on this chain right now, whatever the reads look like.

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

## An update to an open issue

When you are given \`previousVersion\`, this issue is already on their screen
and is still happening. Write the SAME issue, updated:

  - Keep the title unless the facts now describe a different problem — or it
    disagrees with the printed line. "Requests fail" means the CALLER got an
    error. When the line says every request got a reply, none did: the
    provider refused them and the router saved them. Say that instead.
  - Keep the points in the same order; change the numbers to the new ones.
  - Except a point the input contradicts or a rule above forbids — a
    failover path walked step by step, split into per-provider counts, one
    provider given the whole path's time, a chain-wide count the card now
    prints, or a time word ("this week", "last time"). Rewrite that one, even
    though it was on screen: a wrong fact kept for continuity is still wrong.
  - Say what changed only when it matters: it got worse, it spread to another
    provider, or the router could no longer route around it.

The reader has been watching this card. A new title for the same problem reads
as a second problem.

## The bottom line

One sentence: can they work, AND why it is as bad as its severity says. A
bottom line that only restates the symptom has not earned its place — the
severity is already on screen, so say what makes it that severity.

  - "Requests are failing outright: the router does try the backups, but
     both are down, so there is nowhere for a retry to go."
  - "Read calls are fine; only debug traces fail, and only because lava is the
     one provider that serves them."
  - "Nothing is failing — the router is absorbing it, but it is retrying more
     than usual to do so."

The pattern in each: the impact in words — the numbers are printed above —
then the ONE fact that explains why it is not merely annoying. Usually that
fact is about failover.

Say it in different words from the point it came from. A bottom line that
repeats point four verbatim has made the card longer without making it
clearer.

## When the chain refused the requests

The caller-side card is about requests the chain itself refused — every
provider got the same answer, so no provider failed. Say what the chain's
reason MEANS, and never whose fault it is for certain:

  - "Nonce too low" means the transaction's nonce (its sequence number) was
    already used: that transaction, or another from the same account, had
    already gone through.
  - \`rejectedByTheChain.resent\`, when given, says how many refused
    transactions had been sent before — the SAME transaction, again, as a
    request of its own. When that is most of them, it is the cause: "the
    same transactions are being sent again after they went through".
  - Never write that their code "reuses nonces" or is broken, and never
    "your own transactions" as a verdict. A transaction sent again after a
    slow answer is refused the same way. Write "these transactions".

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
  - not "HTTP 429", or any status code -> "refusing requests over its limit"
  - not "primaries"           -> "main providers"
  - not "you are over its plan's rate limit" -> "the account used with it is
                                  over its request limit" — you do not know
                                  whose account it is"

If a point would make someone ask "what does that actually mean?", it is not
finished.

## Rules

The severity you are given follows ONE rule: can what they send still be
served. Critical means it cannot — every provider is failing, or at least half
the requests got no answer even after retries, or one kind of request cannot be
served at all: at least half of their debug (or trace) calls got no usable
answer, either none or an error reply — or at least half of their transactions
failed. "Can't transact" is critical even when every read works.
When it is that last one, say so by name: reads may work, but their debug calls
have no provider that can answer them. Degraded means the chain still
works: a provider is failing, slow or wrong, and the router has somewhere else
to send traffic, even if some requests reached the caller as errors. Config
means nothing is failing because of us or a provider.

Write a bottom line that agrees with that. On a critical issue, say plainly
that the chain is not usable right now, and why failover could not help. On a
degraded issue, say that it still works, and what did reach them — in words,
since the numbers are printed above.

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

Never write that requests succeeded, went through or were accepted. The
router knows that an answer came back — an error is an answer too — never
that it was a success. Write "got a reply", or leave it out.

Write each provider's name the way \`providerNames\` gives it: "QuickNode",
not "quicknode" in one line and "Quicknode" in the next.

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
  config: "the chain itself refused the request (a nonce already used, an account without funds) — every provider got the same answer; or a request for something no provider here serves",
};

export function digestForIssue(i: FormulatedInputs): string {
  return JSON.stringify(
    {
      chain: { spec: i.spec, name: i.chain },
      // How each provider is written — the ids in the values file are
      // whatever the operator typed.
      ...(() => {
        const ids = [
          ...new Set([
            ...[...i.findings, ...(i.alsoOnChains ?? []).flatMap((c) => c.findings)].flatMap((f) => (f.upstream ? [f.upstream] : [])),
            ...i.configured.map((c) => c.upstream),
          ]),
        ];
        const names = Object.fromEntries(ids.filter((id) => providerName(id) !== id).map((id) => [id, providerName(id)]));
        return Object.keys(names).length ? { providerNames: names } : {};
      })(),
      // The line the card prints above the points — so the model knows those
      // numbers are on screen, and does not restate them in its own words.
      ...(() => {
        const line = measuredFields(i).impact;
        return line ? { shownAboveYourPoints: line } : {};
      })(),
      ...(i.alsoOnChains?.length
        ? {
            sameProblemOnTheseChainsToo: i.alsoOnChains.map((c) => ({
              chain: c.chain,
              whatWeMeasured: c.findings.map((f) => `${f.headline} (${f.metric.value} ${f.metric.label})`),
            })),
          }
        : {}),
      ...(i.previous ? { previousVersion: i.previous } : {}),
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
              note: "Chain-wide, this window. totalRequests: customer requests. savedByRetry: failed on one provider and got an answer from another. reachedCaller: customer requests that failed after every retry — counted once per request from the router's own final-result log. An error ANSWER from a provider is not in reachedCaller — it went back to the caller as an error. null = not measured.",
              totalRequests: i.requests,
              savedByRetry: i.recovered,
              reachedCaller: i.failures,
              ...(i.writes ? { transactions: { sent: i.writes.sent, failedForTheCaller: i.writes.failed } } : {}),
              ...(i.rejected
                ? {
                    rejectedByTheChain: {
                      requests: i.rejected.requests,
                      byReason: i.rejected.byCode,
                      ...(i.rejected.resent
                        ? {
                            resent: {
                              checked: i.rejected.resent.checked,
                              sentBefore: i.rejected.resent.resent,
                              mostTimesSentBefore: i.rejected.resent.mostSends,
                            },
                          }
                        : {}),
                    },
                  }
                : {}),
              ...(i.paths?.groups.length
                ? {
                    howTheFailedRequestsWent: {
                      traced: i.paths.traced,
                      ofFailed: i.failures,
                      paths: i.paths.groups.map((g) => ({
                        requests: g.count,
                        methods: g.methods,
                        path: g.flow,
                        wholePathSeconds: g.seconds[0] === g.seconds[1] ? g.seconds[0] : g.seconds,
                      })),
                    },
                  }
                : {}),
              ...(i.addonCalls?.length
                ? {
                    callsNeedingAnAddon: i.addonCalls.map((a) => ({
                      kind: `${a.addon}_* calls`,
                      sent: a.sent,
                      gotNoUsableAnswer: a.failed,
                      ofWhichErrorReplies: a.errorReplies,
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

/**
 * Everything on an issue that is MEASURED rather than written: the badge, the
 * chains, whether it is still happening, the numbers. Split out so an issue
 * whose facts have not moved keeps its wording while these stay current —
 * a card that says "ongoing" must not be quoting last hour's numbers.
 */
/**
 * What the chain said about a rejected request, as the end of a sentence:
 * "…617 had a nonce (transaction number) that was already used". The chain's
 * own reason, not a verdict on whose fault it is.
 */
/**
 * A title that says requests fail, on a chain where none did.
 *
 * The model writes it meaning the PROVIDER failed them — "blockdaemon
 * rate-limiting is causing some requests to fail" — while the router saved
 * every one, and the line under it says "all 22,055 requests got a reply".
 * The reader sees two claims that disagree; the title is the one they read.
 */
export function titleContradicts(title: string, outcome: ChainOutcome): boolean {
  const nothingFailed =
    outcome.failures === 0 &&
    !outcome.addonCalls.some((a) => (a.failed ?? 0) > 0) &&
    !outcome.writes?.failed;
  if (!nothingFailed) return false;
  return (
    /\b(requests?|calls?|transactions?)\b[^.]{0,40}\bfail/i.test(title) ||
    /\bfail\w*\b[^.]{0,30}\b(requests?|calls?|transactions?)\b/i.test(title)
  );
}

/**
 * A sentence claiming success. The router knows that an answer came back —
 * an error is an answer too — never that a request succeeded: "all 348 sent
 * transactions succeeded" was written beside 616 of them refused by the
 * chain, because the input said none had gone unanswered.
 */
export function claimsSuccess(text: string): boolean {
  const claim = /\b(succeed(?:ed|s|ing)?|successful(?:ly)?|(?:go|goes|going|gone|went|get|gets|getting|got) through|(?:is|are|was|were|being) accepted)\b/i;
  // "None of them got through" is a failure, said plainly — a negation
  // before the phrase in the same sentence is not a claim.
  const negated = /\b(not|no|never|none|nothing|cannot|can't|couldn't|didn't|don't|doesn't|won't|fail(?:s|ed|ing)? to)\b/i;
  return text.split(/[.;!?]/).some((sentence) => {
    const m = claim.exec(sentence);
    return m != null && !negated.test(sentence.slice(0, m.index));
  });
}

/**
 * The chain's reason for refusing a request, as the end of "…each for …".
 * The chain's own reason — not a verdict on whose fault it is.
 */
const REFUSED_FOR: Record<string, string> = {
  CHAIN_NONCE_TOO_LOW: "a nonce (transaction number) that was already used",
  CHAIN_NONCE_TOO_HIGH: "a nonce (transaction number) too far ahead",
  CHAIN_INSUFFICIENT_FUNDS: "an account without enough funds",
  USER_INVALID_PARAMS: "malformed parameters",
};
const refusedFor = (code: string) =>
  REFUSED_FOR[code] ?? `"${code.replace(/^(CHAIN|USER)_/, "").toLowerCase().replace(/_/g, " ")}"`;

const num = (n: number) => n.toLocaleString("en-US");

/** A share as the card prints it — "0.04%", "1.7%", "39%" — and never "0%" for something that happened. */
export function shareText(part: number, whole: number): string {
  const pct = (part / whole) * 100;
  if (pct > 0 && pct < 0.01) return "under 0.01%";
  return `${pct < 1 ? pct.toFixed(2) : pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

/**
 * The chain's numbers as one line, written by code rather than the model.
 *
 * It answers the reader's first question — is anyone affected, and how much —
 * the same way on every card, with words that mean one thing each:
 *
 *   failed: no provider answered them   the router gave up (its final-result log)
 *   got a reply                          something came back — an error reply included
 *   saved                                failed on one provider, answered by another
 *   did not work                         debug or trace calls with no usable answer
 *   refused                              the chain refused the request itself
 *
 * Every number carries its "of what". The time it covers is printed beside
 * it by the page, from `measured`. When the model wrote these, it put "this
 * week" and "last time" over 30-minute counts, and counts with no "of what".
 */
export function impactOf(
  outcome: ChainOutcome,
  findings: StatusFinding[],
  severity: IssueSeverity,
  chains = 1,
): string | null {
  // The caller-side card is about what the chain refused, not about answers:
  // "all 187,702 requests got a reply" over refusals reads as a contradiction.
  if (severity === "config") return refusedLine(outcome, findings, chains);

  const parts: string[] = [];
  const { failures, requests, recovered } = outcome;
  if (failures == null) {
    if (requests != null) {
      parts.push(`${num(requests)} requests. Failed requests are not counted: this deployment has no router logs.`);
    }
  } else if (failures === 0) {
    parts.push(requests === 0 ? "No requests were sent." : requests != null ? `All ${num(requests)} requests got a reply.` : "Every request got a reply.");
  } else {
    parts.push(
      requests != null && requests >= failures
        ? `${num(failures)} of ${num(requests)} requests (${shareText(failures, requests)}) failed: no provider answered them.`
        : `${num(failures)} requests failed: no provider answered them.`,
    );
  }
  if (recovered != null && recovered > 0) {
    parts.push(`The router saved ${num(recovered)} ${failures ? "others" : "of them"} by trying another provider.`);
  }
  // A reply is not a success. Beside a provider sending errors back, "all
  // 4,793 requests got a reply" alone reads as "everything worked" — so the
  // line names who is replying with errors. Its share stays in the points:
  // the finding's number counts errors and no-answers together.
  const erring = [...new Set(findings.filter((f) => f.kind === "answered-error" && f.upstream).map((f) => providerName(f.upstream!)))];
  if (erring.length > 0) {
    parts.push(`Some ${failures ? "other " : ""}replies were errors from ${erring.join(" and ")}.`);
  }
  for (const a of outcome.addonCalls) {
    if (a.failed != null && a.failed > 0) parts.push(`${num(a.failed)} of ${num(a.sent)} ${a.addon} calls did not work.`);
  }
  if (outcome.writes?.failed) {
    parts.push(`${num(outcome.writes.failed)} of ${num(outcome.writes.sent)} transactions failed: no provider answered them.`);
  }
  return parts.length ? parts.join(" ") : null;
}

/**
 * The caller-side card's line: what the chain refused, and — for
 * transactions — whether the same one had been sent before.
 *
 * Counted per request, from the router's log. Without the log the only count
 * is the classified counter's, which counts each provider's REPLY: a
 * transaction goes to every primary, so one refusal counts once per primary.
 * The line then says "replies", which is what that number is.
 */
function refusedLine(outcome: ChainOutcome, findings: StatusFinding[], chains: number): string | null {
  const where = chains > 1 ? `The ${chains} chains` : "The chain";
  const r = outcome.rejected;
  let byCode: [string, number][];
  let perRequest: boolean;
  if (r && r.requests > 0) {
    byCode = Object.entries(r.byCode);
    perRequest = true;
  } else {
    const m = new Map<string, number>();
    for (const f of findings) {
      if (!f.id.includes(":caller:")) continue;
      for (const [code, n] of Object.entries(f.codeCounts ?? {})) m.set(code, (m.get(code) ?? 0) + n);
    }
    byCode = [...m];
    perRequest = false;
  }
  const total = perRequest ? r!.requests : byCode.reduce((a, [, n]) => a + n, 0);
  if (total === 0) return null;
  byCode.sort((a, b) => b[1] - a[1]);
  const why =
    byCode.length === 1
      ? `, each for ${refusedFor(byCode[0]![0])}`
      : `: ${byCode.map(([code, n]) => `${num(n)} for ${refusedFor(code)}`).join(", ")}`;
  const lead = perRequest
    ? `${where} refused ${num(total)} requests${why}.`
    : `Providers passed on ${num(total)} refusals from the chain — one per provider a request went to${why}.`;
  const re = r?.resent;
  const resent =
    re && re.checked > 0 && re.resent > 0
      ? ` ${re.resent === re.checked ? `All ${re.checked}` : `${re.resent} of ${re.checked}`} transactions checked had been sent before — the same transaction, up to ${num(re.mostSends)} ${re.mostSends === 1 ? "time" : "times"}.`
      : "";
  return lead + resent;
}

/**
 * A provider is failing and the router covered it completely: nothing failed
 * for the caller, no error reply reached them, and no saved request waited
 * out a timeout first. A provider refusing over its rate limit answers at
 * once, so the retry costs nothing; a provider that does not answer makes
 * every saved request wait for its timeout — that is not "handled".
 */
export function isHandled(findings: StatusFinding[], outcome: ChainOutcome, severity: IssueSeverity): boolean {
  if (severity !== "degraded" || findings.length === 0) return false;
  // Null is "not measured", never "nothing failed".
  if (outcome.failures !== 0) return false;
  if (outcome.addonCalls.some((a) => (a.failed ?? 0) > 0) || outcome.writes?.failed) return false;
  return findings.every(
    (f) =>
      (f.kind === "dead" && /rate-limited/i.test(f.headline)) ||
      (f.kind === "answered-stale" && /caught/i.test(`${f.headline} ${f.metric.label}`)),
  );
}

/**
 * Who can act on it, in one line, written by code. Never how to fix it —
 * that is the owner's call, and this page's next stage. Four answers: no one
 * (the router covered it), the provider at fault, whoever sends the refused
 * requests, or Magma (the router itself — see the several-chains card).
 */
export function whoActs(
  findings: StatusFinding[],
  outcome: ChainOutcome,
  severity: IssueSeverity,
  handled: boolean,
): string | null {
  if (severity === "config") {
    return outcome.rejected?.resent?.resent
      ? "Whoever sends these transactions — the same transaction is being sent again after it went through."
      : "Whoever sends these requests — the chain refused them itself; no provider failed.";
  }
  if (handled) return "No one right now — the router is covering it.";
  const doing = (f: StatusFinding): string =>
    f.kind === "dead"
      ? /rate-limited/i.test(f.headline)
        ? "it is refusing requests over its account's request limit"
        : "it is not answering in time"
      : f.kind === "answered-error"
        ? "it is answering with errors"
        : f.kind === "answered-late"
          ? "it is answering slowly"
          : f.kind === "answered-stale"
            ? "it is answering from behind the chain"
            : "it is failing";
  const byName = new Map<string, StatusFinding>();
  for (const f of findings) if (f.upstream && !byName.has(f.upstream)) byName.set(f.upstream, f);
  // Where requests actually failed comes first, in the order they were
  // tried: a primary that times out on every failed request can have no
  // finding of its own, and still be where each one started failing.
  const tried = outcome.paths?.groups[0]?.failedOn ?? [];
  const owners = [...new Set([...tried, ...byName.keys()])];
  if (owners.length === 0) return null;
  const lead = owners[0]!;
  const leadFinding = byName.get(lead);
  // Error replies that are the CHAIN's answers — "insufficient fee",
  // "transaction not found" — are passed on by the provider, not made by it.
  // Blaming the provider for them sends the reader to the wrong door. Only
  // when nothing failed on the way: a timeout is the provider's own.
  if (
    tried.length === 0 &&
    leadFinding?.kind === "answered-error" &&
    leadFinding.codes.length > 0 &&
    leadFinding.codes.every((c) => c.startsWith("CHAIN_"))
  ) {
    return `Whoever sends these requests — the errors come from the chain itself, not from ${providerName(lead)}.`;
  }
  if (owners.length === 1) {
    return `${providerName(lead)} (the provider) — ${leadFinding ? doing(leadFinding) : "requests failed on it"}.`;
  }
  const names = owners.map(providerName);
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)} (the providers) — each is failing on this chain.`;
}

/**
 * An issue written from its measurements alone: the findings as they are,
 * under the same numbers line. For a chain the model could not write this
 * cycle — the call failed, or the cycle's writing budget ran out.
 *
 * Finding a problem must not depend on the model. Before this, a new issue
 * whose words failed was left off the page, and a failing chain with no card
 * reads as a working one.
 */
export function plainIssue(inputs: FormulatedInputs): FormulatedIssue {
  const all = [...inputs.findings, ...(inputs.alsoOnChains ?? []).flatMap((c) => c.findings)];
  const merged = (inputs.alsoOnChains?.length ?? 0) > 0;
  const where = merged ? `${1 + inputs.alsoOnChains!.length} chains` : inputs.chain;
  const [first, ...rest] = all;
  return {
    ...measuredFields(inputs),
    title: !first
      ? where
      : first.upstream
        ? `${providerName(first.upstream)} on ${where}: ${first.headline}`
        : `${where}: ${first.headline}`,
    points: rest.slice(0, 3).map((f) => `${f.upstream ? providerName(f.upstream) : f.chainName}: ${f.headline}`),
    bottomLine: "",
    plain: true,
  };
}

export function measuredFields(
  inputs: FormulatedInputs,
): Omit<FormulatedIssue, "title" | "points" | "bottomLine"> {
  const all = [...inputs.findings, ...(inputs.alsoOnChains ?? []).flatMap((c) => c.findings)];
  const outcome: ChainOutcome = {
    recovered: inputs.recovered,
    failures: inputs.failures,
    requests: inputs.requests,
    addonCalls: inputs.addonCalls ?? [],
    writes: inputs.writes ?? null,
    paths: inputs.paths ?? null,
    rejected: inputs.rejected ?? null,
  };
  // From the findings and the outcome, never from the model — a model
  // re-deriving the badge would produce a second scale that disagrees.
  const severity = severityOf(inputs.findings, outcome);
  const handled = isHandled(all, outcome, severity);
  return {
    severity,
    spec: inputs.spec,
    chain: inputs.chain,
    specs: [inputs.spec, ...(inputs.alsoOnChains ?? []).map((c) => c.spec)],
    ongoing: all.some((f) => f.ongoing === true),
    findingIds: inputs.findings.map((f) => f.id),
    outcome,
    impact: impactOf(outcome, all, severity, 1 + (inputs.alsoOnChains?.length ?? 0)),
    measured: inputs.measured ?? null,
    handled,
    whoActs: whoActs(all, outcome, severity, handled),
    // The strings a caller's own log has: the router's error names, from the
    // findings and from the failed requests themselves.
    codes: [...new Set([...all.flatMap((f) => f.codes), ...(outcome.paths?.groups.flatMap((g) => g.errors) ?? [])])].slice(0, 4),
    lastSeenUnix: all.reduce<number | null>(
      (newest, f) => (f.lastSeenUnix && (!newest || f.lastSeenUnix > newest) ? f.lastSeenUnix : newest),
      null,
    ),
  };
}

export class FormulatedIssueService {
  constructor(
    private readonly bedrock: BedrockService,
    private readonly logger?: BedrockLogger,
  ) {}

  async formulate(inputs: FormulatedInputs): Promise<FormulatedIssue> {
    const measured = measuredFields(inputs);
    // The cross-chain instruction is appended only when it applies, so a
    // single-chain issue is never told about a shape it cannot produce.
    const system = inputs.alsoOnChains?.length ? SYSTEM_PROMPT + CROSS_CHAIN_NOTE : SYSTEM_PROMPT;
    const messages: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: digestForIssue(inputs) }];
    // The answer is ~150 tokens, but the model reasons before it writes and
    // the reasoning counts against this ceiling: 400 to 2,000+ tokens on one
    // issue, measured. At 2,000, about one call in six ended with the answer
    // cut off or empty, and a new issue missed its cycle.
    const ask = () => this.bedrock.complete({ system, messages, maxTokens: 8000 });

    let answer = await ask();
    let parsed = parseModelJson(answer, "issue statement", this.logger);
    const text = (x: Record<string, unknown>, k: string) => (typeof x[k] === "string" ? (x[k] as string) : "");
    const pointsOf = (x: Record<string, unknown>) =>
      (Array.isArray(x.points) ? x.points : []).filter((p): p is string => typeof p === "string" && p.trim() !== "");
    // Checked in code, because the prompt already says both and the model
    // still wrote them — on an update it keeps the title on screen. Asked
    // once, with the reason; what is still wrong after that is replaced.
    const problems = (x: Record<string, unknown>): string[] => [
      ...(titleContradicts(text(x, "title"), measured.outcome)
        ? ["Your title says requests fail, but none did: every request got a reply — the router saved the ones the provider failed. Say what the provider is doing."]
        : []),
      ...([text(x, "title"), ...pointsOf(x), text(x, "bottomLine")].some(claimsSuccess)
        ? ["You wrote that requests succeeded or went through. The router only knows an answer came back — an error is an answer too. Say \"got a reply\", or leave it out."]
        : []),
    ];
    const wrong = problems(parsed);
    if (wrong.length > 0) {
      messages.push(
        { role: "assistant", content: answer.text },
        { role: "user", content: `${wrong.join(" ")} Same JSON, nothing else.` },
      );
      answer = await ask();
      parsed = parseModelJson(answer, "issue statement", this.logger);
    }
    const str = (k: string): string => text(parsed, k);
    const titleText = str("title");
    const title =
      titleContradicts(titleText, measured.outcome) || claimsSuccess(titleText) ? plainIssue(inputs).title : titleText;

    return {
      ...measured,
      title,
      // Capped here as well as in the prompt: a model that ignores "two to
      // four" must not turn the card back into the essay this replaced. Four,
      // not five — every point renders, so the cap IS what the reader sees.
      points: pointsOf(parsed)
        .filter((p) => !claimsSuccess(p))
        .slice(0, 4),
      bottomLine: claimsSuccess(str("bottomLine")) ? "" : str("bottomLine"),
    };
  }
}
