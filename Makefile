#!/usr/bin/make -f
#
# Smart Router Dashboard — local stack.
#
# `make up` is the one command you need: the compose file is self-contained
# (router profile + Prometheus + api + web). `make down` tears it down.
#
# The router profile pulls the published image (ghcr.io/magma-devs/smart-router
# :latest) and loads specs straight from the lava-specs GitHub repo — no
# smart-router checkout, no volume mount.
#
# Why the isolated builder (build-api/build-web): when another project is
# built on the same Docker daemon, the shared BuildKit cache/context can serve
# the wrong project's files (you'll see `@info/shared` in an
# ERR_PNPM_OUTDATED_LOCKFILE). A dedicated builder has its own clean cache.

SHELL := /bin/bash

# Optional overrides, forwarded to compose (each has a default IN the compose
# file, so leave unset for the normal path):
#   SR_SPEC          spec source for --use-static-spec (default: the lava-specs
#                    GitHub repo). Point at a local dir or another repo URL.
#   SR_CONFIG_HOST   the values file mounted into BOTH router and api
#                    (default: ./dev-config/values.yml — multichain + CV).
export SR_SPEC ?=
export SR_CONFIG_HOST ?=

# Build provenance surfaced by GET /version + the Account page. Read from the
# VERSION file and git so `make up` stamps the real version instead of the
# compose default (0.0.0 / dev). Overridable from the environment.
export APP_VERSION ?= $(shell tr -d ' \n\r' < VERSION 2>/dev/null || echo 0.0.0)
export GIT_COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo dev)

# Image names for local GHCR-parity builds (match the CI-published names:
# api → backend, web → frontend — the names the smart-router helm chart uses).
BUILDER    ?= srdash-builder
API_IMAGE  ?= ghcr.io/magma-devs/smart-router-dashboard/backend:local
WEB_IMAGE  ?= ghcr.io/magma-devs/smart-router-dashboard/frontend:local
API_PORT   ?= 8000
WEB_PORT   ?= 3000
SES_UI_PORT ?= 8005
API_URL    ?= http://localhost:$(API_PORT)

.PHONY: up down dev dev-down up-auth dev-auth accounts accounts-managed accounts-reset e2e e2e-down router ps clean builder build build-api build-web typecheck test

## up: SELF-CONTAINED stack — router + Prometheus + api + web + logs (Loki/Grafana)
up:
	docker compose --profile router --profile logs up -d --build
	@echo ""f
	@echo "  ✅ Dashboard up:"
	@echo "     UI      → http://localhost:$(WEB_PORT)"
	@echo "     API     → http://localhost:$(API_PORT)"
	@echo "     Prom    → http://localhost:9090"
	@echo "     Grafana → http://localhost:3001  (admin / admin) → \"Smart Router Dashboard Logs\""
	@echo "     Router  → http://localhost:3360-3367 (ETH1/SOLANA/BTC/HYPERLIQUID/COSMOSHUB×3/APT1)"
	@echo ""
	@echo "  logs    → docker compose logs -f   (make dev runs in the foreground and streams them)"

## up-cache: like `up`, plus the smart-router cache sidecar (:20100, metrics :5555)
## Wires the router to the cache via --cache-be — no values.yml edit needed.
up-cache:
	SR_CACHE_BE=cache:20100 docker compose --profile router --profile cache --profile logs up -d --build
	@echo ""
	@echo "  ✅ Dashboard + cache up. Cache metrics → http://localhost:5555/metrics"
	@echo "     Router is wired to the cache via --cache-be cache:20100."

## down: stop the whole stack (auth + logs + cache profiles included so everything stops)
down:
	docker compose --profile router --profile auth --profile logs --profile cache down

## dev: HOT-RELOAD stack (api = tsx watch · web = next dev · shared = tsc --watch) + logs (Loki/Grafana → :3001)
## Runs in the FOREGROUND and streams every container's logs — Ctrl-C to stop.
dev:
	@echo "▶ dev stack with hot reload + logs (Grafana → http://localhost:3001, admin/admin; first boot runs pnpm install — ~1 min)"
	docker compose -f docker-compose.dev.yml --profile router --profile logs up --build

## dev-down: stop the hot-reload dev stack
dev-down:
	docker compose -f docker-compose.dev.yml --profile router --profile auth --profile logs down

