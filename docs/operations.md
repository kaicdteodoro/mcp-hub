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

## Operação do `figma-write`

O servidor `figma-write` depende de uma bridge externa para realmente escrever no Figma. O caminho padrão do repositório é:

- `FIGMA_WRITE_BRIDGE_MODULE=./bridges/http-figma-write-bridge.mjs`
- `FIGMA_WRITE_BRIDGE_URL=http://127.0.0.1:3847`
- `FIGMA_WRITE_BRIDGE_TOKEN=<opcional>`

Fluxo operacional:

1. Inicie o serviço local:
   - `npm run figma-write:bridge`
2. Importe o plugin local em `bridges/figma-write-plugin/manifest.json` no Figma Desktop.
3. Rode `Start Bridge Agent` no arquivo que será editado.
4. Recrie o `hub` para propagar as envs novas ao subprocesso `figma-write`.
5. Inicie `figma-write` via `/admin/servers/figma-write/start`.
6. Valide primeiro com `dry_run` antes de liberar `batch_apply`.

Sem bridge configurada, o MCP continua disponível, mas responde `bridge_missing` para manter o fluxo seguro.

Definição prática de pronto para uso real:

- `tools/list` expõe `find_nodes`, `rename_node`, `set_text`, `dry_run`, `batch_apply`
- `dry_run` responde com bridge configurada e sem `bridge_missing`
- `batch_apply` retorna `applied` em um arquivo real de teste
- releitura subsequente via MCP de leitura confirma a mutação esperada no Figma

## Endpoints do serviço local

- `GET /health`
- `POST /plugin/register`
- `POST /plugin/heartbeat`
- `GET /plugin/next?session_id=...&wait_ms=25000`
- `POST /plugin/result`
- `POST /find-nodes`
- `POST /dry-run`
- `POST /batch-apply`

## Variáveis úteis

- `FIGMA_WRITE_BRIDGE_HOST` default `127.0.0.1`
- `FIGMA_WRITE_BRIDGE_PORT` default `3847`
- `FIGMA_WRITE_BRIDGE_TOKEN` opcional
- `FIGMA_WRITE_BRIDGE_SESSION_TTL_MS` default `120000`
- `FIGMA_WRITE_BRIDGE_COMMAND_TIMEOUT_MS` default `30000`

## Logs

Pino: JSON em `NODE_ENV=production`; em desenvolvimento usa `pino-pretty` quando `NODE_ENV` não é `production`. Linhas do wrapper incluem contexto `{ server: "<nome>" }`.

## Problemas comuns

- **503 em `/mcp/:server`** — Subprocesso parado ou ainda a subir; use `/admin/servers` e `POST .../start` ou `restart`.
- **EADDRINUSE** — Porta em uso; ajuste `PORT` no `.env` ou no host.
- **Variável obrigatória** — Erro no load da config: preencha o placeholder no ambiente (por exemplo `FIGMA_API_KEY`).
- **401 Unauthorized** — Token do gateway ausente/incorreto. Defina `MCP_HUB_AUTH_TOKEN` no `.env` e envie `Authorization: Bearer <token>` nas requisições (inclui clientes MCP).
- **Cliente tentou Streamable HTTP e falhou** — Garanta que o cliente aponta para `GET /sse/:server`; o hub também suporta `POST /sse/:server` para fallback.
- **`unknown session` em `/messages`** — Sessão SSE já foi fechada; reconecte no `/sse/:server` e use o novo `session_id`.
