# Ask your data: backend contracts and persistence

[MAG-4750](https://magmadevs.atlassian.net/browse/MAG-4750) owns the canonical
scope. The [implementation and acceptance ledger](ASK-YOUR-DATA-IMPLEMENTATION.md)
tracks all six delivery slices. This document describes MAG-4929's foundation
and MAG-4930's durable personal history/run primitives. MAG-4931 adds the bounded
tool orchestrator and queue worker below; activation waits for budget admission.

## Runtime configuration

The existing API holds both provider connections. The browser receives neither
AWS/MCP credentials nor configuration that selects the customer or destination.
Set these on the **backend process** or its Kubernetes Secret-backed environment;
a GitHub repository secret alone does not inject a running container's secret.

| Backend variable | Meaning |
| --- | --- |
| AUTH_MODE=enabled | Existing live PostgreSQL session gate |
| DEPLOYMENT_MODE=managed | Managed deployments only |
| ASK_DATA_ENABLED=true | Explicit per-deployment/customer availability |
| ASK_DATA_CUSTOMER_ID | Exact registry customer ID; separate from display name |
| ASK_DATA_MCP_TOKEN | Customer-only bearer credential; staff credentials are rejected |
| ASK_DATA_MCP_URL | Fixed trusted HTTPS endpoint, default staging /mcp |
| ASK_DATA_BEDROCK_REGION | Region, default us-east-1 |
| ASK_DATA_BEDROCK_MODEL | Explicit currently verified model/inference profile ID |
| AWS_BEARER_TOKEN_BEDROCK | Runtime bearer secret, independent of SES credentials |
| ASK_DATA_RETENTION_DAYS | 1-90 days, default 90; shorter customer policy applies to reads immediately |

Model/region/credential availability must be verified now. MAG-3702's historical
provisioning is not a current availability check. There is no provider/key fallback.
Use `secretKeyRef` for both tokens, never a public ConfigMap or frontend env. The
foundation does not change fleet resources or enable a customer deployment.

`GET /api/ask/capabilities` requires a live session and the deployment gates. It
returns contract version 1; `acceptingQuestions`, true only while this replica's
worker runs with budget admission installed, a current rate card and the admins'
switch on; `off`, true while an admin has Ask turned off; and `canSwitch`, true
for an admin. Personal history/preferences routes are authenticated. Submission
goes through budget admission and queues a run; only the worker calls MCP or
Bedrock. Disabled/auth-off/self-hosted deployments cannot use these routes.
Existing session revocation and 2FA gates apply.

## Turning Ask off

An admin turns Ask off for everyone on the deployment with the **Turn off**
button on the Team page, behind a confirmation, or with
`POST /api/ask/switch` and `{"off": true}`; `{"off": false}` turns it back on. It
takes effect at once on every replica and needs no rollout:

- The turn-off's transaction cancels the queued questions and marks the running
  ones `cancelling`. The worker holding a run sees that at its next lease check,
  every second, and aborts its provider call. A paid step's reservation and
  dispatch require the run to be `running`, so no paid step starts after the
  switch commits.
- Admission reads the switch under a share lock: a question submitted while an
  admin turns Ask off is either refused with `ASK_TURNED_OFF` or cancelled by
  that turn-off. A queue claim takes no run while the switch is off.
- Each replica rereads the switch every second for its capability answer and its
  worker, and pauses admission/claims until its first read answers. This unknown state never interrupts another replica's admitted questions.
- Chats stay readable. Members see that an admin turned Ask off; an admin is
  linked to the Team page, where **Turn on** brings it back.
- Turning Ask back on allows only what the deployment allows: the flag,
  credentials, rate card and monthly budget still apply.

Each change writes `ask.turned_off` or `ask.turned_on` to the audit log, naming
the admin. The switch is one row per customer in `ask_switch` (migration
`0013_ask_switch`); no row means on.

## Personal history and durable runs

Send immediately clears the composer and displays a pending question with
`Sending…`. This in-memory state is scoped to the current authenticated person,
session and customer. The same conversation remains mounted when a new chat
gets its URL. After acceptance, the UI shows the run's step and keeps the pending
question until the transcript contains its exact run ID. The step is
`Starting…` before the first model turn, `Choosing what to read…` during it,
`Reading data…` once a read finishes after a turn, `Reviewing what it read…`
during a later turn, and `Working…` between a turn's end and its first read or
the answer. Under it, the reads the run has finished, newest five, each with a
server-written label (`Failure counts`, `Request log lines`, `Metric <name>`)
and a cross when its source was unavailable. An API that reports no progress
shows `Processing…`. The step comes from the model turns and reads the run
already records, read on each poll of `GET /api/ask/runs/active` (every 1.5 s
while a question runs); the run writes nothing extra for it. Below the status
line the answer appears as the model writes it, with a caret, rendered as the
saved answer is: the page reads `GET /api/ask/runs/:id/draft` every 500 ms from
the moment the run is queued until its status is final, and reveals new text a
few characters a frame (at once under reduced motion). A final status reloads
the transcript at once. The server clears the draft when the run ends, so the
page keeps the last text it read on screen, and the transcript keeps polling,
until the transcript holds that run as done. In that same render the saved
answer replaces the draft, or a failed or stopped run's message does, so the
reply never blanks between the two. The draft is whole words only, credential-redacted as a
stored answer is, and not yet checked against the reads. While it streams,
half-written Markdown is held back or closed (a table row without its closing
`|`, a table without its separator line, an open `**` or code span), so raw
syntax never flickers. The draft endpoint has its own limit of 240 reads a
minute per person, apart from the dashboard's. Identical questions
remain distinct turns. Failed delivery restores the draft; an uncertain retry
uses the same idempotency key and context. Refreshing accepted state only reads
the server and never resubmits the question.

Migration `0010_ask_runs` adds chats, runs, ordered messages and last-view
preferences. Every query/mutation scopes both the server customer ID and the
session's person. Composite foreign keys prevent attaching a message to another
person/customer's run. A chat/run ID or cursor grants no access.

History uses bounded keyset pagination over an activity sequence; it cannot lose
precision at PostgreSQL's microsecond timestamp boundary. Search is personal and
customer-scoped, with literal LIKE escaping and cursor/filter binding. A chat
opens its latest 50 messages in chronological order; `?before=` loads earlier
messages using `nextMessageCursor`. Run and message expiry are enforced on reads.
The chat title previews the newest question, rather than retaining an expired
first question inside the title of an ongoing chat.

Submission locks the person's SQL row, checks an existing idempotency key/hash,
and atomically commits the run, user message, chat activity and admission hook.
The database independently enforces one active run per customer/person through a
partial unique index. A changed retry is a conflict; an expired retry cannot
resurrect an old answer. Admission failure rolls everything back.

The replica that saves a question wakes its own worker, which claims it at once;
other replicas find it by polling every second. A claim is one statement whose
subquery takes the oldest queued run younger than the run deadline with
`FOR UPDATE SKIP LOCKED`; an older one is left for recovery, which fails it with
`ASK_TIMEOUT`. A claim sets a unique fencing token and a bounded lease.
Completion, heartbeat and failure first acquire the row lock, then recheck the
current wall clock in a second statement: PostgreSQL may evaluate an UPDATE's
WHERE before a lock wait. The lease check renews a running run's lease and reads
a cancelling one's status in that second statement, without extending it. A lease that expires during that
wait cannot be extended or publish a late answer. Success and its assistant
message commit together, after answer validation. A failed/cancelled/interrupted
run creates no assistant success message.

Queued cancellation is terminal; a running cancellation requests durable stop.
Recovery terminates lost/old/revoked-session runs without replaying potentially
billable work. The user's admission is released; any future financial reservation
stays for reconciliation. Runs record the original session ID without a foreign
key that would prevent normal expired-session cleanup.

A replica that has not finished readiness checks pauses queue claims; only a
confirmed feature/admin disable interrupts work. A stopping replica claims no
more runs and leaves queued questions for another replica; its running answers
get the API's drain window to finish and are interrupted at its end. Queue
waiting and execution share one deadline measured from submission. Expiration
reports `ASK_TIMEOUT`, while lease loss, revocation and a run still going when
the drain window ends remain interruptions. Stop reaches
free token counting as well as MCP/model requests. Heartbeats run independently;
execution-boundary authorization no longer opens a heartbeat transaction for
every tool. Fixed error codes and per-phase durations provide diagnostics without
logging questions, answers, tool results or credentials.

The hot path is shaped by round trips, because a fleet API reaches its database
across regions through a tunnel. Every query is a named prepared statement
(`preparing` in `@sr/db`): one round trip once a connection has prepared it, where
an unprepared query with parameters costs two and holds back the queries after
it. A transaction's statements that do not wait on each other's results go out
together and share a round trip; PostgreSQL still runs them one at a time in the
order sent, so each is its own statement after any lock the one before it took,
and the code reads their results in that order, failing where a one-at-a-time
transaction would. The worker's first lease check and its history read run side
by side. The lease check at a model call's dispatch reuses the reservation's own
check when that is under a second old; `dispatched` verifies the lease, the
running status and the session again before a paid request leaves. A tool event
is one statement that locks the run while its lease is current.

The API starts the worker once the database is ready, with the budget hooks
below installed, on a managed deployment with Ask enabled and a valid rate card.

## Bounded tool execution

The API runs a bounded AI SDK `ToolLoopAgent` against the existing native
Bedrock adapter, with tool choice `auto`: forced tool use would suppress the
answer text. A step either reads (tool calls only) or answers: the answer as
Markdown reply text, then one `present_answer` call carrying only `kind`
(`conversation` or `data`) and the `evidenceIds` it rests on. Two or more
closing calls in one step that agree on `kind` are one close citing every
evidence id any of them names; calls that name different kinds are refused. A
close that says `conversation` in a run with a successful read of its own (the
server's counts read does not count) is a data answer resting on that evidence.
`present_answer` is available from the first step: ordinary conversation, clarifications and
explanations of earlier answers need no data read.

A step that ends on text with neither a read nor the closing call is handled by
what came before it:

- **Before any read of the run's own** (the server's counts read does not
  count), the text is a conversation reply.
- **After a read of its own**, the text may be the model's working ("Let me get
  the last hour") rather than the answer. The run withdraws its draft and asks
  once more, and that step must call a tool: a read, or `present_answer` alone,
  which closes the held text as the answer without writing it again. When no
  read is left for that step (its last step, or the read or context limit), it
  is offered `present_answer` without being forced, so the model can write the
  answer before closing it.
- **On the run's last step, or after the one re-ask**, the text is a data
  answer.

Ask's scope is the customer's Smart Router - its chains, providers, requests
and the customers that sent them, errors, transactions and status - and the RPC, blockchain, monitoring and
dashboard concepts behind it, plus greetings, thanks and the current date and
time. A question outside it (general knowledge, history, geography, people,
news, market prices, writing or code unrelated to the router) is declined in
one sentence in the question's language, with one example of a question Ask
answers, as a conversation reply; the question itself is not answered. No answer
mentions tools, reads, tool calls or the model's own steps.

Every paid conversational reply still has normal atomic reservation,
dispatch fencing and usage reconciliation. There is no question-word regex
routing. Every turn receives the current server clock and precomputed query
windows; the current UTC reference is explicit and never comes from an old answer or a browser identity override.

Before the first model turn the server reads the recorded counts once
(`prefetchRead` in `services/ask/prefetch.ts`): one `metrics.query_range` over
the last 24 hours with a one-hour step, each selector one hour long, so it stays
inside the read policy's 24-hour total lookback. It returns per chain the
recorded requests (`smartrouter_final_requests:count1m`) and router failures
(`smartrouter_final_failures:count1m`) of each hour, and the router's recorded
log lines (`smartrouter_log_lines:count1m{component="router"}`) as the sign
that the recording ran. `summarizePrefetch` totals them into the last hour and
the last 24 hours per chain and `recordingLive`. The first turn receives them as
the result of a `router_request_summary` call after the question, so they sit
outside the static prompt prefix. A count question for those windows is then
answered in one model turn. With the recording live, a chain absent from the
counts had no requests: no failures and no requests mean no requests reached the
routers, so nothing failed, never a coverage gap; with nothing recorded it is a
gap and the model reads the logs. The read runs through the same policy,
redaction, evidence and audit as every read; it does not count against the
model's read limit, it counts toward the context bytes, and a failed,
unavailable or ambiguous read leaves the run to its own reads. A cancelled run
stops during it. It is a source of the answer only when the answer rests on it:
a conversation reply drops it, and so does a data answer whose cited evidence
leaves it out. It runs for every question and sits in the model's own turn, so
its note (`PREFETCH_NOTE`) says the server read it, not the model, and that a
reply which does not need it ignores it and never mentions it.

Data tools have locally authored names and parameter schemas. The customer MCP
connection opens for that read, before the first turn. Identity verification comes
first; independent catalog/tool-list requests then run concurrently. Every read
rechecks identity and the immutable local policy: the identity check and the read
go to the MCP server together, and the read's result is used only once the
identity check has passed.

Each API replica keeps one MCP client and its discovery for five minutes
(`McpPool`) and gives each run its own view of it, bound to that run's stop. The
MCP server is stateless and authenticates every request, so the shared client
holds no server session. The client belongs to one MCP URL, credential and
customer; a change to any of them opens a new one. A failed call or a refused
identity retires it, and a retired client closes once its last run lets go of it,
or at shutdown. A source added to or removed from the credential's grant reaches
Ask within five minutes; the MCP server refuses a removed source's reads at once. A source is selected implicitly
only if exactly one authorized source supports the operation; ambiguity returns
choices and never sums replicas. Remote descriptions cannot grant tools.
A read may start at any time the stores hold: log lines 45 days back, metrics
90 days. How long one read may be depends on what it reads. A log query's range
selectors total at most 24 hours. A metrics query's total at most 30 days: the
recorded series hold one sample a minute. Range reads (`query_range`, `labels`,
`label_values`, `series`) span at most 24 hours, the MCP server's own bound.
Provider-status event reads keep their seven-day bounds. The model gives a
named date or time in ISO 8601, and the server converts it to Unix seconds; a
time without a zone is UTC. Every tool that reads a window takes `from`/`to`
(in place of `start`/`end`, or `since`/`until` on provider status), and an
instant read takes `at` (in place of `time`). A window read that names neither
end reads the chat's window. A time given both ways, or one that is not ISO
8601, ends the run as a malformed input. The request context precomputes the last 5 minutes,
hour, 24 hours, 7 days and 30 days. A window the server refuses (too long for
what it reads, out of order, or ending more than 5 minutes ahead) does not end
the run: the tool answers it with an error, and the model reads again with a
shorter window or several consecutive ones. Only a malformed input ends the run.

`router_request_summary` reads the ruler's recorded per-minute counts over one window of up to 30 days: requests and failures, transactions (`measure=transactions`), or the router's warn and error log lines by chain and level with the 30 most frequent messages (`measure=errors`, `smartrouter_warn_error_lines:count1m`). Missing series stay
unknown, without a zero fallback. The model never sees the samples: the server
adds them up into `table` (`summary-tables.ts`), rows and totals per chain, and
each count's result carries only how many samples went into it. A table holds
the 40 largest rows, fewer when they would take more than half a tool result,
and names the rest in `omittedRows`; its totals add up every row. Its bytes
count toward the run's context like a read's.

The recorded requests and failures per chain include the hub's serving probe
(`magma-serving-probe`), about one request a minute per chain and interface;
the alert rules read them, so they stay as they are. A requests summary also
reads the probe's share per chain from the ruler's per-customer series
(`spec_router_customer:smartrouter_customer_requests_total:rate2m15s` and its
failed counterpart, by spec), as two reads beside the counts asked for that
spend none of the run's eight. Each row then carries `probeRequests` and
`probeFailures` and the customer's own, `customerRequests` and
`customerFailures`; a probe count never exceeds the count it is part of. The
counts read before the first turn carry the same split for the last hour and
the last 24 hours. The tool's note and the prefetch note tell the model to
report the customer's own as the customer's traffic. On a quiet chain the
whole count can be the probe's.

A transactions row reads `accepted`, `rejected`, `failedNeverSent`,
`failedOnChain`, `unknown` and `total`, by `txResultOf`, the Transactions tab's
own mapping. A window longer than a day also reads whether the recorded series
hold anything in its first day: the family it sums, or for transactions (a day
may have none) the requests the same ruler records beside them; when they do not, the result carries
`recordingWarning` and the answer says the totals may cover only part of it. A
count whose recorded series has nothing for a window of a day or less carries
`fallback`: the same count over this customer's raw router
lines in Loki, with the recorded rule's own filters (`requestSummaryQueries`'s
`raw`). The tool never runs it; the model runs it once with `logs_query` when
the question needs that count, and says the figure was counted from the logs. A window that ends within two minutes of the
server's time reaches into the recording lag: the model reads it as partial
coverage and states the gap, and the stored evidence keeps the read's own
coverage.

