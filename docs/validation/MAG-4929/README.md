# MAG-4929 foundation validation — 16 November 2026

Base: dashboard `main` at `1cde91d4`. Runtime: Node 26.13.1, pnpm 12.21.0,
matching the repository pins. Work was isolated in a fresh worktree; the original
checkout and its two untracked reliability documents were preserved.

## Local verification

- `pnpm typecheck`: all workspace packages passed, including web and e2e types.
- `pnpm test`: 3,614 tests passed: shared 1,394; web 760; db 95; API 1,365.
- New API adapter/session tests: 28 passed. These include real MCP SDK JSON/SSE
  transport against mocked upstreams, exact customer mapping, broad/staff denial,
  source/result ownership, local read-only policy, strict parameters, cancellation,
  response/context bounds, usage-before-validation and no automatic model retry.
- Capability routes use the real dashboard session gate with PGlite; live-session
  revocation is tested. No paid question route is registered.
- Shared contract tests cover structured answers, evidence, invalid ranges,
  tenant/header/URL injection, paging and local navigation preferences.
- `pnpm lint`: zero errors; 14 pre-existing warnings in untouched components and
  the metrics service. Targeted lint of new files passes without warnings.
- Shared/database/API builds passed. `git diff --check` passed.

These tests do **not** establish live providers, network HTTP against independent
PostgreSQL connections, browser behavior, deployed runtime secrets or the pilot.
Those acceptance items remain open in the implementation ledger.

## Current external access evidence

The bounded provider preflight reached Bedrock in `us-east-1` for the historically
configured `global.anthropic.claude-sonnet-5` profile and received **HTTP 403** on
16 November. No token usage was returned. This proves reachability and refusal,
not current model access or the reason for the refusal. No credential was printed.

The configured AWS profile `magma` has an **expired session**. The account identity
check could not complete, so no GK8 SSM credential was retrieved and no customer
MCP read was attempted. This does not establish that the stored customer grant
itself expired. The existing source of that credential is the encrypted delivery
parameter `/smart-router-mcp/staging/access/gk8/pilot-20261014`.

The full controlled question → customer MCP → Bedrock → validated answer check is
therefore **pending current provider access and authorized customer credential
retrieval**. The offline integrated checkpoint passed, but is reported separately.
The new `ask:smoke` command can repeat the actual check after runtime credentials
are available. It prints bounded metadata/usage only, not customer result bodies.

No cloud resources, IAM policies, real user credentials, feature flags or customer
deployments were changed by this validation. No GK8 rollout is claimed.
