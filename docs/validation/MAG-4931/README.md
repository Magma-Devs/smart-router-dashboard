# MAG-4931 orchestration and worker verification

This slice stacks on [PR #390](https://github.com/Magma-Devs/smart-router-dashboard/pull/390).
Provider execution remains inactive in the default API until durable budget
admission/reconciliation hooks are installed. No customer flag was enabled.

## Verified behavior

Orchestrator tests use the actual Bedrock adapter and local MCP operation policy,
with mocked provider responses and SDK client calls. They verify multi-step usage
callbacks/dispatch ordering, server-authored source/time evidence, bounded tool
results/context, multi-source reads and optional provider-status operations.

Negative cases cover foreign sources, remote write claims, injected tenant/header
arguments, planted log instructions followed by a foreign model request, no-tool
sample answers, all-source failures, upstream error bodies, malformed/truncated
answers, step/tool/context limits, cancellation and failed durable admission.
An active authorization check runs again between a model response and a tool read.

Worker tests use PGlite and synthetic sessions with mocked orchestration. They
verify queue claims, competing workers, ordered success persistence, stop without
an assistant success, feature disable, shutdown during a pending claim, lost lease
recovery, invalid output and prior personal history. The HTTP/PostgreSQL suite
from MAG-4930 is rerun against independent real connections; it remains the proof
for actual SQL concurrency and lock-wait behavior.

Logging tests verify that personal search and ORM-bound prompt values do not
enter ordinary application logs. Redaction tests cover known runtime secrets,
bearer/key fields and URL credentials/paths. They do not prove arbitrary data
classification or that every possible secret format can be recognized.

## Limits and current access

Deterministic mocked model responses prove the enforced tool/data boundaries and
failure behavior, not semantic accuracy on every possible live model answer or
general resistance to every prompt injection. Fixed source/operation/credential
checks remain outside the model. Actual question quality and current provider
availability require the later live smoke/pilot checks.

The current Bedrock preflight still returned HTTP 403. The `magma` AWS session is
expired. A separate existing `magma-rpc-maintenance` profile successfully verified
the expected account, but its policy denied the exact GK8 SSM delivery parameter.
No broader/staff data credential was substituted; no secret was retrieved or
printed. Customer MCP/live model validation therefore remains pending the proper
authorized runtime credential/access.

No cloud IAM policy, credential, customer deployment or provider resource changed.
Financial reservation/reconciliation, physical retention deletion, internal staff
records/export, browser UI/UX and controlled GK8 rollout remain later slices.

## Final local checks

- All 3,655 normal workspace tests passed; the 17 opt-in HTTP/PostgreSQL checks
  passed separately against independent real connections.
- Workspace type checks and API build passed.
- Lint passed with zero errors and 14 existing warnings; new code has no lint
  warnings. `git diff --check` passed.
- The focused Ask suites cover 57 adapter, route, orchestration and worker cases.
  Their mocked provider/model checks are separate from the real database checks.