The MCP server may answer a read in part: a window, range or log scan larger
than one read covers comes back as its newest part, with `partial`, the window
asked for and read, what ran in its place (`adjusted`) and a `guidance` text.
`mcp.ts` reads each of those on its own, so a part it does not understand is
dropped and never the read. The model is handed them beside the data
(`narrowed`, `ranAs`, `guidance` and a note to state the window covered); the
evidence is Partial and carries the times of the window read. A read the
server did not answer (`ok: false`, or parameters it refuses as a tool error)
is handed over as `Read not answered: CODE` with the server's guidance when it
gives one: the run goes on, and the model can read again. The guidance is
printable text of at most 1,200 characters and is redacted like any tool
result. Any other tool error still ends the run as `ASK_MCP_UNAVAILABLE`. An
MCP server that sends none of these fields is read as before.

`measure=customers` answers questions about the reader's own customers: the
values of the `customer-id` header their callers send, which each router counts
in `smartrouter_customer_requests_total` and
`smartrouter_customer_requests_failed_total` (one count per client request, with
its final outcome). It reads requests and failures per customer (the top 50) and
requests per customer and method (the top 30), with
`increase()` over the window. `chain` selects the counters' `spec`, the chain id
upper-cased; `customer` selects one customer; `methodPrefixes` (up to eight,
letters, digits, `_` and `/` only) selects methods that start with them, so
`["debug_", "trace_"]` is the debug requests. The hub's serving probe
(`magma-serving-probe`) is left out of every count. `DefaultDappID` is the requests
that named no customer, and `other` the requests past a router's 512-customer
cap. These are Prometheus counters, not recorded series: they carry no log
fallback and no recording lag, and a customer missing from the result is unknown.
A customer id is named in the answer as returned; the prompt tells the model a
long hex id is the caller's choice, not a credential, and redaction leaves it.

