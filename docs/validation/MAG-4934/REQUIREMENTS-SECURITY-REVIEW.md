# Managed Ask requirements and security review

17 November 2026. This review reads the current descriptions and linked work in
MAG-4750, MAG-4929–4934, MAG-5359 and MAG-5370. MAG-4642 and MAG-4751 are also
checked for scope. An implemented requirement below means code plus the named
verification, not a deployed customer capability or a guarantee against every
possible attack. The [live receipts](LIVE.md) remain dated provider evidence.

## Requirement coverage

All dashboard slices feed the single [release PR #405](https://github.com/Magma-Devs/smart-router-dashboard/pull/405).
The following rows map every product/build/Done-when clause, including clauses
shared by several tickets, to the owning review slice and executable evidence.

Dashboard #405 is the only active dashboard review. Slice numbers in this table
are closed historical references; their implementation is included in #405.
Chart #189 and infrastructure #1494 remain separate active reviews. Supporting
infrastructure #1504 is merged and requires no further review.

| Requirement | Owning PR / implementation | Verification and limit |
| --- | --- | --- |
| Managed customer opt-in; all signed-in roles; API and UI gate; on-prem/disabled/anonymous cannot spend | #389, #396; `config.ts`, `routes/ask.ts`, `AskProvider.tsx` | `ask-adapters`, `ask-routes`, disabled browser spec; `read_only` HTTP/browser flow. Deployed gate rehearsal remains open. |
| Browser never holds Bedrock/MCP secrets; runtime server bearer, fixed model/region and destinations | #389, #400, #401; `bedrock.ts`, `mcp.ts`, Compose; chart #189/fleet #1494 | Adapter endpoint/header/redirect checks, Compose checks, dated scoped provider receipts. Permanent deployed secrets/pins remain open. |
| Customer mapping verified with whoami; reject staff/multi-customer/foreign source/catalog/result; recheck before reads | #389/#401; `mcp.ts` | `ask-adapters` identity and result-envelope tests; dated live whoami/catalog/read. Filters grant no access. |
| Discover supported service tools and verify read-only execute_operation operations | #389/#393; local `readPolicy` in `mcp.ts` | Catalog intersection plus GET/readOnly/kind/schema checks; unknown operations, write annotations and credential arguments rejected before operation dispatch. Convenience tools cannot expand the local catalog. |
| Carry chain/time and both router axes from dashboard; preserve conversation context | #389/#396; shared `askPageContextSchema`, `AskProvider.tsx` | Shared strict-contract regression and router-scoped browser regression. Router values remain filter tokens, never endpoints or tenant identity. |
| Metrics, request logs, provider incidents and protocol changes; unavailable evidence stated | #393/#401; `orchestrator.ts`, `status.chain_events` policy | Metrics/log/status fixtures, partial/empty/error evidence, real metrics/log reads. Latest live catalog lacks status capability; deployed status data is **not** proved. |
| Top-bar entry and shortcut, no new menu item | #396; `AskEntry.tsx`, gateway shell | Ask component and Chromium flows. |
| Panel keeps dashboard usable; minimize to pill while work continues | #396; `AskSurface.tsx`, provider-owned state | Browser minimize/dashboard interaction/reopen; separate dated real-provider panel receipt. |
| One run/person across tabs and replicas; locked composer, Processing, Stop without step progress | #390/#393/#396; store unique constraint, worker, composer | Independent HTTP/PostgreSQL concurrency and lease tests; cross-tab browser cancellation. |
| Shared panel/full IDs; /ask, authorized deep links, Expand/back, same chat and originating page | #396; `AskProvider.tsx`, full view | Browser panel/full/back/reload/deep-link and ownership tests. Navigation destination is a local allowlist. |
| Last view remembered on server across browsers | #390/#396; preferences | Fresh API instance persistence and browser context with cookies but no local storage. |
| Private PostgreSQL history, grouped dates, pagination and search | #390/#396; `store.ts`, history UI | Person/customer ownership, scoped cursors, message paging/reading position, history search and browser grouping tests. Search text uses POST body. |
| Copy, completion date/time, one-line summary and numbered sections with optional points/stat | #389/#396; shared contract, answer view | Contract bounds and UI tests; Chromium copy/date/plain-text rendering. |
| API validates answer before storage/display; stable unavailable/invalid/truncated/cancel/interrupted/budget errors | #389/#393/#394/#396 | `ask-adapters`, `ask-orchestrator`, `ask-worker`, real PostgreSQL and browser error/retry/reload checks. Failed runs have no assistant success message. |
| Plain initial prompts and observed-question tuning; no sample-answer fallback | #393/#401 | Locally authored system prompt, mandatory successful read, validated presentation; real-provider receipts separate from synthetic fixtures. |
| Durable queue, atomic idempotency, leases/fencing, crashes/restarts, revoked sessions and cancellation | #390/#393; `store.ts`, `worker.ts` | Real HTTP/PostgreSQL independent connections, concurrent retry, stale completion, recovery, revocation and different-customer cancellation. |
| Untrusted prompts/history/logs/catalog; immutable tool/customer/credential boundary | #389/#393; strict schemas and catalog intersection | Forced malicious model requests after planted log instructions are denied; usage still recorded. These tests establish server enforcement, not universal model instruction-following. |
| Bound tool steps, query range/results, context/tokens/time; preserve source/observation/query windows | #389/#393/#394 | Adapter streaming/deadline tests, query-text guard, context/output limits, worker cancellation and server-authored evidence. Source-side cardinality/resource limits still require deployed verification. |
| Default $10/customer/UTC month, configurable, all people and Ask/Investigate share pool | #394; `budget.ts`, `pricing.ts` | Twelve competing people/replicas on real PostgreSQL; per-customer isolation and shared feature pool. Investigate entry UI is separate MAG-4642. |
| Reserve before every paid step, current versioned model/region prices, free count, include cache/reasoning billing | #389/#394/#401 | Counter/pricing tests and model dispatch ordering; real native usage receipts. Unsupported/missing usage retains a hold. |
| Retry/cancel/failure/crash/month rollover cannot erase incurred usage or double settle | #394 | Budget tests and real PostgreSQL late duplicate receipt, dispatch fence, reservation-after-retention and UTC boundary checks. No automatic paid replay. |
| Clear budget-limit error, no amount in customer UI | #394/#396 | Admission rollback, stable error contract and composer/UI tests; amounts only in staff health/export. |
| Retained person/customer/question/time/tools/latency/tokens/cost/answer/error | #390/#394; schema and `ask-internal.ts` | Real record persistence, per-step accounting and authenticated staff export tests. |
| Internal authorized Magma staff read/export; customer admin denied; no customer override or credential logging | #394/#401; `staff.ts`, internal routes, redaction | Staff identity/grant/foreign-customer/role tests; dated real OAuth export/revocation/admin-denial receipts; credential regression tests. |
| Content expires at ≤90 days or shorter policy, physically deleted by scheduled job; observable failure/retry | #394/#400/#401; `retention.ts`, runtime | Retention cutoff, retry/health and flag-off scheduling tests; dated actual PostgreSQL runtime sweep. Accounting remains without content. |
| Fresh linked PRs; original #200/#300 reference only; one stable dashboard release | #389–401 and #405 | No prototype prerequisite; slices do not change VERSION; aggregate proposes only 0.69.7 → 0.70.0. Final number must follow then-current main. |
| Generic customer onboarding through infra, exact-customer credentials/config, backend Secret references and isolated flags | chart #189; fleet #1494/MAG-5359 | Schema/render/Secret checks; two-customer fixture, guard mutations, selected-tenant-only edits, encrypted credential workflow. GK8 is a first tenant, not hardcoded authorization. |
| Released artifact prerequisites, exact-image checkpoint, enable/disable retaining identity/accounting/cleanup; safe rollback | #400/#401; chart #189; fleet #1494 | Local delivery/checkpoint fixtures and runbook. Actual released pins, permanent credentials and GK8 rollout/rehearsal remain **open**. |
| Reliable required editor-cleanup gate supporting fleet delivery | infra #1504/MAG-5370, included in #1494 | Real child-process regression, guard mutations, full editor suite and hosted CI. Original historical failing PID state is unobserved. |
| Live provider smoke and full browser/API/MCP/Bedrock/PostgreSQL flow, separately from mocks | #401; `LIVE.md`, provider/browser/runtime JSON | Dated native full/panel receipts exist. No new live provider test is claimed by this offline review. Exact released/deployed GK8 image remains open. |
| GK8 configured cap, observability, operational staff/retention, disabled other customers/on-prem, disable/rollback | MAG-4934, #400/#401, chart/fleet | Local and dated isolated runtime proofs exist; **deployed customer acceptance remains open**. |
| Pilot date and later 60-day outcome handoff | MAG-4934 → MAG-4642 | No pilot date recorded. Preserve baseline 49 support cases and 95% target; future outcome is not implementation acceptance. |

MAG-4642's error-row Investigate action (GUID/chain/time/error) is an **unimplemented
dependent follow-up**, not covered by these UI PRs. MAG-4751's paid self-hosted MCP
distribution is a separate unscheduled product, not a managed-chat prerequisite.
MAG-3702 is historical provisioning and cannot prove current access.

## Reproduced findings and fixes

1. **Credential disclosure through common field/header/URL formats.** The original
   redactor leaves `client_secret`, cookie and AWS-secret field variants, Basic/
   Digest headers, WebSocket/database URL paths and exact runtime secrets used as
   object keys. The new regression initially fails 29 of 38 cases. The fix expands
   normalized credential keys, whole header values, quoted assignments, private
   key blocks and connection URL scrubbing, and sanitizes object keys. Tests also
   check actual HTTP/PostgreSQL/history and the outgoing Bedrock request body.
   This does not classify arbitrary PII, encrypted/encoded secrets or all possible
   application-specific secret names; collectors must continue upstream redaction.
2. **Selected-router submission fails.** UI `router` is rejected by the strict
   shared context, and config `routerId` is omitted. The contract regression fails
   before adding the optional collector axis. The fix captures both axes, with
   strict token validation and browser panel/full/reload/follow-up verification.
3. **Query text bypasses the outer time-window bound.** Five adapter regressions
   initially admit long selectors, offsets, absolute time relocation, subqueries
   and duration arithmetic. A small fail-closed dialect guard now admits literal
   range selectors with a total ≤24h and rejects those advanced constructs before
   `execute_operation`. Quotes and comments are treated as data. The model is told
   this supported dialect. This is intentionally not a general query parser or a
   cardinality/CPU bound; the source must enforce sample/memory/time quotas.
4. **Production images contain advisories outside the workspace lockfile.**
   Trivy 0.76.2 with the 17 November vulnerability database reports 20 findings
   in each published arm64 image: six high, 13 medium and one low. Nineteen are
   in the base image's unused npm tree; the other is the Alpine zlib package.
   This is package detection, not proof of an exploitable application path.
   A minimal pinned runtime copies the target Node binary/entrypoint without
   npm, and installs pinned target-architecture libraries with zlib 1.4-r0.
   Host apk prepares the target root with scripts disabled, preserving the
   existing no-QEMU/final-stage-no-RUN build contract. Both amd64 and arm64
   runtime roots build and scan with **zero** findings. Native non-root Node,
   gzip and unauthenticated TLS to the Bedrock host pass. The full built images
   must pass the new exact-digest CI vulnerability scan before tag publication;
   the final PR checkpoint records their results separately from base-root scans.

## Security verification scope

The suites cover foreign IDs/cursors/customer overrides, role escalation and
revoked sessions; unsafe catalog claims and injected tool arguments; fixed
destinations, redirects, deadlines and streamed response limits; persistent and
reflected text/HTML handling; credential redaction before persistence/model use;
cross-replica run/financial races, uncertain usage and retention/accounting safety.
Final local verification on the combined candidate:

- **4,201 workspace tests pass**, plus **25 real HTTP/PostgreSQL tests** and
  **five Chromium flows** against the actual API/database with explicit synthetic
  provider boundaries. Typecheck and API/web production builds pass. Lint has
  zero errors and 14 existing warnings.
- **Six security guard mutations are killed by behavioral assertions**: normalized
  credential fields, complete header values, connection URL schemes, object-key
  redaction, query dispatch policy and the strict router context contract. Source
  is restored after every mutation; transform/compile failures do not count.
- Chart: **nine** real Helm render/schema tests pass. Fleet: **35** configuration,
  real owned-key crypto, Make and landing fixtures pass; **17** guard mutations
  are killed. They do not access a customer credential or deploy anything.
- Browser fixture isolation is corrected: each flow receives a fresh synthetic
  ingress address; the router flow uses its own read-only person so its persisted
  last-view preference cannot change the next person's starting state. Production
  rate limits, login, customer authorization and budget enforcement remain active.

- Production JS dependency audit: 285 total dependencies, zero known advisories
  at review time (`pnpm audit --prod --json`). This is not an OS/image scan.
- Redacted Gitleaks scan of each feature Git range: chart and fleet have no
  findings; dashboard reports four copies of the same deterministic synthetic
  TOTP encryption fixture in test files. Each is reviewed as fixture data, not a
  runtime credential. Findings are not suppressed with a broad path allowlist.
- GitHub CodeQL alert inventory contains no open managed Ask finding. One open
  historical Python logging alert belongs to `backend/app/api/routes/auth.py`,
  outside this TypeScript feature. New commit checks must pass before merge.
- Exact-image CI now pins Trivy 0.76.2 and its Linux arm64 release checksum,
  scans vulnerabilities before publishing tags and blocks high/critical findings
  or scanner/database failures. The runtime smoke also checks the image's actual
  default non-root UID and absence of bundled npm. Manual scans record every
  severity; a successful high/critical gate alone does not imply zero findings.
- No third-party hosted security scan, penetration test of a deployed customer,
  cloud-wide IAM audit or restored-backup test is represented by these checks.

## Operational failure modes that remain acceptance gates

- **Mixed replicas / flag propagation:** a rollout is complete only after every
  old replica is replaced and denials are observed. Provider revocation has its
  own propagation time; a boolean is not an instantaneous kill switch.
- **Budget configuration drift:** stale replicas may never raise a persisted
  pool. Raising the configured cap during a month does not raise an existing
  pool automatically; future months use the configured cap. Lowering requires
  disabled dispatch, consistent rollout and persisted-pool verification. An
  existing pool increase needs a separately reviewed reconciliation procedure.
- **Unknown provider outcome:** keep uncertain holds; settle from authoritative
  receipts. Retention, restart and rollback cannot release money speculatively.
- **Private data beyond primary tables:** deployed backup expiry, restore sweeps,
  effective database logging and provider invocation logging need runtime checks.
  The dated control-plane observations do not establish effective SQL defaults
  or deletion from every retained backup.
- **Source cost and capability:** request byte/result/deadline/dialect bounds do
  not replace upstream resource quotas. Verify actual per-customer query limits
  and status-source availability before promising those capabilities.
- **Release identity and health:** deploy the reviewed image digests/chart,
  verify current prices/counter/credential on every replica, then repeat both
  live views, staff read/export/cleanup and enabled→disabled→rollback checks.
  Record pilot start only after that evidence exists.
