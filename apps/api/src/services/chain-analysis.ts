/**
 * One chain, explained: its providers, and each provider's errors clustered
 * into batches with the analysis attached to the batch.
 *
 * ## The shape is the point
 *
 * The page is organised by severity — Critical, Degraded, Config — which
 * answers OUR question: what is worst across the deployment. A customer whose
 * chain is not responding does not care that Solana is worse. They want their
 * chain, the providers on it, and what is actually happening.
 *
 * So the container is the CHAIN. Inside it, providers. Inside each provider,
 * clusters of errors — and the explanation hangs off the cluster, not off a
 * code.
 *
 * ## Why a cluster and not a code breakdown
 *
 * A per-code list reads like this:
 *
 *   CHAIN_STARKNET_TX_HASH_NOT_FOUND   4,560  the blockchain itself could not satisfy the request
 *   CHAIN_STARKNET_INSUFFICIENT_FEE    2,280  the blockchain itself could not satisfy the request
 *   CHAIN_STARKNET_BLOCK_NOT_FOUND        92  the blockchain itself could not satisfy the request
 *
 * Three rows, one sentence, repeated. The codes are our vocabulary and the
 * annotation is identical, so the customer learns nothing they can act on.
 * One cluster saying "the caller asked for transactions this node does not
 * have, usually an indexer racing the newest block — a different provider
 * would have answered the same" is the same facts and actually says something.
 *
 * Codes are kept on the cluster for whoever wants them; they are no longer the
 * organising idea.
 */
import type { StatusFinding } from "@sr/shared";
import type { ErrorGroup } from "./loki.js";
import { BedrockService, parseModelJson, type BedrockLogger } from "./bedrock.js";

export type FaultOwner = "provider" | "setup" | "caller" | "chain" | "undetermined";
const OWNERS: readonly FaultOwner[] = ["provider", "setup", "caller", "chain", "undetermined"];

/** A batch of errors that share a cause, with the explanation on the batch. */
export interface ErrorCluster {
  /** What went wrong, in the customer's terms. No codes, no metric names. */
  what: string;
  /** Why it happened, and what it means for them. Two sentences at most. */
  why: string;
  /** Whose problem this batch is. */
  whose: FaultOwner;
  /** Requests in this batch, when the input gives a count. */
  count: number | null;
  /** The methods it hit. Empty when the logs do not say. */
  methods: string[];
  /** The raw codes, kept for whoever wants them — not the organising idea. */
  codes: string[];
}

export interface ProviderBlock {
  upstream: string;
  role: "primary" | "backup" | null;
  /** One line: this provider's state on this chain. */
  state: string;
  clusters: ErrorCluster[];
}

export interface ChainAnalysis {
  spec: string;
  chainName: string;
  /** What is happening with this chain, for someone who asked exactly that. */
  summary: string;
  /** Whose problem the chain's trouble mostly is. */
  owner: FaultOwner;
  providers: ProviderBlock[];
}

export interface ChainAnalysisInputs {
  spec: string;
  chainName: string;
  findings: StatusFinding[];
  /** Error lines grouped by fault, already scoped to this chain. */
  errorGroups: ErrorGroup[];
  /** Every provider the config declares here, with what it is allowed to serve. */
  configured: { upstream: string; role: "primary" | "backup" | null; addons: string[] }[];
}