`measure=providers` answers which provider (upstream node) sent or failed what.
Per chain and provider it reads relays and successful relays from the recorded
pair `spec_router_provider:smartrouter_requests_total:rate2m15s` and
`…_success_total:rate2m15s` (a window's total is the sum times 60), and
node-error replies raw from `smartrouter_node_errors_total`. The table gives
`relays`, `failedRelays` (relays minus successes) and `nodeErrorReplies`, most
errors first. A node-error reply is an answered relay, so it is not among the
failed ones. Relays include the router's retries, hedges and health probes, and
the router's cache (`Cached`) is left out. A count whose read failed is named
in `table.unavailable` and its column is left out.

Counts do not establish an acceptable error rate or a cause without actual evidence and an SLO. `router_recent_requests` reads a small, customer-scoped backwards sample of the dashboard's `relay_end` events for request details, over up to 24 hours at any time the logs hold. Each event's `served_by` names the provider whose reply reached the client and `attempts` every provider tried. `requested_block` names the block the request asked for, so the line filter ``|= `"requested_block":<number>` `` finds one block's requests, and `request_id` is the caller's `X-Request-Id`. Sampling never proves the absence of errors. Effective status/instant-query times and literal lookback windows are returned explicitly; absence of a provider-status source is reported as unavailable. A provider-status read (`status.chain_events`) reaches the model summarized (`services/ask/status-summary.ts`): the chains whose every provider is operational and whose measured state is up or unconfigured by name (`chainsAllOperational`), every other chain with only its non-operational providers and a count of the operational ones, and the events newest first with titles and details cut to 160 characters. A many-chain tenant's status fits whole; when the events still do not fit, the oldest are left out, `eventsOmitted` counts them and the source reads Partial.

Model dispatch guards live inside the model execution boundary, not SDK
notification callbacks. Automatic model retries and tool repair are disabled.
A provider's complete response is locally validated before persistence and before
it replaces the draft; the step's answer text reaches the page before that, as
the draft. Text a step writes before a read call is withdrawn from the draft and
is never an answer. Data replies still require actual successful reads.
Invented evidence references, a conversation reply with sources, a closing call
beside another call, an empty answer, one over 8,000 characters and unknown
fields are rejected after usage is recorded. Empty, partial and unavailable data
remain distinguishable.

Every failed run logs one line, `Ask run failed`, with its `runId` and `code`
(info for `ASK_CANCELLED` and `ASK_INTERRUPTED`, warn otherwise). An answer the
server refused adds `reason`, the check that refused it; a failure that was not
an Ask failure adds the thrown error's class and code. No answer text, tool
input or evidence id is logged.

| `reason` | The check that refused the answer |
| --- | --- |
| `bad_usage` | the provider's usage block does not parse |
| `malformed_response` | the response is not a Converse message, or its stream carried content the adapter does not know |
| `unexpected_stop` | a stop reason other than `end_turn` or `tool_use` |
| `answer_tool_unavailable` | `present_answer` was called on a step that did not offer it |
| `unknown_content` | a content block that is neither text nor a tool call |
| `history_mismatch` | the earlier turns sent do not match the chat's history |
| `too_many_tool_calls` | more than four tool calls in one step, or a repeated call id |
| `closing_call_not_alone` | `present_answer` beside another tool call |
| `closing_calls_disagree` | two or more `present_answer` calls in one step that name different kinds |
| `invalid_closing_call` | `present_answer` input other than `kind` and `evidenceIds` |
| `conversation_with_sources` | a conversation reply that cites or carries a source, in a run with no successful read of its own |
| `data_without_reads` | a data answer with no read behind it |
| `unknown_evidence` | an evidence id that no read of the run returned, or one cited twice |
| `empty_answer` | no answer text |
| `answer_too_long` | answer text over 8,000 characters |
| `answer_contract` | the stored-answer shape derived from the text fails its schema |
| `stored_contract` | an answer handed to the store fails its schema |

The system prompt tells the model where transactions and failed requests live,
in the Transactions tab's own terms: the `relay_end` line filter
(`TX_EVENT_FILTER`), the recorded per-minute counts
(`smartrouter_transactions:count1m`, `smartrouter_final_{requests,failures}:count1m`)
and how an outcome reads as accepted, rejected, failed on chain, failed or
unknown (`txResultOf`). It sets the order for any count: the recorded series
first, these four and `smartrouter_warn_error_lines:count1m`; raw log lines only
as the fallback, when a series has nothing for the window, for the newest two
minutes, or for the lines themselves (`router_recent_requests`). A warn or error
line is a log line, not a failed request. It also sets how an answer is written: plain sentences,
the covered time said once, no source IDs, label names or queries in the prose.

At most 5 model steps and 8 data reads run; a step can request at most 4 tools.
Individual tool context is capped at 12,000 bytes with explicit partial coverage;
the whole request is capped at 128,000 bytes. A read runs only while the request
has room for two more whole results. The instructions and tool definitions every
step sends stay within a 40,000-byte budget that `ask-orchestrator.test.ts`
holds, so a deployment with 43 chains, whose counts read before the first turn
are about 6,400 bytes, still makes four reads before it answers. Prior personal
messages are bounded role-based messages, at most 16,000 bytes of the newest
turns, explicitly historical evidence. Replicated sources must not be summed; correlation
with provider status must not be presented as proof of causation.

Read admission measures this run's protected context separately from reclaimable
personal history. A long conversation therefore does not prevent a fresh read
merely because older messages are present. Before token counting and generation,
the native adapter can remove only the exact verified history prefix, oldest
turns first, while preserving the current question, system, tools and results
from this run. It leaves room for the native wire envelope. Counting and
generation use the same bounded input; an oversized protected request is refused
before paid dispatch. Full personal history remains stored and readable.

Known runtime credentials, bearer/key fields and credential-bearing URL paths
are redacted before model context/tool records and the final answer. This is not
general classification of arbitrary log text. Personal search terms and ORM-bound
prompt/answer values are also excluded from ordinary application logs; structured
internal records retain their own authorization/retention boundary.

`AskWorker` claims under SQL leases, renews them while active, observes stop,
session/lease loss and feature disable, and aborts work at the deadline. On
shutdown it claims nothing more, a claim in flight being its last, waits for its
running answers until the drain window ends, and then aborts the rest, whose
terminal write ends their leases before the database pool closes.
Renewal stops, and the check in flight finishes, before the run's terminal write
(success or failure), so a run never reads its own completion as a lost lease.
A check that finds the lease lost logs `ASK_LEASE_LOST` and aborts the run, and
so does a success write the database refuses because the lease is gone.
Stop during a pending queue claim cannot start work after shutdown. A model
response arriving after cancellation cannot become an assistant success.
Recovery never replays a potentially billable invocation. Unknown usage remains
conservative; request IDs and server-authored run/step metadata support later
reconciliation. The budget service owns actual atomic accounting and conservative reconciliation.

## Identity and tool boundary

Every MCP connection uses the official SDK's Streamable HTTP transport. HTTP
requests have exact destination checks, no redirects/reconnection retries, a
20-second request deadline and 1 MiB response ceiling, including streamed bodies.
The adapter handles JSON and SSE responses. It never starts interactive OAuth.

`whoami` must prove exactly the configured customer and read scope. Reject staff
identities and broader tenant lists even if they include the customer. Discovery
validates source ownership and intersects each source's remote catalog with a
local audited GET-only operation policy. `execute_operation` cannot escape that
policy; strict local parameter validation rejects tenant/header/URL overrides.
The result envelope must match the same customer, source and operation. Workers
remain responsible for independently checking the current customer grant.

The catalog is capability-dependent: remote `main` implements `chain_events`,
while newer local MCP work and dated deployment reports have a different catalog.
No provider-status availability is claimed until a live discovery/read proves it.
The orchestration slice owns status policy support and unavailable-data answers.

## Answer and execution contracts

`@sr/shared` owns validated question/context/preferences/history and answer shapes,
stable run states/error codes and response types. The model's answer is
GitHub-flavored Markdown of at most 8,000 characters, kept in its own column
(`answer_markdown` on `ask_runs` and `ask_messages`, migration
`0015_ask_markdown`) and served as the answer's `markdown`. The stored answer
JSON keeps the summary-and-sections shape: the server derives a plain-text
summary (the first paragraph, at most 500 characters) and sections holding the
whole answer (`services/ask/markdown.ts`), and never stores `markdown` in it, so
every stored answer parses on every API version and a web without Markdown
rendering, or a rolled-back one, still shows the whole answer as text. Server-authored evidence adds
the actual source, operation, observation/query times, coverage and truncation.
Each source's label is the progress list's name for its read (`readLabel` in
`services/ask/progress.ts`, from the operation and the series or streams the
query selects, such as "Failure counts" or "Request log lines"). The API names
each source from its audited tool event's operation and query when it serves a
run or a chat; no stored answer carries a label, and the store drops one from an
answer before writing it, so every stored answer parses on every API version.
An answer stored earlier gets its labels the same way while its tool events are
kept, and renders without them otherwise.
The web renders the Markdown with `react-markdown` and `remark-gfm`: raw HTML
shows as the text it is (no `rehype-raw`), and links and images render as their
text, so no URL the model wrote is followed or fetched. The server validates
before persistence; the draft is the one model text shown before validation.

Bedrock uses [ConverseStream](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html)
for every model step of a run (IAM action `bedrock:InvokeModelWithResponseStream`),
with a fixed server-selected region/model and explicit maxTokens. The adapter
(`services/ask/bedrock.ts`) decodes the AWS event stream (`event-stream.ts`,
both CRC32 checksums verified), rebuilds the Converse response from its events
and runs the same checks on it a buffered
[Converse](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html)
response gets; a caller with no draft consumer makes the buffered call. Each
text delta of a step updates the draft with the step's text so far; a tool call
other than `present_answer` withdraws it. The worker writes the newest draft to
`ask_runs.draft` (migration `0014_ask_draft`; 8,000 characters since
`0015_ask_markdown`) at most every 250 ms, only under the run's current lease
while it runs; every terminal write clears it. An exception event ends the step as a provider failure, a
stream cut before its `metadata` event leaves the step's usage uncertain, and a
content event the adapter does not know rejects the step after its usage is
recorded. The byte ceiling and deadline cover the whole stream. No temperature
is sent. Context is capped at 128,000 UTF-8 bytes; output at 2048 tokens. The adapter
does not retry potentially billable invocations. Its required usage callback runs
before output validation, including malformed/truncated answers. Missing usage
and transport failures are explicitly uncertain; budget accounting keeps
their reservation until authoritative reconciliation. Usage fields are retained for versioned
pricing rather than discarding cache/reasoning billing categories.

## Budget, internal records and retention

Every production worker is installed with `AskBudget` hooks. A shared PostgreSQL
customer/UTC-month row serializes Ask and future Investigate spending across
people, entry points and replicas. The default cap is 10,000,000 integer micro-USD
($10); it is never included in customer responses. Automatic upserts never raise an existing cap. Cap reductions require disabled
dispatch and a consistent replica rollout, followed by verification of the saved
pool before resuming (see the operator runbook).

Queue admission checks available capacity in the submission transaction. Before
each paid step, Ask reserves a bound with no network call. A token covers at
least one byte of the text it encodes, so the input bound is the UTF-8 byte length
of the serialized request (system, messages and tool schemas) plus 2,048 tokens
for the provider's tool-use prompt and message framing. That bound and the maximum
output are priced at the highest configured input/cache rate, then reserved
atomically. Settlement charges the usage Bedrock reports and frees the rest of
the reservation. A second transaction proves
the run/session/lease is current and marks dispatch before the network call.
Both use PostgreSQL UTC time; a reservation cannot cross a month boundary at
dispatch. A new step after rollover reserves against the new month.

There is no guessed default price. Set `ASK_DATA_PRICING_JSON` to a verified,
versioned rate card matching the exact model and region. Required keys are
`version`, `model`, `region`, `validFrom`, `validUntil`, `source` (the official AWS
Bedrock pricing URL), and `input`, `output`, `cacheRead`, `cacheWrite5m`,
`cacheWrite1h`. Rates are **decimal strings of integer micro-USD per million
tokens**; for example, a hypothetical $3/million rate is `"3000000"`. This is a
format example, not a current model price. Verify all actual rates, service tier,
region/profile and validity interval before activation. Expired or missing pricing
blocks paid execution, while retention and accounting recovery continue.

Set `ASK_DATA_TOKEN_COUNTER` to `runtime` or `mantle` and
`ASK_DATA_TOKEN_COUNTER_MODEL` to the corresponding supported identifier of the
same Anthropic model. The readiness preflight (`ask-preflight`) counts a
synthetic tool-enabled input with it, which proves model access without paid
inference; answers never call it. Runtime CountTokens is not available for every
CRIS-only model. Mantle requires the explicit base model ID and the appropriate project
permission. An unsupported/denied counter fails closed; it never falls back to
paid inference. The API needs the applicable `bedrock:CountTokens` or
`bedrock-mantle:CountTokens` grant in addition to inference permission. See
[AWS token counting](https://docs.aws.amazon.com/bedrock/latest/userguide/count-tokens.html)
and [Converse token inputs](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseTokensRequest.html).

Usage settlement locks the same monthly pool and is idempotent, including late
receipts after cancellation, lease loss or content deletion. It uses the step's
saved price version. Non-cached input, cache reads, TTL-specific writes and output
are billed separately according to
[AWS caching semantics](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)
and [usage fields](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_TokenUsage.html).
Missing usage, unsupported fields or an unverified cache TTL keep the full
reservation uncertain.

For a Claude model, each Converse request carries three cache points, all with
Bedrock's default five-minute TTL: after the tool definitions, after the
instructions every run shares, and after the newest message. The run's own
context (server time, page context) is a separate system block after the second
point, so the shared prefix is identical across steps and runs. A step reads the
tools, the instructions and every earlier step of its run from the cache and
writes only what is new. A cache write that Bedrock reports without a TTL
breakdown is attributed to the five-minute TTL the request asked for and priced
at `cacheWrite5m`; a request with no cache point gets no such attribution. The
token counter receives the request without cache points. Never-dispatched reservations are released after terminal
state/recovery. Dispatched reservations are never freed merely because the user
stopped, an HTTP request failed, or a process restarted. Authoritative late usage
can settle them. Provider bound violations persist observed spending before
halting the run. Operators must investigate unresolved request IDs with provider
usage evidence; never clear a hold simply to restore capacity.

Questions are redacted before persistence. Ordinary application logs contain fixed
error codes and paths, not prompts, answer values, source payloads or search terms.
Structured internal records combine retained runs/questions/person IDs/times,
answers/errors, tool parameters/evidence/latency, and every model step's usage,
price version, request receipt and cost. No model or MCP credential is exposed.

`GET /api/internal/ask/records`, `/export`, and `/health` are independent internal
read endpoints, **not customer-admin routes**. Each request verifies the presented
MCP OAuth credential's current `whoami`: explicit `access: staff`, read-only scope,
nonempty subject and a grant including this server-configured customer. The chat's
customer-only credential is never substituted. A dashboard JWT, customer admin
role, email domain or guessed ID grants no staff access. No customer override is
accepted. Staff reads/exports are themselves recorded with the verified subject.

Records/export accept only `cursor` (UUID) and `limit` (1-50, default 20). UUID
keyset pagination is deterministic within retained data; concurrent insertions and
retention can change later pages. Export is bounded NDJSON, one run per line plus
a final `kind: page` line with `nextCursor`; follow that cursor for another page.
It does not put prompts or filters into a download URL. Health exposes retention
attempt/success/error and uncertain steps/monthly accounting only to verified
staff. Monitor missing/stale `lastSuccessAt`, `ASK_RETENTION_FAILED` and unresolved
usage; normal application errors use fixed `ASK_*` codes.

A retryable sweep runs every minute after database readiness, even with the feature
flag off or pricing unavailable. It serializes through a PostgreSQL maintenance
row, deletes at most 500 expired terminal runs per pass, and cascades message/tool
content. History/record reads enforce expiry before physical deletion. Customer
retention is 1-90 days. Empty expired chats, stale preferences and old staff access
records are cleaned as well. Minimal accounting without prompt/person fields
survives; deletion never resets spending or frees uncertain dispatches.

## Controlled operator checkpoint

With a current dashboard session and the API URL securely injected into the
operator process as `ASK_DATA_SMOKE_SESSION_TOKEN` and `ASK_DATA_SMOKE_API_URL`:

```sh
ASK_DATA_SMOKE=true pnpm --filter @sr/api ask:smoke
```

This submits one real question through the normal authenticated API, shared budget,
worker, MCP and Bedrock path, then validates the persisted answer. The earlier
unmetered foundation probe has been removed. A session is revocable and must be
obtained through the normal login process. Never put its value in shell history.
The command prints IDs and evidence metadata only; no raw values/answer/credential.
A successful smoke is not browser UX, semantic quality or pilot acceptance.

`apps/api/src/__tests__/ask-postgres.test.ts` runs these flows against a real
PostgreSQL (the "Ask isolation and concurrency" check). Live-provider, runtime and
rollout acceptance is tracked on MAG-4934.


## Chat UI

The web and API both require managed authenticated deployment and
`ASK_DATA_ENABLED=true`. The API's current capabilities/session gate remains the
source of authority; browser visibility never grants access. Customer roles all
use the same customer-only read boundary.

Ask is one page, `/ask?chat=<id>`, reached from **Ask your data** in the left
menu, under Upstreams. There is no top-bar button, keyboard shortcut, side panel
or minimized pill. The menu entry leads to the chat with a question still
running, else to the chat last open in the tab, else to a new one, and shows a
spinner while a question runs, so the rest of the dashboard stays in use while
waiting. A draft survives leaving the page and coming back.

The page is the conversation in a centered, left-aligned reading column, with
**History** and **New chat** above it. A new chat opens at the top of the column
with what Ask answers and four suggested questions as a list; a click on one
sends it as it stands, and leaves the composer's draft alone. History replaces the conversation with the person's
chats: searched by POST body, grouped by local calendar days and paginated.
Earlier messages load without losing the reading position. Completed
errors/cancellations are included with retained messages, so reload does not
erase the outcome.

A new chat's questions default to the last 24 hours. A follow-up keeps the chain and router its chat started with (chats from
before Ask became one page may carry them) over a time of the same length that
ends now. The composer shows no scope line.

The conversation reads as a log of findings. Each question is its turn's
heading, and every turn after the first opens under a hairline. An unanswered
question shows its time beside it; an answered one shows it once, under the
answer. Answers read as prose under their question: paragraphs, lists, tables
(scrolling inside their frame on a narrow screen) and bold key figures. An
answer stored without Markdown renders its summary and numbered sections. One
row under an answer holds its sources on the left ("2 sources Failure counts,
Request counts"), which open their list across the column, and copy and the
time on the right, quiet until the answer is hovered or focused. Copy gives the
Markdown and its sources. While a question runs, one line under it shows the
brand's ember mark (the page's only moving mark, still under reduced motion),
the step, and Stop beside it, with the reads so far under that line; the
composer says the answer will be there after leaving the page. A failed turn
states what happened, with **Ask again**, which sends the same question at once
and leaves the composer's draft alone, and **Edit question**, which puts it in
the composer. A source reads as Logs, Metrics or Data followed by its label
("Metrics Failure counts"), with its window's day on both ends when they fall
on different days. A source's tag says what its read returned: Cut short,
Partial or Unavailable in the warning colour, No matches or Limited coverage in
a muted one. A metrics source whose window ends less than two minutes before
its read also carries a muted "Last 2 min pending" (`recentGap` in
`ask-display.ts`, read off the stored window and read time). The line "Some of
the data behind this answer was missing or cut short" shows only for a warning
tag, never for the recording lag alone. A short answer keeps its question
visible; a long answer opens at its start. Reading older messages is not interrupted. The composer
grows with the draft and available width. Enter sends, Shift+Enter inserts a
line and IME composition does not submit. Under it one line says the chat is
private to the person and that answers can be incomplete. A single active
question locks submission across every chat/tab. Stop is durable and never
creates a success message. Connection, loading, unavailable, empty and failed
states have specific human-readable copy; no budget amount or
credential/configuration advice is exposed to customers.

Personal UI/cache state is scoped by the server's opaque customer/person hash and
current dashboard session, with no transcript or draft in persistent browser
storage. Queued reads/writes are bound to the initiating session; refreshed bearers
for that same session are accepted, but a replacement account cannot receive the
old request. A late failed request cannot sign out a newly signed-in account.
The web no longer reads or writes `/api/ask/preferences`; the routes remain.

On a phone the left menu folds to its icons on the Ask page and the top bar keeps
only the theme switch, so the conversation has the width. Theme tokens, reduced
motion and keyboard/focus labels follow the existing dashboard components.
The browser suites (`e2e/ask-specs`, `e2e/ask-presentation`) cover the page
and write their screenshots to their results directories.

See [the readiness and pilot runbook](ASK-YOUR-DATA-OPERATIONS.md) for runtime
delivery, free preflight, staff/retention checks, controlled activation and rollback.

## Engineering evaluation

`e2e/support/ask-engineering-evaluation.mjs` is an explicit opt-in, 106-scenario
real-provider evaluation. It uses engineering AWS SSO, an isolated local
`ask_test_evaluation*` PostgreSQL database and synthetic MCP data. Every paid
call passes the actual atomic reservation/dispatch/usage ledger, with no SDK or
AWS retries and a five-dollar engineering ceiling. Configure the currently
verified `ASK_EVALUATION_MODEL`, `ASK_EVALUATION_REGION` and
`ASK_EVALUATION_PRICING_JSON`, plus the explicit AWS profile, isolated database
and external temporary output path. `ASK_ENGINEERING_EVALUATION=true` is
required. A failed scenario stops by default; an interrupted invocation keeps
its uncertain reservation. The test-only byte counter is deliberately
conservative; this harness does not establish live Mantle or tenant-MCP
availability, PromQL correctness, customer authentication or provider billing.
Browser tests and the independent HTTP/PostgreSQL suite cover the other
boundaries; tenant deployment still needs its actual readiness/serving checks.

A scenario passes when the run reads exactly when it should and the answer holds
what it should. No answer names the run's machinery (a tool call, `present_answer`,
the server's read). The six `offtopic-*` questions (general knowledge, in English
and Hebrew) are declined in at most 400 characters and never carry the answer
itself. The in-scope explanations and date and time questions carry the
explanation or the date, so a scope rule that declines them fails.
`ASK_EVALUATION_CASES` picks scenarios by id and `ASK_EVALUATION_REPEAT` (1 to 5)
runs each of them that many times.

`ASK_EVALUATION_LONG_HISTORY=true` seeds twelve local fixture discussions and
extends the measured question within the product's size limit. Fixture history
is not inference output; the measured new turn and any setup query still use
real provider dispatch and accounting. Recorded input byte sizes make context
admission regressions visible without logging a live customer's messages.
