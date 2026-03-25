# mcp-hub

Gateway HTTP/SSE para servidores MCP que falam apenas stdio (NDJSON). Um único processo expõe `POST /mcp/:server` e um modo SSE compatível com MCP (com `GET /sse/:server` + `POST /messages`); por trás, cada servidor MCP roda como subprocesso isolado com correlação JSON-RPC por `id`.

## Requisitos

- Node.js 20+
- Docker e Docker Compose (execução recomendada)

## Configuração

1. Copie o ambiente: `cp .env.example .env` e ajuste `PORT` se necessário.
2. Edite `mcp-hub.config.json`: defina `servers` com `command`, `args`, `env` (apenas chaves necessárias; valores podem usar `"${VAR}"` resolvidos a partir do ambiente).
3. Não coloque segredos literais no JSON; use placeholders e variáveis no `.env`.

Alterações em `mcp-hub.config.json` exigem **reinício do processo** (sem hot-reload no MVP).

## Execução com Docker

```bash
docker compose up -d
```

ou `make up`.

Health: `GET http://localhost:3333/health` (ou `make health`).

## Desenvolvimento local

```bash
npm install
npm run dev
```

## Endpoints principais

| Método | Caminho | Descrição |
|--------|---------|-----------|
| GET | `/health` | Liveness |
| POST | `/mcp/:server` | Corpo JSON-RPC 2.0; resposta é o objeto JSON-RPC retornado pelo servidor MCP |
| POST | `/sse/:server` | Alias para compatibilidade (fallback de cliente "Streamable HTTP") |
| GET | `/sse/:server` | Compatível com MCP SSE: emite `event: endpoint` e depois `event: message` (JSON-RPC); keep-alive `: ping` a cada 15s |
| POST | `/messages` | Recebe mensagens JSON-RPC do cliente (query `session_id`) e devolve via SSE (`event: message`) |
| GET | `/admin/servers` | Lista nomes e se estão em execução |
| POST | `/admin/servers` | Registro dinâmico (corpo: `name`, `command`, `args`, `env`, `autoStart`, …) |
| POST | `/admin/servers/:name/start` | Inicia subprocesso |
| POST | `/admin/servers/:name/stop` | Encerra subprocesso |
| POST | `/admin/servers/:name/restart` | Reinicia subprocesso |

Exemplo:

```bash
curl -s -X POST http://localhost:3333/mcp/echo \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

## Limitações do MVP

- Sem autenticação no gateway (rede confiável / local) **a menos que** `MCP_HUB_AUTH_TOKEN` esteja configurado.
- Sem cluster horizontal; um único nó.
- Sem persistência de mensagens.
- Apenas backends MCP via stdio (não há proxy para servidores que já falam HTTP).
- CORS por allowlist via `MCP_HUB_CORS_ORIGINS` (se vazio, bloqueia origens browser).

## Documentação

- [docs/architecture.md](docs/architecture.md) — módulos e fluxo
- [docs/operations.md](docs/operations.md) — operação e troubleshooting

## Testes

```bash
npm test
```

Cobertura:

```bash
npm run test:coverage
```

O threshold de 100% é aplicado aos módulos determinísticos (`config`, `registry`, `router`, `health`). Módulos com IO de subprocesso/streaming (`transport`, `process-manager`, `index`) são validados por testes de integração dedicados.
