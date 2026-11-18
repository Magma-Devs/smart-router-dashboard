# Native provider and internal runtime validation

16 November 2026. These checks use an isolated local dashboard/API/PostgreSQL
stack and actual staging MCP / AWS Bedrock services. They do not enable a
customer deployment or start the pilot.

## Provider boundary

The renewed `magma` SSO identity was verified against AWS account 811430801429.
The existing Bedrock environment credential belonged to a different account and
was denied free Mantle token counting. It was not used for customer data.
An owned one-day IAM identity was instead limited to the configured Sonnet 5
inference profile and its foundation model, bearer authentication, and
`bedrock-mantle:CountTokens` on this account's default project with the exact
model condition. No broad runtime fallback or permanent IAM identity was added.

Owned one-day customer-only pilot MCP grants verified `whoami`, the current
catalog and actual bounded metrics/log reads. The catalog exposes metrics,
logs and Grafana; it does **not** expose `status.chain_events`. Foreign-source
and write requests were refused by the dashboard adapter before dispatch.
Revoking a test grant subsequently returned HTTP 401. The expired historical
pilot key was not overwritten or reactivated.

Native Sonnet 5 exposed compatibility differences that synthetic responses did
not cover. The adapter now selects the documented disabled-thinking mode,
recognizes matching cache-counter aliases without double counting, and accepts
only absent/empty server-tool usage. Conflicting aliases or additional unpriced
usage remain uncertain. Client `tool_use` markers are normalized; server tool
requests are refused after accounting for observed token usage.

The orchestrator offers a local `present_answer` tool after a successful read,
using Bedrock strict tool generation for field types, required properties and
enums. Its provider schema uses the documented supported subset; unsupported
length/array upper bounds remain field descriptions for generation and hard
checks in the unchanged shared answer schema. Evidence/time fields
are authored by the server. Presentation never dispatches to MCP. Mixed calls,
invented fields and invalid bounds are refused. The last available model step
formats collected evidence rather than opening more reads. Batched requests
above the read cap receive a local limit result without additional source I/O.
The existing step, token, time, context and $10 customer/month limits remain.

The server also supplies numeric UTC bounds for common relative windows. Live
checks assert current metrics/log query times, preventing an otherwise valid
query from silently using a model's incorrect year conversion.

## Price provenance

The [official AWS pricing page](https://aws.amazon.com/bedrock/pricing/) and its
[USD price dataset](https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrockfoundationmodels/USD/current/bedrockfoundationmodels.json)
(manifest published `2026-11-09T22:43:12Z`) were checked on 16 November.
For **Global Cross-region Inference / Standard / Claude Sonnet 5**, USD per
million tokens: input 2; output 10; five-minute cache write 2.50; one-hour cache
write 4; cache read 0.20. Geographic and in-region rates are different.
The validation rate card expires at `2026-11-17T00:00:00Z`; it is not a standing
production configuration or a claim that these rates will remain current.

## Internal access and scheduled retention

[The metadata-only receipt](staff-runtime.json) records an actual browser
password-change / PKCE exchange for an owned one-day Cognito staff identity
restricted to the pilot customer. No enrollment email was sent and no employee account changed.
Against the normal local API with `ASK_DATA_ENABLED=false`:

- Live staff could read health, records and NDJSON export. A customer override
  was refused; a genuine dashboard admin session was denied all three routes.
- A synthetic 91-day-old run was hidden immediately and physically deleted by
  scheduled runtime maintenance, including its message cascade. Current content
  stayed readable. Health reported a successful sweep and its deletion count.
- Monthly pools and financial receipts were unchanged by content deletion.
  Two original unknown-usage reservations stayed held; later successful parsing
  does not authorize releasing an earlier unknown receipt.
- Disabling the staff grant invalidated its existing token on the next request.
  The OAuth family was revoked and the owned user/enrollment parameter deleted.

## Repeatable browser check

[The native browser receipt](native-browser.json) records three successful
questions: current metrics, recent logs, and availability of provider-status
evidence. All three persisted and remained visible after reload. Metrics and
log evidence used current numeric time bounds. The log result includes both
empty reads and an explicitly partial/truncated read; it is not a claim of full
log coverage. The provider-status capability is absent from the current catalog.
Ten model steps settled from actual usage receipts, charging **$0.161894** for
this successful check. Every step used normal free counting/reservation before
dispatch. Earlier validation attempts remain in the same local monthly pool:
$0.722016 cumulative settled spend and $0.072504 held for two original unknown
receipts, under its $10 limit. This is the disposable validation database, not
the pilot production budget. Test content was deleted while accounting survived;
all temporary provider credentials/grants were revoked/deleted.

[A second native run](native-panel-full.json) explicitly starts in the panel,
minimizes while processing, reopens the persisted answer, expands into the full
view and reloads. Follow-up log/status questions run in the full view. All three
answers pass, including an automated missing-status caveat check. Its nine
settled model steps cost $0.132606; the cumulative disposable pool is then
$0.854622 spent and the same $0.072504 held. This covers both live views, rather
than inferring panel acceptance from the deterministic provider fixture.

The final code passes 3,733 workspace tests plus 24 actual HTTP/PostgreSQL checks,
workspace typecheck, API production build and lint (zero errors, 14 existing
warnings). Four deterministic browser flows also pass with native-style client
tool markers, presentation calls and matching cache aliases. Those fixture
flows remain separate from the real-provider receipt above.

The explicit live configuration is separate from deterministic CI browser tests:

```sh
E2E_ASK_LIVE=true E2E_OWN_SERVERS=true \
  pnpm --filter @sr/e2e exec playwright test -c ask-live.playwright.config.ts
```

Supply the server-only provider configuration, a current verified rate card,
currently verified source IDs, owned temporary metadata/result paths and local
URLs/database through the parent process environment. The config refuses CI,
non-local servers, reused servers and databases outside `ask_test_live*`.
The browser asks through normal admission and the budgeted worker, validates
persisted structured answers/evidence, and verifies reload. It preserves the
monthly pool and every model-step receipt across runs. The observer records
protocol shape/usage only and never transforms a provider response. Screenshots,
traces and video are disabled; the page closes before failure artifacts can
capture customer content. Only metadata receipts should be retained.

## Current cloud policy observations

The [read-only control-plane receipt](cloud-policy.json) confirms private,
encrypted fleet RDS instances: DEV automated backups retain seven days, PROD
fourteen days, with an encrypted PROD replica in us-west-2 retaining fourteen
days. The receipt records the actual restorable windows, not an exercised
restore. Both parameter groups are in sync with explicit `pgaudit.log=ddl,role`
and `pgaudit.log_parameter=0`. Other statement/parameter logging settings are
reported as engine defaults without an effective value by this API; no SQL
session was used to infer their running values. Bedrock invocation logging is
not configured in this account/region at the time of the read. This does not
claim a provider-wide retention policy or deletion from backups. A restored
database must run retention and verify expired content is inaccessible before
customer/internal traffic is admitted.

## Remaining deployment work

Released dashboard/chart pins, permanent runtime credential delivery, deployed
database backup/restore retention, controlled pilot enable/disable/rollback and
the dated pilot start remain open. The separate 60-day measurement is not
claimed. No customer flag, deployed Secret or tenant pin was changed by these
checks.
