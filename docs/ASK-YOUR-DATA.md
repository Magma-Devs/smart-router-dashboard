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

Workers claim queued runs with `FOR UPDATE SKIP LOCKED`, a unique fencing token
and a bounded lease. Completion, heartbeat and failure first acquire the row
lock, then recheck the current wall clock in a second statement: PostgreSQL may
evaluate an UPDATE's WHERE before a lock wait. A lease that expires during that
wait cannot be extended or publish a late answer. Success and its assistant
message commit together, after answer validation. A failed/cancelled/interrupted
run creates no assistant success message.

Queued cancellation is terminal; a running cancellation requests durable stop.
Recovery terminates lost/old/revoked-session runs without replaying potentially
billable work. The user's admission is released; any future financial reservation
stays for reconciliation. Runs record the original session ID without a foreign
key that would prevent normal expired-session cleanup.

A replica that has not finished readiness checks pauses queue claims; only a
confirmed feature/admin disable interrupts work. Queue waiting and execution
share one deadline measured from submission. Expiration reports `ASK_TIMEOUT`,
while lease loss, revocation and shutdown remain interruptions. Stop reaches
free token counting as well as MCP/model requests. Heartbeats run independently;
execution-boundary authorization no longer opens a heartbeat transaction for
every tool. Fixed error codes and per-phase durations provide diagnostics without
logging questions, answers, tool results or credentials.

The API starts the worker once the database is ready, with the budget hooks
below installed, on a managed deployment with Ask enabled and a valid rate card.

## Bounded tool execution

The API runs a bounded AI SDK `ToolLoopAgent` against the existing native
Bedrock adapter. `present_answer` is available from the first step: ordinary
conversation, clarifications and explanations of earlier answers need no data
read. Every paid conversational reply still has normal atomic reservation,
dispatch fencing and usage reconciliation. There is no question-word regex
routing. Every turn receives the current server clock and precomputed query
windows; the current UTC reference is explicit and never comes from an old answer or a browser identity override.

Data tools have locally authored names and parameter schemas. The customer MCP
connection opens only on the first requested read. Identity verification comes
first; independent catalog/tool-list requests then run concurrently. Every read
rechecks identity and the immutable local policy. A source is selected implicitly
only if exactly one authorized source supports the operation; ambiguity returns
choices and never sums replicas. Remote descriptions cannot grant tools.
Metrics/log reads keep their 24-hour bounds; provider-status event reads keep
their seven-day bounds.

`router_request_summary` selects the dashboard's recorded request/failure or transaction families into two verified MCP reads over the same window. Missing series stay
unknown, without a zero fallback. The newest approximately two minutes of
recorded counts are marked partial. Counts do not establish an acceptable error rate or a cause without actual evidence and an SLO. `router_recent_requests` reads a small, customer-scoped backwards sample of the dashboard's `relay_end` events for request details. Sampling never proves the absence of errors. Effective status/instant-query times and literal lookback windows are returned explicitly; absence of a provider-status source is reported as unavailable.

Model dispatch guards live inside the model execution boundary, not SDK
notification callbacks. Automatic model retries and tool repair are disabled.
A provider's complete response is locally validated before persistence/display;
text preceding a valid presentation is discarded. A blank heading receives a neutral label; a long summary flows into body text without dropping words, changing facts or paying for another formatting request. The model may return a concise summary alone; it is persisted as a v1-compatible reply section that the UI shows once, so rolling back keeps history readable. Data replies still require actual successful reads.
Invented evidence references, unbacked stats, mixed final/read calls and unknown
fields are rejected after usage is recorded. The native presentation schema
constrains structure; the full local schema enforces size and grounding limits.
Existing complete-JSON replies remain accepted only after full validation, with
no second paid formatting call. Empty, partial and unavailable data remain
distinguishable.

The system prompt tells the model where transactions and failed requests live,
in the Transactions tab's own terms: the `relay_end` line filter
(`TX_EVENT_FILTER`), the recorded per-minute counts
(`smartrouter_transactions:count1m`, `smartrouter_final_{requests,failures}:count1m`)
and how an outcome reads as accepted, rejected, failed on chain, failed or
unknown (`txResultOf`). It also sets how an answer is written: plain sentences,
the covered time said once, no source IDs, label names or queries in the prose.

At most 5 model steps and 8 data reads run; a step can request at most 4 tools.
Individual tool context is capped at 12,000 bytes with explicit partial coverage;
the whole request remains capped at 64,000 bytes. Prior personal messages are
bounded role-based messages, explicitly historical evidence. Replicated sources must not be summed; correlation
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
session/lease loss and feature disable, and aborts work at shutdown/deadline.
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
stable run states/error codes and response types. Model content is bounded to a
summary and 1-8 sections, with optional points/stat. Server-authored evidence adds
the actual source, operation, observation/query times, coverage and truncation.
No model HTML is rendered. The server validates before persistence/display.

Bedrock uses [Converse](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html),
with a fixed server-selected region/model and explicit maxTokens. No temperature
is sent. Context is capped at 64,000 UTF-8 bytes; output at 2048 tokens. The adapter
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
each paid step, the free Bedrock token counter includes the system, messages and
tool schema. A bounded input margin and maximum output are priced at the highest
configured input/cache rate, then reserved atomically. A second transaction proves
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
same Anthropic model. Runtime CountTokens is not available for every CRIS-only
model. Mantle requires the explicit base model ID and the appropriate project
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
reservation uncertain. Never-dispatched reservations are released after terminal
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

The page is the conversation in a centered reading column, with **History** and
**New chat** above it. History replaces the conversation with the person's
chats: searched by POST body, grouped by local calendar days and paginated.
Earlier messages load without losing the reading position. Completed
errors/cancellations are included with retained messages, so reload does not
erase the outcome.

A new chat's questions default to the last 24 hours, the most one read may
cover. A follow-up keeps the chain and router its chat started with (chats from
before Ask became one page may carry them) over a time of the same length that
ends now. The composer shows no scope line.

Questions use right-aligned bubbles. Structured answers render as plain text,
with a summary, quiet numbered headings and optional compact inline stats. Copy
feedback, answer timestamps and expandable sources follow each answer; a source
reads as Logs, Metrics or Data, and carries a tag only when its data was
missing or cut short. A short answer keeps its question visible; a long answer
opens at its start. Reading older messages is not interrupted. The composer
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

`e2e/support/ask-engineering-evaluation.mjs` is an explicit opt-in, 100-scenario
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

`ASK_EVALUATION_LONG_HISTORY=true` seeds twelve local fixture discussions and
extends the measured question within the product's size limit. Fixture history
is not inference output; the measured new turn and any setup query still use
real provider dispatch and accounting. Recorded input byte sizes make context
admission regressions visible without logging a live customer's messages.