## up-auth: prod-style stack WITH authentication (postgres + login) — see docs/AUTH.md.
## Requires AUTH_SECRET, TOTP_ENCRYPTION_KEY and INTERNAL_AUTH_SECRET (each
## `openssl rand -base64 32`) in the environment — the api refuses to boot
## without the last two. The first admin is created at
## /setup with the setup token: this is a production build, and it ignores
## ADMIN_EMAIL / ADMIN_PASSWORD.
## (logs profile is on by default here too — Grafana → :3001.)
##
## DATABASE_URL is supplied HERE rather than as a compose default: the compose
## files leave every auth value empty so a stack with auth off has nothing
## pointing at a database. Override it to use a postgres other than the one the
## `auth` profile starts.
up-auth:
	AUTH_MODE=enabled \
	DATABASE_URL=$${DATABASE_URL:-postgres://sr:$${POSTGRES_PASSWORD:-dev}@postgres:5432/sr_dashboard} \
	docker compose --profile router --profile auth --profile logs up -d --build
	@echo ""
	@echo "  🔐 Auth enabled — open http://localhost:$(WEB_PORT); a fresh install goes to /setup"
	@echo "     Setup token: the SETUP_TOKEN you set, or: docker compose logs api | grep -iE 'setup_?token'"
	@echo "     Grafana → http://localhost:3001  (admin / admin)"

## dev-auth: hot-reload stack WITH authentication (dev-default admin@example.com / admin1234)
##
## The dev secret, the dev 2FA key and the dev admin live here, not in
## docker-compose.dev.yml (the key is a fixed development value, never real):
## a stack running with auth OFF should not carry a password for an
## administrator it is never going to create. Every value is overridable.
dev-auth:
	@echo "▶ dev stack with hot reload + auth (sign in: admin@example.com / admin1234; Grafana → :3001)"
	AUTH_MODE=enabled \
	AUTH_SECRET=$${AUTH_SECRET:-dev-secret-change-me-please-32chars!} \
	DATABASE_URL=$${DATABASE_URL:-postgres://sr:$${POSTGRES_PASSWORD:-dev}@postgres:5432/sr_dashboard} \
	TOTP_ENCRYPTION_KEY=$${TOTP_ENCRYPTION_KEY:-ZGV2LW9ubHkta2V5LW5vdC1mb3ItcHJvZHVjdGlvbiE=} \
	ADMIN_EMAIL=$${ADMIN_EMAIL:-admin@example.com} \
	ADMIN_PASSWORD=$${ADMIN_PASSWORD:-admin1234} \
	INTERNAL_AUTH_SECRET=$${INTERNAL_AUTH_SECRET:-dev-internal-secret} \
	docker compose -f docker-compose.dev.yml --profile router --profile auth --profile logs up --build

## accounts: stack for exercising the MAG-2729 account system by hand (no seeded admin)
accounts:
	AUTH_MODE=enabled \
	AUTH_SECRET=$${AUTH_SECRET:-dev-secret-change-me-please-32chars!} \
	DATABASE_URL=$${DATABASE_URL:-postgres://sr:$${POSTGRES_PASSWORD:-dev}@postgres:5432/sr_dashboard} \
	TOTP_ENCRYPTION_KEY=$${TOTP_ENCRYPTION_KEY:-ZGV2LW9ubHkta2V5LW5vdC1mb3ItcHJvZHVjdGlvbiE=} \
	docker compose -f docker-compose.dev.yml -f docker-compose.accounts.yml \
		--profile auth up -d --build postgres builder api web
	@echo ""
	@echo "  🔐 Fresh install — no accounts yet."
	@echo "     Open http://localhost:$(WEB_PORT)  →  it redirects to /setup"
	@echo "     Setup token:  installer-printed-this-token"
	@echo ""
	@echo "     Walkthrough: docs/AUTH.md → \"Trying the account system by hand\""
	@echo "     Reset to a fresh install:  make accounts-reset"

## accounts-managed: the same stack in MANAGED mode — invitations and resets are emailed
accounts-managed:
	AUTH_MODE=enabled \
	AUTH_SECRET=$${AUTH_SECRET:-dev-secret-change-me-please-32chars!} \
	DATABASE_URL=$${DATABASE_URL:-postgres://sr:$${POSTGRES_PASSWORD:-dev}@postgres:5432/sr_dashboard} \
	TOTP_ENCRYPTION_KEY=$${TOTP_ENCRYPTION_KEY:-ZGV2LW9ubHkta2V5LW5vdC1mb3ItcHJvZHVjdGlvbiE=} \
	docker compose -f docker-compose.dev.yml -f docker-compose.accounts.yml \
		-f docker-compose.managed.yml --profile auth up -d --build postgres builder ses api web
	@echo ""
	@echo "  ✉️  Managed mode — invitations and resets are emailed."
	@echo "     Mail goes to a local SES mock, so nothing leaves this machine."
	@echo ""
	@echo "     Inbox:  http://localhost:$(SES_UI_PORT)"
	@echo "     App:    http://localhost:$(WEB_PORT)  →  /setup"
	@echo ""
	@echo "     Reset to a fresh install:  make accounts-reset"

## recover: run a host recovery command against the running accounts database
##   make recover CMD="reset-2fa --email dana@example.com"
##
## The three commands are reset-2fa, reset-password and promote-admin. Each
## writes a host.recovery row naming the command and the operator, so a recovery
## shows up in the dashboard afterwards and cannot be done quietly. Shell access
## on the host is the authorisation — see docs/TWO-FACTOR.md.
## The host.recovery row names the operator. Inside the container the shell
## user is the container's, so the host user is passed as --by unless CMD
## already names one. The dev stack only: a deployed api runs the same file as
## `node apps/api/dist/recover.js` (docs/TWO-FACTOR.md → Recovery).
recover:
	@test -n "$(CMD)" || (echo 'set CMD, e.g. make recover CMD="reset-2fa --email dana@example.com"'; exit 2)
	docker compose -f docker-compose.dev.yml -f docker-compose.accounts.yml \
		--profile auth exec api pnpm --filter @sr/api exec tsx src/recover.ts $(CMD) \
		$(if $(findstring --by,$(CMD)),,--by "$${SUDO_USER:-$$USER}")

## accounts-reset: wipe the accounts database and start over from first-run
accounts-reset:
	docker compose -f docker-compose.dev.yml -f docker-compose.accounts.yml \
		-f docker-compose.managed.yml --profile auth down -v
	@echo '▶ wiped — run make accounts for a fresh first-run'

## e2e: EVERYTHING, from scratch — wipes the accounts database, then brings up
## router + Prometheus + logs + postgres + api + web in hot reload, with no
## seeded admin (first run at /setup) and managed-mode email to the local SES
## mock. The one stack for walking the whole product end to end.
##   make e2e                 managed: invites + resets emailed (inbox :8005)
##   make e2e MODE=onprem     on-prem: links handed over by an admin, no email
## Prometheus is on :9091 here (the accounts overlay remaps it).
MODE ?= managed
E2E_FILES = -f docker-compose.dev.yml -f docker-compose.accounts.yml \
	$(if $(filter managed,$(MODE)),-f docker-compose.managed.yml,)
E2E_PROFILES = --profile router --profile auth --profile logs
e2e:
	@test "$(MODE)" = managed -o "$(MODE)" = onprem || (echo 'MODE must be managed or onprem'; exit 2)
	docker compose -f docker-compose.dev.yml -f docker-compose.accounts.yml \
		-f docker-compose.managed.yml $(E2E_PROFILES) down -v
	AUTH_MODE=enabled \
	AUTH_SECRET=$${AUTH_SECRET:-dev-secret-change-me-please-32chars!} \
	DATABASE_URL=$${DATABASE_URL:-postgres://sr:$${POSTGRES_PASSWORD:-dev}@postgres:5432/sr_dashboard} \
	TOTP_ENCRYPTION_KEY=$${TOTP_ENCRYPTION_KEY:-ZGV2LW9ubHkta2V5LW5vdC1mb3ItcHJvZHVjdGlvbiE=} \
	docker compose $(E2E_FILES) $(E2E_PROFILES) up -d --build
	@echo ""
	@echo "  🧪 End-to-end stack, fresh install ($(MODE) mode)"
	@echo "     App      → http://localhost:$(WEB_PORT)  →  /setup, token: installer-printed-this-token"
	@echo "     API      → http://localhost:$(API_PORT)  (OpenAPI at /docs)"
	@$(if $(filter managed,$(MODE)),echo "     Inbox    → http://localhost:$(SES_UI_PORT)",echo "     Email    → none (on-prem: an admin hands links over)")
	@echo "     Prom     → http://localhost:9091"
	@echo "     Grafana  → http://localhost:3001  (admin / admin)"
	@echo "     Router   → http://localhost:3360-3367"
	@echo ""
	@echo "     Logs:  docker compose $(E2E_FILES) logs -f api web"
	@echo "     Again from scratch:  make e2e   ·   Stop:  make e2e-down"

## e2e-down: stop the e2e stack (volumes kept; `make e2e` wipes them on the next run)
e2e-down:
	docker compose -f docker-compose.dev.yml -f docker-compose.accounts.yml \
		-f docker-compose.managed.yml $(E2E_PROFILES) down

## router: bring up ONLY the router + Prometheus from this compose
router:
	docker compose --profile router up -d --build router prometheus

## builder: ensure the isolated BuildKit builder exists
builder:
	@docker buildx inspect $(BUILDER) >/dev/null 2>&1 || \
		docker buildx create --name $(BUILDER) --driver docker-container --bootstrap

## build: build the api + web images under their GHCR names (publish parity)
build: builder build-api build-web

build-api: builder
	@echo "▶ build $(API_IMAGE)"
	docker buildx build --builder $(BUILDER) -f apps/api/Dockerfile \
		-t $(API_IMAGE) --build-arg GIT_COMMIT=$$(git rev-parse --short HEAD 2>/dev/null || echo dev) \
		--load .

build-web: builder
	@echo "▶ build $(WEB_IMAGE)"
	docker buildx build --builder $(BUILDER) -f apps/web/Dockerfile \
		-t $(WEB_IMAGE) \
		--build-arg NEXT_PUBLIC_API_URL=$(API_URL) \
		--build-arg NEXT_PUBLIC_LOCAL_MODE=true \
		--load .

## ps: show the stack
ps:
	@docker compose --profile router ps

## typecheck / test: workspace gates
typecheck:
	pnpm -r typecheck

test:
	pnpm -r test

## clean: down + remove the isolated builder
clean: down
	-docker buildx rm $(BUILDER) 2>/dev/null
