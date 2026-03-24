DC := docker compose
SERVICE := hub
PORT ?= 3333

.PHONY: help build up down logs sh dev test test-coverage health servers restart-server

help:
	@echo "Targets:"
	@echo "  make build   # docker build"
	@echo "  make up      # docker compose up -d"
	@echo "  make down    # docker compose down"
	@echo "  make logs    # follow hub logs"
	@echo "  make sh      # shell in container"
	@echo "  make dev     # local: npm run dev (requires .env + node)"
	@echo "  make test    # vitest"
	@echo "  make test-coverage # vitest with coverage"
	@echo "  make health  # GET /health"
	@echo "  make servers # GET /admin/servers"
	@echo "  make restart-server SERVER=name  # POST /admin/servers/:name/restart"

build:
	$(DC) build

up:
	$(DC) up -d

down:
	$(DC) down

logs:
	$(DC) logs -f $(SERVICE)

sh:
	$(DC) exec $(SERVICE) sh

dev:
	npm run dev

test:
	npm test

test-coverage:
	npm run test:coverage

health:
	curl -sf http://127.0.0.1:$(PORT)/health

servers:
	curl -s http://127.0.0.1:$(PORT)/admin/servers

restart-server:
	@test -n "$(SERVER)" || (echo "Usage: make restart-server SERVER=echo" && exit 1)
	curl -s -X POST http://127.0.0.1:$(PORT)/admin/servers/$(SERVER)/restart
