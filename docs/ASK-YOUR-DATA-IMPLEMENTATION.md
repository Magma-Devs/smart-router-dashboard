# Ask your data implementation and acceptance

Canonical product scope: [MAG-4750](https://magmadevs.atlassian.net/browse/MAG-4750).
This implementation starts at dashboard main `1cde91d4` on 16 November 2026.
The earlier Bedrock PR #200 and visual prototype PR #300 are reference material.

## Delivery

The complete dashboard feature is reviewed in **PR #405 only**, from
`release/MAG-4750-managed-ask` to `main`. Put review comments, fixes and approval
on that PR. The seven implementation-slice PRs are closed as superseded; their
links below preserve the implementation history and evidence. They require no
separate approval, merge or integration-branch sequence.

The repository permits squash merges only. The dashboard ships in **one stable
release**, with one `VERSION` increase and changelog entry. Before merge, apply
review fixes to #405, reconcile current main and rerun affected checks. The
customer's requested test-server validation precedes any merge or production
deployment. Review readiness does not authorize deployment.

`release/MAG-4750-managed-ask` is that aggregate release candidate. It proposes
`0.71.0`, the next feature minor after main's `0.70.0`, with one
[changelog version entry](../CHANGELOG.md). Closed slice PRs remain available as
historical references. An open PR reserves no release number: verify the then-current
main and tags before merging and adjust this one release proposal if needed.
Readiness for review does not establish deployed acceptance or authorize rollout.

| Slice | Implementation | Acceptance evidence |
| --- | --- | --- |
| MAG-4929 | Shared contracts, strict structured answer validation, managed/live-session gate, server-only Bedrock and MCP adapters, exact customer credential verification, controlled operator smoke | Offline adapter/auth tests; current provider/catalog smoke or exact unavailable access recorded |
| MAG-4930 | PostgreSQL chats, messages, runs, idempotency, personal history/search, preferences, database queue and leases | Two customers/two people, HTTP over actual PostgreSQL, independent API instances, retries, restart and cancellation |
| MAG-4931 | Bounded Bedrock tool loop, audited read allowlist, per-source policy, source/time evidence, history context | Metrics/log/status questions, malicious retrieved instructions, invalid/truncated responses, timeout and cancellation |
| MAG-4932 | Atomic monthly cost reservation/reconciliation, internal records/export, scheduled retention | PostgreSQL concurrent spend admission; every model step, failure/cancel/unknown usage, staff/customer access and retention cutoffs |
| MAG-4933 | Top-bar entry, keyboard shortcut, panel/pill, /ask, shared history/search/deep links, last-view preference | Real browser against API/PostgreSQL: ask, reload, minimize, expand/back, stop, ownership and disabled routes |
| MAG-4934 | Runtime configuration delivery, operational checks and controlled pilot flag | Current MCP/Bedrock results, browser-to-provider flow, configured cap, cleanup/export, enable/disable evidence and dated pilot start |

MAG-4642 follows with the error-row Investigate entry point and reuses chats,
budget and execution. MAG-4751 self-hosted distribution remains a separate product.

## Decisions

- Keep the existing Fastify/Next.js/PostgreSQL stack. Bedrock is invoked by the
  API with a server runtime bearer secret. Never fall back to a broader identity.
- A deployment has one server-configured customer ID and one customer-only MCP
  credential. Verify `whoami` and all discovered source ownership before reads.
  Reject staff/multi-customer identities, including one with the expected customer
  among broader grants. Recheck at execution; filters cannot authorize access.
- Discover the actual deployed MCP catalog. Support both the older single-customer
  and newer explicitly attributed response shapes only after strict validation.
  `chain_events` is capability-dependent. Missing status evidence is reported.
- PostgreSQL is the durable queue. Submission atomically commits a run, personal
  active-run lock and budget eligibility. Each paid step first counts tokens
  for free, then atomically reserves a bounded cost. Workers claim with leases and
  fencing tokens; each step records usage. No work depends on a browser connection.
  A crashed in-flight provider call is uncertain, never blindly replayed or freed.
- Run states: queued, running, cancelling, succeeded, failed, cancelled,
  interrupted. Persist terminal error codes. Recovery releases personal admission
  while preserving uncertain financial reservations for reconciliation.
- Idempotency keys are scoped to customer and person; a reused key with a different
  request returns a conflict. The same retry returns the existing run.
- Reserve integer USD microdollars against the paid step's UTC calendar month
  using PostgreSQL time. Dispatch rechecks that month; an undispatched reservation
  crossing rollover is released after interruption, never charged to another month. Default cap: $10/customer/month shared across
  people and Ask/Investigate. Version model/region prices and include all billable
  usage categories. Missing usage retains a conservative reservation.
- Answers have bounded summary/sections and server-authored source/time evidence.
  Tool errors, no data, partial coverage and truncation remain distinguishable.
  Render plain text; no model-authored HTML, URLs or executable content.
- PromQL/LogQL accept bounded literal range selectors; advanced subqueries,
  duration arithmetic, offset and @ modifiers are denied before MCP dispatch.
  Source-side cardinality, memory, sample and execution limits remain necessary.
- Personal history is private to its person/customer. Internal prompt access uses
  explicit trusted Magma staff identity, never the customer's admin role or email
  domain alone. No public/internal endpoint accepts a customer override.
- Chats and prompt content expire after 90 days or a shorter customer policy.
  Retention is a leased, observable scheduled job. Minimal accounting without
  prompt/answer content can survive for reconciliation; deletion must not reset
  monthly spend. Runtime secrets and supported credential formats are redacted
  before storage/model use; collector-side redaction remains necessary for other
  secret formats and customer-specific sensitive data.

## API contract

The shared package owns request/response types and answer validation. All chat
routes require a currently valid dashboard session, managed deployment and the
server's customer feature flag. No spending route exists in the foundation PR.

| Method/path | Meaning |
| --- | --- |
| GET /api/ask/capabilities | Availability, supported answer contract; no secrets or budget amount |
| GET/POST /api/ask/chats | Personal paginated history; create personal chat |
| POST /api/ask/chats/search | Search personal history with search text in the request body |
| GET /api/ask/chats/:id | Authorized chat and ordered messages |
| POST /api/ask/chats/:id/runs | Idempotent submission with validated page context |
| GET /api/ask/runs/:id | Authorized run state and validated terminal response |
| GET /api/ask/runs/active | This person's active question across all their chats/tabs |
| POST /api/ask/runs/:id/cancel | Idempotent durable cancellation |
| GET/PATCH /api/ask/preferences | Last panel/full view, chat and originating local page |

Run polling uses the existing API client/auth bridge. A failed response never
becomes an assistant message claiming success. List cursors are validated and
bounded; direct IDs always require ownership checks.

## Acceptance ledger

The [17 November requirement-by-requirement and security review](validation/MAG-4934/REQUIREMENTS-SECURITY-REVIEW.md)
maps all ticket clauses to code, tests and PRs, records reproduced fixes, and
separates implemented behavior from the remaining deployed acceptance gates.

An item is checked only with corresponding observed evidence. Each slice records
dated commands/results and remaining limits; opening or merging its PR does not
establish acceptance.

- [x] Customer identity, source ownership and read-only enforcement — adapter tests and [scoped live checks](validation/MAG-4934/LIVE.md)
- [x] Managed/customer flags and current-session gate on UI and API — [browser evidence](validation/MAG-4933/README.md), API/HTTP gate checks
- [x] Two customers and personal ownership through HTTP/real PostgreSQL — [MAG-4930 evidence](validation/MAG-4930/README.md)
- [x] Separate API replicas, idempotency, leases, crash/restart and cancellation — [HTTP/PostgreSQL evidence](validation/MAG-4930/README.md)
- [x] Every model step reserved/accounted; shared-customer concurrency and rollover — [budget evidence](validation/MAG-4932/README.md) and [actual provider receipts](validation/MAG-4934/native-browser.json)
- [x] Malicious prompts/logs cannot change tools, customer, endpoint or credentials — [orchestration policy checks](validation/MAG-4931/README.md)
- [x] Answer contract, evidence/time context, missing/partial/truncated data — orchestration tests and [native browser checks](validation/MAG-4934/LIVE.md)
- [x] Personal history, search, pagination, direct links and last view — [browser evidence](validation/MAG-4933/README.md)
- [x] Browser panel/full flow, minimize, navigation, reload, copy and stop — [browser evidence](validation/MAG-4933/README.md)
- [x] Internal authorized staff read/export and customer denial — [actual staff OAuth/runtime checks](validation/MAG-4934/staff-runtime.json)
- [x] Observable scheduled retention with tested cutoffs — actual HTTP/PostgreSQL and [flag-off scheduled runtime check](validation/MAG-4934/staff-runtime.json)
- [ ] Runtime secret/config delivery and current Bedrock model/region access — [fleet delivery implementation](https://github.com/Magma-Devs/smart-router-infrastructure/pull/1494) is prepared; deployed scoped Secrets, released pins and a fresh exact-image checkpoint remain required
- [x] Current customer MCP discovery and bounded actual data read — [dated scoped live checks](validation/MAG-4934/LIVE.md)
- [ ] Pilot cap, feature enable/disable and operational rollback verified
- [ ] Dated pilot start; 60-day product measurement handed to MAG-4642

Local mocks prove policy and failure handling, not provider availability.
Historical MCP deployment receipts are dated evidence, not a live state API.
No acceptance item is complete without the corresponding observed evidence.

## Pull request progress

Review and approve [dashboard PR #405](https://github.com/Magma-Devs/smart-router-dashboard/pull/405).
The closed slice PRs below are historical implementation references, not an
additional review or merge queue:

1. [PR #389](https://github.com/Magma-Devs/smart-router-dashboard/pull/389): shared
   contracts, managed/live-session gates and customer-scoped server adapters.
2. [PR #390](https://github.com/Magma-Devs/smart-router-dashboard/pull/390): durable
   personal chats, history/preferences and fenced runs. Actual HTTP/PostgreSQL
   verifies ownership, idempotency, concurrency, lease fencing and recovery.
3. [PR #393](https://github.com/Magma-Devs/smart-router-dashboard/pull/393): bounded
   read-only orchestration, source/time evidence and a lease-aware queue worker.
4. [PR #394](https://github.com/Magma-Devs/smart-router-dashboard/pull/394): shared
   customer/month accounting, internal staff records and physical retention.
   Paid admission requires current pricing and the same-model free counter.
5. [PR #396](https://github.com/Magma-Devs/smart-router-dashboard/pull/396): complete
   panel/full/mobile chat UX and deterministic browser verification against the
   real API/database, including personal history, session changes and cancellation.
6. [PR #400](https://github.com/Magma-Devs/smart-router-dashboard/pull/400): runtime
   Compose configuration, free provider preflight and the operational runbook.
7. [PR #401](https://github.com/Magma-Devs/smart-router-dashboard/pull/401): native
   Sonnet 5 protocol/accounting, structured presentation and exact-image build
   metadata. Separate real-provider browser receipts cover full view and
   panel/minimize/full navigation. Actual staff OAuth, read/export, customer-admin
   denial, grant revocation and scheduled retention pass with the flag off.

[Dated provider/runtime receipts and limits](validation/MAG-4934/LIVE.md) preserve
the scope of each check. Earlier expired-access observations are historical;
they do not describe the successful later provider checks.

[Chart #189](https://github.com/Magma-Devs/smart-router-helm-chart/pull/189)
provides workload configuration/schema and backend-only Secret references.
[Fleet #1494 / MAG-5359](https://github.com/Magma-Devs/smart-router-infrastructure/pull/1494)
provides selected-customer configuration, enable/disable, fresh exact-image
checkpoints and Owner credential sealing. The chart and fleet retain their own
delivery paths and do not allocate additional stable dashboard versions.

Permanent runtime credentials, released pins and the deployed pilot
enable/disable/rollback rehearsal remain pending. The actual pilot start belongs
to MAG-4642 after that handoff. No customer flag, Secret or pin is changed by
these implementation PRs.
