# Smart Router Dashboard — Full-Stack Rebuild Plan (v2)

> **Supersedes the previous REFACTOR-PLAN.md entirely.** That document is
> disregarded. This plan rebuilds the Smart Router Dashboard from the new
> **SR Dashboard** design drop (`SR Dashboard/` — `Backend Metrics Mapping.md`,
> `CLAUDE.md`, `magma/*.jsx` prototype, `uploads/smartrouter_metrics.md`)
> to the **engineering standard** of `~/projects/lava-connect`.

## North star

Take the Smart Router Dashboard to the same *repo-quality bar* as **lava-connect**
(pnpm monorepo, TypeScript-strict everywhere, Fastify API, Next.js 16 web,
shared domain package, Docker dev + prod, Vitest, CLAUDE.md + `.claude/` rules),
**while keeping the product it actually is**: a Prometheus-driven, read-mostly
observability dashboard for Smart Routers.

lava-connect is the **shape reference only** — we copy its *tooling, structure,
and conventions*, not its *domain* (no billing, no Stripe, no users table).

### Three decisions that scope this plan (locked)

| Decision | Choice | Consequence |
|---|---|---|
| **Backend stack** | **Rewrite Python/FastAPI → TypeScript/Fastify** | Port `prometheus.py` + `calculations.py` + `configuration.py` to TS services; mirror lava-connect's `routes/ plugins/ services/ config.ts` layout. |
| **Persistence** | **No DB — Prometheus + helm-values only** | **Drop `packages/db` entirely.** No Postgres, no Drizzle, no migrations. Config is read from helm-values YAML; all live data is PromQL. Auth stays simple (basic / gateway token), not JWT-over-Postgres. |
| **Frontend** | **Rebuild from the new SR Dashboard prototype** | Implement the 4-tab Metrics design + shell (Overview / Traffic / Providers / Errors) from `magma/*.jsx`, wired to `Backend Metrics Mapping.md`. Current `dashboard/usage/configuration/wizard/api-keys` pages are legacy to be replaced/folded. |

---

## Where we are today (audit)

### Backend — `backend/` (Python 3.11 / FastAPI)
- **Stateless Prometheus proxy.** No DB. `httpx` → Prometheus `/api/v1/query[_range]`.
- Routes (`app/api/routes/`): `auth` (basic + gateway-token), `metrics` (14 endpoints
  incl. `chains-metrics`, `providers-metrics`, `chains-to-providers`, `usage`,
  `dashboard-summary`), `components`, `settings`, `keys`.
- Services: `prometheus.py` (163 LOC query client + chart shaping),
  `configuration.py` (196 LOC helm-values YAML reader → router/node config),
  `core/calculations.py` (647 LOC — adaptive step, percentile/rate math, the
  real domain logic). Pydantic models in `models/` + `core/dataclasses.py`.
- Tests: ~19 pytest files (`tests/`), `make tests` with coverage. **Good coverage to preserve as a behavioural oracle for the port.**
- Config via `pydantic-settings` (`PROMETHEUS_URL`, `TENANT_ID`, `AUTH_*`, `CORS_ORIGINS`, `helm_values_dir`).

### Frontend — `frontend/` (Next.js 16 / React 19 / TS)
- **Already TS + Next 16 + pnpm**, but **single-package** (`lava-infra-manager-dashboard`),
  `moduleResolution: bundler`, MUI X-Charts + Radix + recharts + reactflow mixed.
- Pages: `dashboard`, `usage`, `configuration`, `wizard`, `api-keys`, `live-test`.
- `services/` (metrics/keys), `types/metrics.ts`, `hooks/`, `lib/api-client.ts`, `lib/auth-context.tsx`.
- **Not** the new design. The new design lives in `SR Dashboard/magma/` (React+Babel prototype, not buildable as-is).

### Gaps vs. lava-connect standard
- No pnpm **workspace** / monorepo (`apps/*`, `packages/*`).
- No **shared domain package** — types duplicated across FE/BE (Python Pydantic vs TS).
- Two languages (Python BE, TS FE) → no shared types, two toolchains.
- No `tsconfig.base.json`, no `vitest.workspace.ts`, no root `pnpm -r` scripts.
- No `.claude/rules/`, thin `.claude/`, no CLAUDE.md at repo root.
- `tsconfig` is `bundler`/`ES6` (lava-connect is strict `Node16`/`ES2022` + `noUncheckedIndexedAccess`).
- Docker: workable but not the multi-stage workspace-aware pattern lava-connect uses.

