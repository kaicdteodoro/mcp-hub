# Operação

## Makefile

- `make up` / `make down` — Compose
- `make logs` — Logs do serviço `hub`
- `make health` — Verifica `/health` (use `PORT=...` se não for 3333)
- `make servers` — Lista `/admin/servers`
- `make restart-server SERVER=echo` — Reinicia um servidor MCP
- `make test-coverage` — Executa testes com cobertura

## Segurança (produção)

- Defina `MCP_HUB_AUTH_TOKEN` no `.env` para exigir `Authorization: Bearer <token>` em `/mcp/*`, `/sse/*`, `/messages`, `/admin/*`.
- Defina `MCP_HUB_CORS_ORIGINS` com origins permitidas (CSV) para browser clients.
- Ajuste proteção de carga:
  - `MCP_HUB_RATE_LIMIT_RPS`
  - `MCP_HUB_RATE_LIMIT_BURST`
  - `MCP_HUB_MAX_SESSIONS`
  - `MCP_HUB_MAX_SESSIONS_PER_SERVER`

## Onboarding de novo MCP

1. Adicione no `mcp-hub.config.json`:
   - `servers.<name>.command`
   - `servers.<name>.args`
   - `servers.<name>.env`
   - `servers.<name>.autoStart`
2. Se houver segredos, use placeholders `${ENV}` e defina no `.env`.
3. Suba/reinicie o hub (`make up` ou `docker compose up -d --build`).
4. Valide:
   - `GET /admin/servers`
   - `POST /admin/servers/:name/start` (se `autoStart=false`)
5. No cliente MCP, use `http://localhost:3333/sse/<name>`.

## Logs

Pino: JSON em `NODE_ENV=production`; em desenvolvimento usa `pino-pretty` quando `NODE_ENV` não é `production`. Linhas do wrapper incluem contexto `{ server: "<nome>" }`.

## Problemas comuns

- **503 em `/mcp/:server`** — Subprocesso parado ou ainda a subir; use `/admin/servers` e `POST .../start` ou `restart`.
- **EADDRINUSE** — Porta em uso; ajuste `PORT` no `.env` ou no host.
- **Variável obrigatória** — Erro no load da config: preencha o placeholder no ambiente (por exemplo `FIGMA_API_KEY`).
- **401 Unauthorized** — Token do gateway ausente/incorreto. Defina `MCP_HUB_AUTH_TOKEN` no `.env` e envie `Authorization: Bearer <token>` nas requisições (inclui clientes MCP).
- **Cliente tentou Streamable HTTP e falhou** — Garanta que o cliente aponta para `GET /sse/:server`; o hub também suporta `POST /sse/:server` para fallback.
- **`unknown session` em `/messages`** — Sessão SSE já foi fechada; reconecte no `/sse/:server` e use o novo `session_id`.
