# Managed Ask: readiness and controlled pilot

Scope: [MAG-4934](https://magmadevs.atlassian.net/browse/MAG-4934), following the
[implementation/acceptance ledger](ASK-YOUR-DATA-IMPLEMENTATION.md). All customer
flags stay off until the current runtime checkpoints below have evidence. A green
fixture suite or a published image does not establish a live pilot.

## Single dashboard release

Dashboard PR #405 is the only dashboard review and release path. Its source
branch is `release/MAG-4750-managed-ask`, targeting `main`. The implementation
slice PRs are closed as superseded and require no separate approval or merge.
All review fixes belong on #405. The repository permits squash merges only.

This PR collects the complete feature against current main and proposes one
`VERSION` increase and changelog entry. Review, current-main reconciliation and
the user's test-server validation precede merge. Branch images are validation
artifacts; the stable dashboard release is shared by the complete feature.
Chart and fleet delivery use their own repositories and versioning. Pilot rollout
uses the resulting released dashboard image and the fresh checkpoint below.

The aggregate candidate is `release/MAG-4750-managed-ask`. It proposes `0.72.0`
with the full feature and one [changelog entry](../CHANGELOG.md). Closed slices
remain historical references. An open PR reserves no number: compare
current main and tags before merging and adjust that one proposal if needed.
Its branch images remain validation artifacts; review readiness does not turn
on the pilot deployment or replace the deployed checks below.

## Runtime delivery

Both web and API require `AUTH_MODE=enabled`, `DEPLOYMENT_MODE=managed` and the same
`ASK_DATA_ENABLED` flag. API ownership and accounting are authoritative even if a
stale browser still shows the entry. All signed-in roles can ask; the current
person's session and customer credential bound every read. A customer admin is
not an internal staff identity.

| Runtime | Configuration |
| --- | --- |
| Web | `ASK_DATA_ENABLED` only; no provider secrets, prices or budget |
| API | Exact `ASK_DATA_CUSTOMER_ID`, fixed trusted `ASK_DATA_MCP_URL`, customer-only `ASK_DATA_MCP_TOKEN` |
| API | Verified `ASK_DATA_BEDROCK_REGION`, `ASK_DATA_BEDROCK_MODEL`, `AWS_BEARER_TOKEN_BEDROCK` |
| API | Verified `ASK_DATA_TOKEN_COUNTER`, `ASK_DATA_TOKEN_COUNTER_MODEL`, dated exact-model/region `ASK_DATA_PRICING_JSON` |
| API | `ASK_DATA_MONTHLY_LIMIT_MICRO_USD=10000000` ($10 shared/customer/UTC month), `ASK_DATA_RETENTION_DAYS` (1–90) |

Both production and development Compose files pass these variables at runtime.
The managed Compose overlay uses a local SES mock: it is a development shape,
not a cloud deployment. Its dummy SES keys do not authorize Bedrock.

The fleet's workload templates belong to `smart-router-helm-chart`; tenant pins,
SOPS Secrets and ArgoCD delivery belong to `smart-router-infrastructure`.
`devops-magmadevs` owns the shared database/mail infrastructure, not this feature
flag. The chart's `dashboard.askData` maps the configuration above. Provider
Secrets are read key by key by the backend; values must contain references only,
because chart values are mounted as a ConfigMap. The frontend gets only the flag.
Keep customer identity, MCP URL and retention policy in the disabled configuration
so scheduled cleanup/reconciliation and authorized staff access continue.

A backend rollout stops each old API in order: it turns unready, claims no more
Ask runs, finishes its requests and gives running answers the drain window
(`SHUTDOWN_TIMEOUT_MS` less 8 s, 12 s by default) before interrupting the rest
with `ASK_INTERRUPTED`, then ends its database pool and exits 0. Questions it
never claimed stay queued for the new pod. The pod's database tunnel sidecar has
to outlive the API container for this; the API's log ends with
`shutdown: stopped in <n> ms`, and `shutdown: not stopped within` or an exit
code other than 0 means the sequence did not finish.

Use a released chart and dashboard images containing these changes. Prepare a
reviewable fleet PR through its existing make targets; follow that repository's
AGENTS.md and validate the exact pinned chart schema first. A merge is a fleet
deployment. No customer pin, Secret or live flag is changed by the dashboard or
chart implementation PRs.

## Current provider checkpoint

1. Securely inject the intended API configuration into the operator process from
   the approved secret source. Keep the deployed flag off. Confirm the exact
   customer mapping and that the MCP grant is customer-only, read-only and not a
   staff/multi-customer credential. Never fall back to a broader or cross-account
   runtime credential after a rejected check. Provisioning a new intended
   identity requires its own reviewed, narrowly scoped configuration.
2. Verify the current model/profile, region, counter mapping and all billing
   categories against the official AWS pricing and service documentation. Save
   the dated rate-card version/source/validity as evidence. There is no default
   guessed price or paid fallback for an unavailable free counter.
3. Run:

   ```sh
   ASK_DATA_PREFLIGHT=true pnpm --filter @sr/api ask:preflight
   ```

   The command validates configuration/current pricing, verifies MCP identity and
   discovers the locally approved catalog, then counts synthetic tool-enabled
   input with the configured free counter. It prints metadata only. It performs
   no source-data read, paid inference, database write or deployment change. It
   checks while the deployment flag stays off; its process-local adapter setting
   does not activate the API. A failure prints only stage and a fixed code.
   For fleet enablement, run `node apps/api/dist/ask-preflight.js` inside the
   exact released API image with `ASK_DATA_PREFLIGHT=true`. Its receipt includes
   the image's `APP_VERSION` and `GIT_COMMIT`; the release build supplies both.
   Local source runs without those build variables report null build metadata
   and cannot attest to a fleet image. Keep the successful metadata receipt for
   the enable target; it must match the selected dashboard pin and be less than
   one hour old. This is an operator checkpoint, not a signed attestation or a
   substitute for observing the running deployment.
4. After an authenticated test deployment is configured, enable only that test
   deployment and use its normal dashboard session with `ask:smoke`, as described
   in [the API guide](ASK-YOUR-DATA.md#controlled-operator-checkpoint). This is the
   first metered question: normal HTTP admission, durable worker, reservation,
   customer MCP data read and Bedrock structured answer. Preserve run/step/request
   IDs, usage and saved pricing; do not print raw questions, values or credentials.
5. Compare each model step's observed usage/cost and the monthly pool before/after
   with the provider's authoritative receipts. Validate a metrics, logs and status
   question; distinguish missing status capability, no data and partial coverage.
   Check semantic answer quality in the authorized browser, not only JSON shape.

If `magma` uses an expired AWS SSO session, the operator renews it with
`aws sso login --profile magma`, then verifies `aws sts get-caller-identity
--profile magma`. This refreshes local CLI credentials; it neither grants missing
permissions nor renews an independent Bedrock bearer. Do not save secrets in shell
history, PR bodies, screenshots, transcripts or ordinary application logs.

## Internal records and retention checkpoint

Using the separately authorized live Magma staff MCP OAuth identity, read
`GET /api/internal/ask/health`, `/records` and `/export`. Each is independently
verified through current `whoami`; no customer override is accepted. A customer
session/admin and another customer must be denied. Record verified subject/access
metadata and the denial status, never the OAuth credential.

Health must show recent maintenance attempt and success (a sweep is scheduled each
minute), no unexplained stale/error state, and the expected customer's monthly
limit/spent/reserved values. Monitor missing or stale `lastSuccessAt`,
`ASK_MAINTENANCE_FAILED`, `ASK_RETENTION_FAILED`, `ASK_START_FAILED`, unresolved
uncertain steps and held reservations. Two consecutive missed intervals require
investigation; recovery must preserve the last success and retry automatically.
An invalid configured retention cannot stretch cleanup past 90 days; it blocks
execution while maintenance uses the bounded policy.

Use an isolated test database to prove the 90-day and shorter-policy boundaries,
expired reads, physical deletion, retry and unchanged financial totals. Never age
or delete a customer's real records for a rehearsal. Record that runtime backups
may retain deleted content until their separate backup expiry; verify the current
backup and provider request-logging policies with the owners before pilot signoff.
The control-plane check recorded on MAG-4934 covers DEV seven-day / PROD
fourteen-day automated backups, the fourteen-day PROD cross-region replica,
explicit DDL/role audit with parameter logging off, and absent Bedrock invocation
logging. It does not establish effective SQL engine defaults or exercise a
restore. After restore, sweep retention and verify old
content is inaccessible before admitting customer or internal traffic.

Internal exports contain private content. Keep them in the authorized internal
location with its retention policy; ordinary rollout evidence contains metadata
only. Never reset monthly accounting or release a dispatched uncertain hold to
restore capacity. Investigate its provider request ID and settle from authoritative
usage. A clean terminal failure alone is not proof that no tokens were billed.

## Pilot enable, disable and rollback

1. Rehearse the exact released artifacts and enabled/disabled gates in an isolated
   managed deployment. Confirm two customer/two-person denial, personal history,
   one active run across replicas/tabs, Stop/restart recovery and a shared $10 UTC
   month cap. Inspect all pricing/counter and retention settings on every replica.
2. Prepare the pilot fleet PR only after its managed accounts/database prerequisites
   and the pinned chart/image releases are available. Preserve the previous pins
   and disabled configuration. Keep the change limited to the intended customer;
   no other customer flag becomes enabled. Run that repository's render, restart,
   fit and required PR checks. Its merge/labels remain its documented operator
   actions; do not apply ad-hoc Kubernetes changes that ArgoCD will revert.
3. After rollout, verify all replicas use the same customer, cap, pricing version,
   model/counter and retention policy. Check normal dashboard health, browser
   behavior, internal health/export access and one bounded metered question. Save
   the exact commit/image digests, rollout time, capability/denial results,
   source/catalog metadata, run/step/request IDs and accounting delta.
4. Rehearse disable through a fleet PR setting only `dashboard.askData.enabled`
   false, retaining identity/retention/database. Verify the web entry disappears,
   direct/API submission is denied, queued work is not dispatched, an active run
   is stopped safely and accounting/retention continue. A rolling deployment is
   not an instantaneous global kill switch: completion is when every old replica
   is replaced and denials are observed. For an immediate stop, an admin turns
   Ask off from the chat (or `POST /api/ask/switch` with `{"off": true}`): queued
   and running questions stop on every replica within seconds, no rollout, and
   the audit log records who did it (see "Turning Ask off" in
   [ASK-YOUR-DATA.md](ASK-YOUR-DATA.md#turning-ask-off)). The fleet flag stays
   the durable disable. An emergency credential revocation uses
   the provider's authorized operator process and has its own propagation time.
5. For rollback, keep Ask disabled, restore previous compatible image/chart pins
   through the fleet's version target, and verify existing dashboard/auth paths.
   Do not reverse migrations or delete chat/accounting tables. An older API does
   not run the new maintenance worker; if reverting it, keep a compatible disabled
   API performing cleanup/reconciliation or use the documented retention deadline
   to restore it before data expires. Re-enable only after the failed checkpoint
   is resolved and reverified. Lower a cap with all dispatch disabled, complete
   the consistent rollout and verify the persisted pool before resuming; automatic
   upserts never raise an existing pool cap.

Record a pilot start only after all required live checks and the enable/disable
rehearsal pass. Hand MAG-4642 the dated start, baseline (49 pilot-customer support cases),
95% self-service target, 60-day measurement window and the internal evidence
location. Sixty days of product outcome cannot be claimed on the implementation
date. No pilot start is currently recorded.
