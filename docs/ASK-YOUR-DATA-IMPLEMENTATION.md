# Ask your data implementation and acceptance

Canonical product scope: [MAG-4750](https://magmadevs.atlassian.net/browse/MAG-4750).
This implementation starts at dashboard main `1cde91d4` on 16 November 2026.
The earlier Bedrock PR #200 and visual prototype PR #300 are reference material.

## Delivery

Each slice receives a separate pull request with its tests and evidence. Dependent
branches may be stacked; their descriptions name their base and prerequisite PRs.
No slice enables customer spending before durable admission and cost enforcement.

| Slice | Implementation | Acceptance evidence |
| --- | --- | --- |
| MAG-4929 | Shared contracts, strict structured answer validation, managed/live-session gate, server-only Bedrock and MCP adapters, exact customer credential verification, controlled operator smoke | Offline adapter/auth tests; current provider/catalog smoke or exact unavailable access recorded |
| MAG-4930 | PostgreSQL chats, messages, runs, idempotency, personal history/search, preferences, database queue and leases | Two customers/two people, HTTP over actual PostgreSQL, independent API instances, retries, restart and cancellation |
| MAG-4931 | Bounded Bedrock tool loop, audited read allowlist, per-source policy, source/time evidence, history context | Metrics/log/status questions, malicious retrieved instructions, invalid/truncated responses, timeout and cancellation |
| MAG-4932 | Atomic monthly cost reservation/reconciliation, internal records/export, scheduled retention | PostgreSQL concurrent spend admission; every model step, failure/cancel/unknown usage, staff/customer access and retention cutoffs |
| MAG-4933 | Top-bar entry, keyboard shortcut, panel/pill, /ask, shared history/search/deep links, last-view preference | Real browser against API/PostgreSQL: ask, reload, minimize, expand/back, stop, ownership and disabled routes |
| MAG-4934 | Runtime configuration delivery, operational checks and controlled GK8 flag | Current MCP/Bedrock results, browser-to-provider flow, configured cap, cleanup/export, enable/disable evidence and dated pilot start |

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
  active-run lock and bounded budget reservation. Workers claim with leases and
  fencing tokens; each step records usage. No work depends on a browser connection.
  A crashed in-flight provider call is uncertain, never blindly replayed or freed.
- Run states: queued, running, cancelling, succeeded, failed, cancelled,
  interrupted. Persist terminal error codes. Recovery releases personal admission
  while preserving uncertain financial reservations for reconciliation.
- Idempotency keys are scoped to customer and person; a reused key with a different
  request returns a conflict. The same retry returns the existing run.
- Reserve integer USD microdollars against the run's original UTC calendar month,
  including across month rollover. Default cap: $10/customer/month shared across
  people and Ask/Investigate. Version model/region prices and include all billable
  usage categories. Missing usage retains a conservative reservation.
- Answers have bounded summary/sections and server-authored source/time evidence.
  Tool errors, no data, partial coverage and truncation remain distinguishable.
  Render plain text; no model-authored HTML, URLs or executable content.
- Personal history is private to its person/customer. Internal prompt access uses
  explicit trusted Magma staff identity, never the customer's admin role or email
  domain alone. No public/internal endpoint accepts a customer override.
- Chats and prompt content expire after 90 days or a shorter customer policy.
  Retention is a leased, observable scheduled job. Minimal accounting without
  prompt/answer content can survive for reconciliation; deletion must not reset
  monthly spend. Runtime secrets and credential-shaped text are never logged.

## API contract

The shared package owns request/response types and answer validation. All chat
routes require a currently valid dashboard session, managed deployment and the
server's customer feature flag. No spending route exists in the foundation PR.

| Method/path | Meaning |
| --- | --- |
| GET /api/ask/capabilities | Availability, supported answer contract; no secrets or budget amount |
| GET/POST /api/ask/chats | Personal paginated/searchable history; create personal chat |
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

All items below start **pending**, independent of a PR being opened or merged.
Each implementation slice adds dated commands/results and remaining limits.

- [ ] Customer identity, source ownership and read-only enforcement
- [ ] Managed/customer flags and current-session gate on UI and API
- [x] Two customers and personal ownership through HTTP/real PostgreSQL — [MAG-4930 evidence](validation/MAG-4930/README.md)
- [ ] Separate API replicas, idempotency, leases, crash/restart and cancellation
- [ ] Every model step reserved/accounted; shared-customer concurrency and rollover
- [ ] Malicious prompts/logs cannot change tools, customer, endpoint or credentials
- [ ] Answer contract, evidence/time context, missing/partial/truncated data
- [ ] Personal history, search, pagination, direct links and last view
- [ ] Browser panel/full flow, minimize, navigation, reload, copy and stop
- [ ] Internal authorized staff read/export and customer denial
- [ ] Observable scheduled retention with tested cutoffs
- [ ] Runtime secret/config delivery and current Bedrock model/region access
- [ ] Current customer MCP discovery and bounded actual data read
- [ ] GK8 cap, feature enable/disable and operational rollback verified
- [ ] Dated GK8 pilot start; 60-day product measurement handed to MAG-4642

Local mocks prove policy and failure handling, not provider availability.
Historical MCP deployment receipts are dated evidence, not a live state API.
No acceptance item is complete without the corresponding observed evidence.

## Pull request progress

- [PR #389](https://github.com/Magma-Devs/smart-router-dashboard/pull/389): foundation,
  contracts and adapters. Current live access is still pending (Bedrock HTTP 403;
  expired `magma` AWS session). This does not block independent database/UI work.
- MAG-4930 adds the durable data model, authenticated history/preferences routes
  and SQL lifecycle primitives. Actual HTTP/PostgreSQL verifies ownership,
  idempotency, concurrency, lease fencing and recovery. Production worker
  scheduling, financial reconciliation and UI acceptance stay open.