---

## Target architecture

```
smart-router-dashboard/                 (pnpm workspace root)
├── package.json                        name: "smart-router-dashboard", scripts: build/dev/test/typecheck/lint (pnpm -r)
├── pnpm-workspace.yaml                 packages: ["packages/*","apps/*"]
├── tsconfig.base.json                  strict, Node16, ES2022, noUncheckedIndexedAccess  (copied from lava-connect)
├── vitest.workspace.ts                 projects: apps/*/vitest.config.ts, packages/*/vitest.config.ts
├── docker-compose.dev.yml              prometheus(+mock) · api(:8000) · web(:3000) · builder(tsc --watch shared)
├── docker-compose.yml                  prod: api + web (+ optional bundled prometheus pointer)
├── Dockerfile.dev                      shared "builder" image (tsc --watch packages/shared)
├── CLAUDE.md                           repo guide (this product's domain, ported to lava-connect's format)
├── .claude/
│   ├── rules/                          api-conventions.md · frontend.md · code-style.md · testing.md · git-workflow.md
│   ├── skills/code-review/             port the parallel-review harness (drop DB/Stripe domain refs)
│   └── settings.json                   PostToolUse typecheck hook
│
├── packages/
│   └── shared/                         @sr/shared  — the ONLY package (no db package)
│       └── src/
│           ├── types/                  Chain, Provider, Router, MetricWindow, UsageByChain,
│           │                           ProviderMetrics, ErrorLayer, HealthState, ApiError, …
│           ├── constants/              METRIC_NAMES (lava_rpcsmartrouter_*), WINDOWS (5m..30d),
│           │                           ERROR_LAYERS (1000s/2000s/3000s/4000s), LATENCY_BUCKETS,
│           │                           CHAINS (spec→meta: ETH1/BASE/POLYGON1…)
│           └── promql/                 PromQL builders shared FE/BE (rate/increase/histogram_quantile templates)
│
└── apps/
    ├── api/                            @sr/api — Fastify 5 (port 8000)
    │   └── src/
    │       ├── routes/                 metrics · chains · providers · errors · config · auth · health · version
    │       ├── plugins/                cors · auth · cache · error-handler · swagger · prometheus
    │       ├── services/               prometheus-client.ts · calculations.ts · configuration.ts (helm-values)
    │       ├── config.ts               env defaults + cache TTLs (single source of truth)
    │       └── main.ts                 bootstrap
    └── web/                            @sr/web — Next.js 16 App Router (port 3000)
        └── src/
            ├── app/(app)/              Shell layout
            │   ├── overview/           ① Overview tab content (or top-level)
            │   ├── metrics/            4-tab Metrics page (Overview·Traffic·Providers·Errors)
            │   ├── providers/          provider roster + detail
            │   ├── endpoints/          endpoints page
            │   └── standalone/         embeddable metrics-only chrome (from prototype's StandaloneTop)
            ├── components/
            │   ├── gateway/            Shell, Sidebar, Topbar, charts (port from magma/*.jsx)
            │   └── ui/                 shadcn-style primitives
            ├── hooks/                  use-api, use-metrics, use-window
            ├── lib/                    api-client, promql helpers, format
            └── styles/                 globals.css design tokens (port magma styles.css @theme)
```

**Key divergences from lava-connect (intentional):**
- **No `packages/db`** — no Postgres/Drizzle/migrations.
- **API on :8000** (not :8080) — keep Smart Router's existing port contract so infra/helm/nginx don't change.
- **Web on :3000** (matches current dev).
- **Auth** = basic-auth + optional auth-gateway token (port current `core/auth*.py`), **not** Auth.js+JWT+Postgres.
- Routes are **read-mostly** + a small config write surface (helm-values), not CRUD.

---

## The hard part: porting the metrics domain (Python → TS)

`core/calculations.py` (647 LOC) is the real IP. The pytest suite is the spec.

**Strategy — behaviour-preserving port:**
1. Stand up `packages/shared/src/promql/` + `apps/api/src/services/calculations.ts`.
2. For each Python function with a test, port the function **and** translate its
   pytest cases to a Vitest case with the **same inputs/outputs** (the tests are
   the oracle — `Backend Metrics Mapping.md` is the spec for what each value means).
