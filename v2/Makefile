#!/usr/bin/make -f
#
# Smart Router Dashboard v2 — local stack.
#
# `make up` is the one command you need: it brings up the router + Prometheus
# (from ~/projects/smart-router), builds the dashboard images on an isolated
# BuildKit builder, and starts the api + web. `make down` tears the dashboard
# down (leaving the router alone).
#
# Why the isolated builder: when another project is built on the same Docker
# daemon, the shared BuildKit cache/context can serve the wrong project's
# files (you'll see `@info/shared` in an ERR_PNPM_OUTDATED_LOCKFILE). A
# dedicated builder has its own clean cache, so the build is deterministic.

SHELL := /bin/bash

# Where the smart-router repo lives (for the router + Prometheus stack).
ROUTER_DIR ?= $(HOME)/projects/smart-router
SR_CONFIG  ?= config/smartrouter_examples/smartrouter_eth.yml
SR_SPEC    ?= specs/

# Dashboard image + network.
BUILDER     ?= srdash-builder
API_IMAGE   ?= sr-dashboard-api:dev
WEB_IMAGE   ?= sr-dashboard-web:dev
NETWORK     ?= smart-router_default
API_PORT    ?= 8000
WEB_PORT    ?= 3000
API_URL     ?= http://localhost:$(API_PORT)
SR_CONFIG_HOST ?= $(CURDIR)/dev-config/values.yml

.PHONY: up down router build build-api build-web run logs ps clean builder

## up: router + Prometheus + dashboard (the one command)
up: router build run
	@echo ""
	@echo "  ✅ Dashboard up:"
	@echo "     UI   → http://localhost:$(WEB_PORT)"
	@echo "     API  → http://localhost:$(API_PORT)"

## router: bring up smart-router + Prometheus (offline specs, no GitHub)
router:
	@echo "▶ router + prometheus (from $(ROUTER_DIR))"
	cd $(ROUTER_DIR) && SR_CONFIG=$(SR_CONFIG) SR_SPEC=$(SR_SPEC) \
		docker compose -f docker/docker-compose.dashboard.yml up -d router prometheus

## builder: ensure the isolated BuildKit builder exists
builder:
	@docker buildx inspect $(BUILDER) >/dev/null 2>&1 || \
		docker buildx create --name $(BUILDER) --driver docker-container --bootstrap

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

## run: start api + web containers on the router network
run:
	@echo "▶ run api + web"
	-docker rm -f srdash-api srdash-web 2>/dev/null
	docker run -d --name srdash-api --network $(NETWORK) \
		-e PROMETHEUS_URL=http://prometheus:9090 \
		-e HELM_VALUES_DIR=/app/helm-values \
		-e CORS_ORIGINS=$(API_URL),http://localhost:$(WEB_PORT) \
		-v $(SR_CONFIG_HOST):/app/helm-values/core/values.yml:ro \
		-p $(API_PORT):8000 $(API_IMAGE)
	docker run -d --name srdash-web --network $(NETWORK) \
		-e NEXT_PUBLIC_API_URL=$(API_URL) -e NEXT_PUBLIC_LOCAL_MODE=true \
		-p $(WEB_PORT):3000 $(WEB_IMAGE)

## logs: tail the dashboard containers
logs:
	docker logs -f srdash-api & docker logs -f srdash-web

## ps: show the dashboard + router containers
ps:
	@docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep -E 'srdash|router|prometheus' || true

## down: stop the dashboard (leaves the router running)
down:
	-docker rm -f srdash-api srdash-web 2>/dev/null
	@echo "dashboard stopped (router + prometheus left running; stop them from $(ROUTER_DIR))"

## clean: down + remove the isolated builder
clean: down
	-docker buildx rm $(BUILDER) 2>/dev/null
