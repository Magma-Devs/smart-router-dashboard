#!/usr/bin/make -f
#
# Smart Router Dashboard v2 — local stack.
#
# `make up` is the one command you need: the compose file is self-contained
# (router profile + Prometheus + api + web). `make down` tears it down.
#
# The router profile builds from a smart-router checkout (ROUTER_DIR) because
# the published release image ships only the binary — no bundled specs/.
#
# Why the isolated builder (build-api/build-web): when another project is
# built on the same Docker daemon, the shared BuildKit cache/context can serve
# the wrong project's files (you'll see `@info/shared` in an
# ERR_PNPM_OUTDATED_LOCKFILE). A dedicated builder has its own clean cache.

SHELL := /bin/bash

# Where the smart-router repo lives (router profile build context).
ROUTER_DIR ?= $(HOME)/projects/smart-router
SR_SPEC    ?= specs/

# Image names for local GHCR-parity builds (match the CI-published names).
BUILDER    ?= srdash-builder
API_IMAGE  ?= ghcr.io/magma-devs/smart-router-dashboard/api:local
WEB_IMAGE  ?= ghcr.io/magma-devs/smart-router-dashboard/web:local
API_PORT   ?= 8000
WEB_PORT   ?= 3000
API_URL    ?= http://localhost:$(API_PORT)

.PHONY: up down dev dev-down router logs ps clean builder build build-api build-web typecheck test

## up: SELF-CONTAINED stack — router + Prometheus + api + web (prod images)
up:
	ROUTER_DIR=$(ROUTER_DIR) SR_SPEC=$(SR_SPEC) \
		docker compose --profile router up -d --build
	@echo ""
	@echo "  ✅ Dashboard up:"
	@echo "     UI    → http://localhost:$(WEB_PORT)"
	@echo "     API   → http://localhost:$(API_PORT)"
	@echo "     Prom  → http://localhost:9090"
	@echo "     ETH1  → http://localhost:3360"

## down: stop the whole stack
down:
	docker compose --profile router down

## dev: HOT-RELOAD stack (api = tsx watch · web = next dev · shared = tsc --watch)
dev:
	@echo "▶ dev stack with hot reload (first boot runs pnpm install — ~1 min)"
	ROUTER_DIR=$(ROUTER_DIR) SR_SPEC=$(SR_SPEC) \
		docker compose -f docker-compose.dev.yml --profile router up --build

## dev-down: stop the hot-reload dev stack
dev-down:
	docker compose -f docker-compose.dev.yml --profile router down

## router: bring up ONLY the router + Prometheus from this compose
router:
	ROUTER_DIR=$(ROUTER_DIR) SR_SPEC=$(SR_SPEC) \
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

## logs: tail the dashboard containers
logs:
	docker compose logs -f api web

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
