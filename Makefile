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
API_URL    ?= http://localhost:$(API_PORT)

.PHONY: up down dev dev-down up-auth dev-auth router ps clean builder build build-api build-web typecheck test \
	demo demo-down demo-relays demo-stats demo-reset demo-health demo-logs

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
## Requires AUTH_SECRET + ADMIN_EMAIL + ADMIN_PASSWORD in the environment.
## (logs profile is on by default here too — Grafana → :3001.)
up-auth:
	AUTH_MODE=enabled docker compose --profile router --profile auth --profile logs up -d --build
	@echo ""
	@echo "  🔐 Auth enabled — sign in at http://localhost:$(WEB_PORT)/login"
	@echo "     Grafana → http://localhost:3001  (admin / admin)"

## dev-auth: hot-reload stack WITH authentication (dev-default admin@example.com / admin1234)
dev-auth:
	@echo "▶ dev stack with hot reload + auth (sign in: admin@example.com / admin1234; Grafana → :3001)"
	AUTH_MODE=enabled docker compose -f docker-compose.dev.yml --profile router --profile auth --profile logs up --build

# ---- Demo stack (docker-compose.demo.yml) --------------------------------
# A real router wired for a Relay Trace demo, plus the measurement rig from
# smart-router's `run-and-measure-locally` skill. Differs from `up` in three
# ways: debug log level (a successful relay leaves ONE line at info — see
# docs/RELAY-TRACE.md), the --debug-address server on :7999, and a counting
# proxy in front of the ETH1/publicnode upstream.
DEMO_COMPOSE := -f docker-compose.yml -f docker-compose.demo.yml
DEMO_PROFILES := --profile router --profile logs --profile demo
DEMO_ENV := SR_CONFIG_HOST=./demo/values.demo.yml \
            SR_DEBUG_ADDRESS=0.0.0.0:7999 \
            SR_LOG_LEVEL=debug

## demo: Relay Trace demo stack — router (debug logs + /debug/*) + Loki/Grafana + counting proxy
demo:
	$(DEMO_ENV) docker compose $(DEMO_COMPOSE) $(DEMO_PROFILES) up -d --build
	@echo ""
	@echo "  ✅ Demo up (router logs at DEBUG — traces have the per-relay summary):"
	@echo "     UI       → http://localhost:$(WEB_PORT)        Trace → /trace"
	@echo "     API      → http://localhost:$(API_PORT)        GET /api/trace/:guid"
	@echo "     Grafana  → http://localhost:3001        (admin / admin)"
	@echo "     Prom     → http://localhost:9090"
	@echo "     /debug/* → http://localhost:7999/debug/endpoint-state"
	@echo "     upstream → http://localhost:8899/__stats  (ETH1 · publicnode)"
	@echo ""
	@echo "  next: make demo-relays   (fires relays, prints each Lava-Guid)"

## demo-relays: fire a spread of relays and print the Lava-Guid of each (PASSES=n)
demo-relays:
	@./demo/send-relays.sh $(or $(PASSES),1)

## demo-stats: what the router actually sent the ETH1 upstream (node-side count)
demo-stats:
	@curl -s http://localhost:8899/__stats | jq .

## demo-reset: zero the upstream counters — settle ~45s after boot first, so
## one-off startup verification traffic is excluded from the window you measure.
demo-reset:
	@curl -sX POST http://localhost:8899/__reset | jq .
	@echo "counters zeroed — send NO relays if you want proactive polls only"

## demo-health: the health check for any run (see the skill: Enabled, 0 poll failures, TipFresh)
demo-health:
	@echo "── endpoint-state ──"  && curl -s http://localhost:7999/debug/endpoint-state | jq -r '["CHAIN","IFACE","UP","LATEST","FAILS","POLLms","HASH","UPSTREAM"], (.[]|[.ChainID,.ApiInterface,(.Enabled|tostring),(.LatestBlock|tostring),(.ConsecutivePollFailures|tostring),(.PollIntervalMs|tostring),.HashPolling,.NetworkAddress]) | @tsv' | column -t
	@echo "── chain-state ──"     && curl -s http://localhost:7999/debug/chain-state    | jq .
	@echo "── tracker requests ──" && curl -s http://localhost:7779/metrics | grep '^rpc_endpoint_tracker_requests_total' || echo "  (no tracker metric on this build)"

## demo-logs: follow the router's logs (the lines the trace page reads)
demo-logs:
	$(DEMO_ENV) docker compose $(DEMO_COMPOSE) logs -f router

## demo-down: stop the demo stack
demo-down:
	$(DEMO_ENV) docker compose $(DEMO_COMPOSE) $(DEMO_PROFILES) --profile auth --profile cache down

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
