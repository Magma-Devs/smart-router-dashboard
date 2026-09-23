/**
 * Why requests failed on one (chain × provider), and whose problem it is.
 *
 * The Status page already says WHAT is wrong on a row. This answers the
 * question the row cannot: given the actual error text, this provider's peers
 * on the same chain, and how the same provider is doing elsewhere — is this
 * the provider's fault, the setup's, the caller's, or the chain's?
 *
 * Those four are the page's own vocabulary, and the verdict is the point of
 * the whole thing: it is what decides who gets the ticket.
 *
 * Three inputs make the verdict possible, and none of them is on the row:
 *
 *  - **The real error lines.** Grouped from Loki, credential-scrubbed. A row
 *    shows a code; the line shows what the node actually said.
 *  - **The peers.** The same chain's other providers over the same window. A
 *    provider failing while its peers are clean is a provider problem; every
 *    provider failing the same way is the chain or the caller.
 *  - **Elsewhere.** The same provider on its other chains. Broken everywhere
 *    is a different conversation from broken here.
 *
 * As in `status-ai.ts`, nothing the model says is trusted on its own: the
 * verdict is constrained to four values and anything else is rejected.
 */
import type { StatusFinding } from "@sr/shared";
import type { ErrorGroup } from "./loki.js";
import { BedrockService, type BedrockLogger } from "./bedrock.js";

/** Whose problem it is. The page's vocabulary, and a closed set on purpose. */
export type FaultOwner = "provider" | "setup" | "caller" | "chain" | "undetermined";

const OWNERS: readonly FaultOwner[] = ["provider", "setup", "caller", "chain", "undetermined"];

export interface FailureAnalysis {
  spec: string;
  upstream: string;
  /** Whose problem. `undetermined` when the inputs do not settle it. */
  verdict: FaultOwner;
  /** One sentence naming the fault and its owner. */
  summary: string;
  /** Each error class that reached a caller, in plain words. */
  errors: { code: string; meaning: string; whose: FaultOwner }[];
  /** How this provider compares to its peers on this chain. Null when alone. */
  versusPeers: string | null;
  /** Whether the same provider is failing on other chains. Null when it is not. */
  elsewhere: string | null;
}

/** What the model may be asked about. Assembled by the route, not by the model. */
export interface FailureInputs {
  spec: string;
  chainName: string;
  upstream: string;
  role: "primary" | "backup" | null;
  /** Findings on the page naming this pair. */
  findings: StatusFinding[];
  /** Real error lines from the router's logs, grouped by fault. */
  errorGroups: ErrorGroup[];
  /** Other providers on this chain, and whether they are also failing. */
  peers: { upstream: string; failing: boolean; note: string }[];
  /** Other chains where this provider is producing errors. */
  otherChains: { spec: string; chainName: string; note: string }[];
  /**
   * The router's OWN answer to "is this provider serving right now", from
   * `smartrouter_csm_provider_blocked` — rewritten every state tick, zeros
   * included, so it is never stale.
   *
   * `null` means the router does not emit that family, which is a real state
   * and not a healthy one: older builds publish only the per-chain COUNT of
   * blocked providers, so the deployment can say how many are out and never
   * which. Reported as unknown rather than inferred from error rates.
   */
  blocked: { state: "blocked" | "serving"; reason: string | null } | null;
  /** Chain serving tier: primaries / backups-only / nothing left. Null when absent. */
  servingTier: "primaries" | "backups-only" | "none" | null;
}