const SYSTEM_PROMPT = `You explain ONE blockchain RPC chain to the customer whose traffic runs on it.

The Magma Devs Smart Router sits in front of raw RPC endpoints and multiplexes
across them. For one client request it picks an upstream provider, relays, and
may retry or hedge to another. "Provider", "upstream" and "endpoint" all mean
the node the router relays TO.

## Who is reading

Someone whose chain is not responding properly and who wants to know what is
happening with it. Not an engineer on our team. They know their own chain and
their own traffic; they do not know our error codes and should not have to.

## The shape

One chain. Inside it, the providers on that chain. Inside each provider,
CLUSTERS of errors — batches that share a cause — with the explanation on the
cluster.

Do not produce a per-code breakdown. This is what one looks like and why it is
useless:

  CHAIN_STARKNET_TX_HASH_NOT_FOUND  4,560  the blockchain could not satisfy the request
  CHAIN_STARKNET_INSUFFICIENT_FEE   2,280  the blockchain could not satisfy the request
  CHAIN_STARKNET_BLOCK_NOT_FOUND       92  the blockchain could not satisfy the request

Three rows, the same sentence three times, in vocabulary that is ours and not
theirs. One cluster instead: "6,932 requests asked this node for transactions
and blocks it does not have. These are the chain's own answers, not the
provider failing — usually an indexer racing the newest block, or history the
node no longer keeps. Another provider would have answered the same."

Group by CAUSE, not by code. Several codes belong in one cluster when the same
thing happened. One code splits into two clusters when it did not.

## Rules

Plain language. Say "the node did not answer in time", not "PROTOCOL_CONTEXT_DEADLINE".
Put the codes in the codes field for whoever wants them and keep them out of
your sentences.

Use the real error TEXT, which you are given. It is far more specific than the
code: an "UNKNOWN_ERROR" whose text reads "Request timeout on the free plan,
please upgrade to paid plan" is a billing problem on a provider account, and
the code says none of that.

Whose problem, in these exact words:
- **provider** — this node is broken, slow, rate-limiting, or serving bad data
- **setup** — the config claims something this provider does not serve, or a
  chain has nowhere to fail over to
- **caller** — the request or the account was wrong; nonce, funds, bad params.
  Another provider would have answered identically
- **chain** — the network itself: a halt, pruned history every provider lacks
- **undetermined** — the input does not settle it. Use it rather than guessing

The addons matter. If one provider declares an addon and the others do not,
then when that one fails there is nothing eligible to take over — and that is
a setup problem, not a provider one. Say so plainly when the config shows it.

Never invent a count, a method, a provider or an error that is not in the
input. Do not recommend fixes; say what happened and whose it is.

Say nothing about providers with no errors. A provider with a clean record gets
a one-line state and an empty clusters array.

## Your answer

Reply with ONLY a JSON object, no prose around it, no markdown fence:

{
  "summary": "One or two sentences: what is happening with this chain.",
  "owner": "provider|setup|caller|chain|undetermined",
  "providers": [
    {
      "upstream": "as given",
      "state": "one line: this provider's state on this chain",
      "clusters": [
        {
          "what": "what went wrong, in their terms",
          "why": "why, and what it means for them — two sentences at most",
          "whose": "provider|setup|caller|chain|undetermined",
          "count": 0,
          "methods": ["as given"],
          "codes": ["as given"]
        }
      ]
    }
  ]
}`;

export function toOwner(raw: unknown): FaultOwner {
  return typeof raw === "string" && (OWNERS as readonly string[]).includes(raw)
    ? (raw as FaultOwner)
    : "undetermined";
}

/**
 * What the model sees. Errors are pre-attributed to a provider where the log
 * line names one, because asking it to do the attribution invites a guess.
 */
export function digestChain(i: ChainAnalysisInputs): string {
  const byProvider = new Map<string, ErrorGroup[]>();
  for (const g of i.errorGroups) {
    const key = g.provider ?? "";
    const list = byProvider.get(key) ?? [];
    list.push(g);
    byProvider.set(key, list);
  }

  return JSON.stringify(
    {
      chain: { spec: i.spec, name: i.chainName },
      // Roles AND addons: an addon only one provider declares is why a failure
      // there has nowhere to go, which is a setup fact metrics cannot show.
      providersConfigured: i.configured,
      findingsOnThisChain: i.findings.map((f) => ({
        upstream: f.upstream,
        tier: f.tier,
        headline: f.headline,
        metric: `${f.metric.value} ${f.metric.label}`,
        ongoing: f.ongoing,
      })),
      errorsByProvider: [...byProvider.entries()].map(([provider, groups]) => ({
        provider: provider || "(the line did not name one)",
        errors: groups.map((g) => ({
          code: g.errorName,
          count: g.count,
          methods: g.methods.slice(0, 5),
          // The text is the useful part — see the prompt.
          text: g.example.slice(0, 220),
        })),
      })),
    },
    null,
    1,
  );
}

export class ChainAnalysisService {
  constructor(
    private readonly bedrock: BedrockService,
    private readonly logger?: BedrockLogger,
  ) {}

  async analyse(inputs: ChainAnalysisInputs): Promise<ChainAnalysis> {
    const answer = await this.bedrock.complete({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: digestChain(inputs) }],
      maxTokens: 6000,
    });

    const parsed = parseModelJson(answer, "chain analysis", this.logger);

    // Roles come from the config, never from the model — it has no reason to
    // get them right and a wrong one changes what the reader concludes.
    const roleOf = new Map(inputs.configured.map((c) => [c.upstream, c.role]));

    const providers: ProviderBlock[] = (Array.isArray(parsed.providers) ? parsed.providers : [])
      .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object")
      .map((p) => ({
        upstream: String(p.upstream ?? ""),
        role: roleOf.get(String(p.upstream ?? "")) ?? null,
        state: typeof p.state === "string" ? p.state : "",
        clusters: (Array.isArray(p.clusters) ? p.clusters : [])
          .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object")
          .map((c) => ({
            what: String(c.what ?? ""),
            why: String(c.why ?? ""),
            whose: toOwner(c.whose),
            count: typeof c.count === "number" ? c.count : null,
            methods: Array.isArray(c.methods) ? c.methods.map(String) : [],
            codes: Array.isArray(c.codes) ? c.codes.map(String) : [],
          }))
          .filter((c) => c.what !== ""),
      }))
      .filter((p) => p.upstream !== "");

    return {
      spec: inputs.spec,
      chainName: inputs.chainName,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      owner: toOwner(parsed.owner),
      providers,
    };
  }
}