3. Port `prometheus-client.ts` (httpx → undici/`fetch`; same query/query_range/get_metric_range surface).
4. Port `configuration.ts` — the helm-values normalizer (`_normalize_smart_router_config`,
   `direct-rpc` grouping, `_port_from_listen_address`). Keep reading `dev-config/` + `helm-values/`.
5. Keep the **`/api` prefix and every existing response_model shape** so the
   frontend contract is stable during migration (then refine once FE is on shared types).

**The `Backend Metrics Mapping.md` gaps are part of the contract** — the API must
expose the same "real vs derived/synthetic" honesty:
- QoS / selection score → **no metric (Gap #1)** — API returns `null`, never invents.
- Primary-vs-backup / failover → **no provider label on `retries_*`, no failover counter (Gap #2)**.
- Per-method / per-provider P95 → latency histogram is `function`-labelled only (Gap #3).
- Per-code/per-layer errors → only `node_errors_total`/`protocol_errors_total` confirmed (Gap #5).
- Effective read p95 stays a documented **derived** estimate.

These belong in `CLAUDE.md` + a `docs/METRICS-MAPPING.md` (move `Backend Metrics Mapping.md` there) as the source-of-truth, exactly as the SR Dashboard `CLAUDE.md` mandates.

---

## Phased execution

Each phase is independently shippable and leaves the repo green (`pnpm typecheck && pnpm test`).

### Phase 0 — Monorepo scaffolding (no behaviour change)
- Add `pnpm-workspace.yaml`, root `package.json` (`pnpm -r` scripts), `tsconfig.base.json`,
  `vitest.workspace.ts` — copied from lava-connect, renamed `@gateway/*` → `@sr/*`.
- Create empty `packages/shared`, `apps/api`, `apps/web` skeletons.
- Move existing `frontend/` → `apps/web/` (git mv, keep history); wire it into the workspace
  (still builds/runs unchanged). Update its `tsconfig` to extend base **incrementally** (strict already on).
- Repo-root `CLAUDE.md` + `.claude/rules/` ported from lava-connect (domain rewritten).
- ✔ Gate: `pnpm install`, web still `pnpm dev`-runs, typecheck green.

### Phase 1 — `packages/shared` (domain)
- Author `types/`, `constants/` (METRIC_NAMES, WINDOWS, ERROR_LAYERS, CHAINS-by-spec, LATENCY_BUCKETS),
  and `promql/` builders — sourced from `smartrouter_metrics.md` + `Backend Metrics Mapping.md`.
- ⚠️ **Chains are keyed by Lava spec index** (`ETH1`/`BASE`/`POLYGON1`), not chain.id —
  resolve via a `buildChainMetaByIndex` helper (matches the saved lava-connect convention and §0 of the mapping).
- Vitest for every exported util (testing rule: every shared util needs a test).
- ✔ Gate: `pnpm --filter @sr/shared test` green.

### Phase 2 — `apps/api` (TS Fastify port) — the big one
- Bootstrap Fastify 5 with plugins: `cors`, `error-handler`, `swagger`, `cache` (Redis optional /
  in-memory fallback — keep it simple, no Redis dependency unless wanted), `auth` (basic + gateway token), `prometheus`.
- Port services in dependency order: `prometheus-client.ts` → `calculations.ts` → `configuration.ts`.
- Port routes preserving `/api/...` paths + response shapes:
  `metrics` (query/instant/range/last_minutes/default), `chains-metrics[/:id]`,
  `providers-metrics`, `chains-to-providers`, `usage[/:chain]`, `dashboard-summary`,
  `components`, `settings[/version]`, `keys`, `auth`, `health`, `version`.
- **Translate the pytest suite to Vitest** (`app.inject()` per the testing rule) — the
  existing Python tests are the acceptance criteria. Mock Prometheus HTTP (never hit real).
- Cache TTLs per lava-connect guidance: realtime 10–30s · lists 60–300s.
- ✔ Gate: Vitest parity with the old pytest suite; `docker compose` brings api up on :8000;
  a smoke script hits every route against a mock/real Prometheus.

### Phase 3 — `apps/web` rebuild to the new design
- Port the prototype shell (`magma/shell.jsx` → `components/gateway/Shell|Sidebar|Topbar`),
  design tokens (`magma/styles.css` → `globals.css @theme`, brand `#FF3900`), icons, charts.
- Build the **4-tab Metrics page** (Overview · Traffic · Providers · Errors) from
  `page-metrics.jsx` + `page-providers.jsx`, wired to the Phase-2 API via shared types.
- Page-level **window selector** (5m…30d) and **chain selector** at the top (per mapping §0 +
  the saved UI-consistency convention: titles inside cards, page-level window selectors).
- Render the **gap honesty**: QoS/selection-score/failover/primary-vs-backup show "not
  available" states (no synthetic numbers) wired to the same nulls the API returns.
- Standalone embeddable view (`?standalone` / `/standalone`) from `StandaloneTop`.
- Replace MUI X-Charts/reactflow sprawl with one chart lib if it simplifies (decide during port; not a goal in itself).
- ✔ Gate: web builds (`output: standalone`), typecheck strict-clean, manual UI verification
  (testing rule: no React unit tests — rely on typecheck + manual).

### Phase 4 — Docker, CI, docs, parity cutover
- `Dockerfile.dev` (shared builder), per-app multi-stage Dockerfiles (workspace-aware, from lava-connect pattern, minus db copies).
- `docker-compose.dev.yml`: `prometheus` (or a mock-prom for offline dev) · `api` · `web` · `builder`.
- `docker-compose.yml`: prod api+web; **preserve existing env contract** (`PROMETHEUS_URL`,
  `TENANT_ID`, `AUTH_*`, `CORS_ORIGINS`, `NEXT_PUBLIC_*`) so deploys/helm don't break.
- `.github/` CI: typecheck + test + build on PR.
- `docs/`: `METRICS-MAPPING.md` (from `Backend Metrics Mapping.md`), `ARCHITECTURE.md`, port `README.md`.
- Port the `code-review` skill harness (drop db/Stripe agents' domain refs).
- **Delete the Python `backend/`** only after Phase-2 Vitest parity is proven and the
  TS api is the one wired in compose. Keep `SR Dashboard/` as the design archive (or move to `docs/design/`).
- ✔ Gate: `docker compose -f docker-compose.dev.yml up --build` → working dashboard against Prometheus.

---

## Migration mechanics & safety

- **Git history**: use `git mv` for `frontend/ → apps/web/`. New `apps/api` is fresh; old `backend/`
  stays until parity is proven, then removed in its own commit.
- **Contract stability**: keep `/api/*` paths + response shapes through Phase 2 so the web app keeps
  working during the rewrite; tighten to shared types in Phase 3.
- **Tests as oracle**: the pytest suite is ported 1:1 to Vitest first — a passing parity suite is the
  green light to delete Python. Don't refactor logic and tests in the same step.
- **No invented data** (SR Dashboard `CLAUDE.md` rule): every UI number maps to a real
  `lava_rpcsmartrouter_*` metric or is explicitly flagged derived/unavailable.
- **Env contract frozen**: prod env var names unchanged so infra (`ansible-internal`, helm, nginx) is untouched.

## Open items to confirm before/while building
1. **Auth**: keep basic-auth + auth-gateway token as-is, or align closer to lava-connect
   (still no DB — e.g. a signed-token gate)? Default: port current behaviour verbatim.
2. **Cache layer**: add Redis (lava-connect-style namespaced cache) or in-process LRU? For a
   Prometheus proxy, in-process is likely enough. Default: in-process, Redis optional via env.
3. **Chart library**: consolidate to one (recharts) vs. keep MUI X-Charts where the prototype uses it.
4. **Missing source docs**: `rpcendpoint_metrics.md` + `consumer_metrics.md` are referenced but not
   uploaded — per-endpoint latency (Gap #3 alt source) and QoS semantics depend on them. Track as a data dependency.

---

## Effort sketch (relative)

| Phase | Size | Risk |
|---|---|---|
| 0 Scaffolding | S | low |
| 1 shared | S | low |
| 2 API port | **L** | **med-high** (calc parity is the crux) |
| 3 Web rebuild | **L** | med (design fidelity) |
| 4 Docker/CI/docs/cutover | M | low-med |

The crux is **Phase 2 calculation parity**. Everything else is mechanical once the
ported `calculations.ts` passes the translated test suite.