const SYSTEM_PROMPT = `You tell an engineer operating the Magma Devs Smart Router whose problem a
failure is.

The router sits in front of raw blockchain RPC endpoints and multiplexes across
them. For one client request it picks an upstream provider, relays, and may
retry or hedge to another. Chains are Lava spec indexes (ETH1, SOLANA, BASE).
"Provider", "upstream" and "endpoint" all mean the node the router relays TO.

## Your job

You are given ONE chain and ONE provider on it: the findings already on the
page, the real error lines from the router's logs, the same chain's other
providers, and the same provider's other chains. Decide whose problem it is.

Four owners, and these exact words:

- **provider** — this node is broken, slow, rate-limiting, or serving bad data.
  The strongest signal is peers on the same chain being clean.
- **setup** — the configuration is wrong or incomplete. A method the provider
  does not serve but the config claims, an addon declared where it is not
  supported, verification needing more providers than exist.
- **caller** — the request was wrong or the account was. Nonce too low,
  insufficient funds, malformed params. The chain rejected it correctly and no
  provider could have answered differently.
- **chain** — the network itself. A halt, a reorg, pruned history every
  provider lacks. The signal is EVERY provider failing the same way.
- **undetermined** — the inputs do not settle it. Use this rather than guessing.

## Rules

Decide from what you are given. Never introduce an error code, provider, chain
or number that is not in the input.

If a block state is given, it is the router own answer and outranks every
inference. "blocked" means the router took this provider out of rotation, and
the reason names why: all-endpoints-disabled is the provider, while
explicit-block-signal may be the setup. When the block state is null the router
does not publish that family at all — say it is unknown rather than treating
error rates as equivalent, and never read null as serving.

The peers are the next strongest evidence you have. One provider failing while its
peers are clean is **provider**. Every provider failing identically is **chain**
or **caller** — read the error to tell those apart. Say which comparison drove
your verdict.

Read the error lines, not just the codes. The code says the class; the line
says what the node actually returned, and they can disagree.

Do not recommend actions. Name the fault and its owner, then stop.

If the evidence is thin, say so and return "undetermined". A wrong verdict
sends a ticket to the wrong team, which is worse than no verdict.

## Your answer

Reply with ONLY a JSON object, no prose around it, no markdown fence:

{
  "verdict": "provider|setup|caller|chain|undetermined",
  "summary": "One sentence: the fault and whose it is.",
  "errors": [{ "code": "as given", "meaning": "plain words", "whose": "provider|setup|caller|chain|undetermined" }],
  "versusPeers": "How this provider compares to the others on this chain, or null when it is alone.",
  "elsewhere": "Whether this provider is failing on other chains too, or null when it is not.",
  "notDetermined": ["what the inputs could have settled and did not"]
}

notDetermined is for you, not the reader — somewhere honest to put what you
could not tell, so you never fill a gap with a guess. Nothing renders it.`;

/** Constrain the verdict to the closed set; anything else is undetermined. */
export function toOwner(raw: unknown): FaultOwner {
  return typeof raw === "string" && (OWNERS as readonly string[]).includes(raw)
    ? (raw as FaultOwner)
    : "undetermined";
}

/** What the model sees. Error EXAMPLES are the point — codes alone are on the row. */
export function digestInputs(i: FailureInputs): string {
  return JSON.stringify(
    {
      chain: { spec: i.spec, name: i.chainName },
      provider: { name: i.upstream, role: i.role },
      findingsOnThisPair: i.findings.map((f) => ({
        kind: f.kind,
        tier: f.tier,
        headline: f.headline,
        metric: `${f.metric.value} ${f.metric.label}`,
        codes: f.codes,
        ongoing: f.ongoing,
      })),
      errorsFromLogs: i.errorGroups.map((g) => ({
        code: g.errorName,
        count: g.count,
        methods: g.methods.slice(0, 5),
        example: g.example,
      })),
      othersOnThisChain: i.peers,
      sameProviderOtherChains: i.otherChains,
      // The router's own state, or an explicit "not published by this build".
      routerBlockState: i.blocked ?? "not published by this router build",
      chainServingTier: i.servingTier ?? "not published by this router build",
    },
    null,
    1,
  );
}

export class FailureAnalysisService {
  constructor(
    private readonly bedrock: BedrockService,
    private readonly logger?: BedrockLogger,
  ) {}

  async analyse(inputs: FailureInputs): Promise<FailureAnalysis> {
    const answer = await this.bedrock.complete({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: digestInputs(inputs) }],
      // One pair, so the answer is short — far below the brief's ceiling.
      maxTokens: 2000,
    });

    if (answer.stopReason === "max_tokens") {
      this.logger?.warn({ spec: inputs.spec, upstream: inputs.upstream }, "failure analysis truncated");
    }

    const start = answer.text.indexOf("{");
    const end = answer.text.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("model did not return JSON");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(answer.text.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      throw new Error("model did not return JSON");
    }

    const rawErrors = Array.isArray(parsed.errors) ? parsed.errors : [];
    return {
      spec: inputs.spec,
      upstream: inputs.upstream,
      verdict: toOwner(parsed.verdict),
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      errors: rawErrors
        .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object")
        .map((e) => ({
          code: String(e.code ?? ""),
          meaning: String(e.meaning ?? ""),
          whose: toOwner(e.whose),
        }))
        .filter((e) => e.code !== ""),
      versusPeers: typeof parsed.versusPeers === "string" ? parsed.versusPeers : null,
      elsewhere: typeof parsed.elsewhere === "string" ? parsed.elsewhere : null,
    };
  }
}
