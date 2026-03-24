# AGENTS.md

This project follows the PNP default operating standard.

## Main rules

- Docker Compose is the default runtime interface
- Makefile aliases are the default command interface
- `docker compose up -d` or `make up` should always leave the project in a healthy baseline state
- Replace the generic workspace with app-specific services without breaking the Docker-first contract
- Generic profile: define stack-specific services as soon as the context is complete

## Main sources

- `.pnp/context.json` — source of truth for scope and constraints
- `README.md` — operational entrypoint
- `docs/` — architectural and product documentation

