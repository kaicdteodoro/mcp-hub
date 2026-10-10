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

## `figma-write`

O hub agora pode registrar um servidor MCP de escrita para Figma separado do `figma-developer-mcp` de leitura.

O fixture `fixtures/stdio-mcp-figma-write.mjs` já entrega:

- contrato de tools para `find_nodes`, `rename_node`, `set_text`, `dry_run` e `batch_apply`
- validação estrutural das operações
- `dry_run` funcional no nível de contrato
- carregamento opcional de uma bridge real via `FIGMA_WRITE_BRIDGE_MODULE`

Sem bridge configurada, o servidor responde em modo seguro com `bridge_missing`. Isso permite validar batches e integrar o fluxo antes de liberar escrita real.

Exemplo de configuração de ambiente:

```bash
FIGMA_WRITE_BRIDGE_MODULE=./bridges/http-figma-write-bridge.mjs
FIGMA_WRITE_BRIDGE_URL=http://127.0.0.1:3847
FIGMA_WRITE_BRIDGE_TOKEN=secret
```

Bridge esperada:

- `findNodes({ fileKey, query, page?, nodeType? })`
- `dryRun({ fileKey, mode, operations })`
- `batchApply({ fileKey, mode, operations })`

Contrato HTTP mínimo esperado da bridge:

- `POST /find-nodes`:
  - entrada: `{ fileKey, query, page?, nodeType? }`
  - saída: `{ status, matches: [{ nodeId, name?, page?, nodeType? }, ...] }`
- `POST /dry-run`:
  - entrada: `{ fileKey, mode, operations }`
  - saída: `{ status, validOperations?, invalidOperations?, errors?, warnings? }`
- `POST /batch-apply`:
  - entrada: `{ fileKey, mode, operations }`
  - saída: `{ status, appliedOperations?, errors?, warnings? }`

O módulo pode exportar `default` ou named exports. Quando ausente, o fixture usa uma bridge stub.

O repositório já inclui uma bridge HTTP pronta em [bridges/http-figma-write-bridge.mjs](bridges/http-figma-write-bridge.mjs). Ela espera um serviço local com estes endpoints:

- `POST /find-nodes`
- `POST /dry-run`
- `POST /batch-apply`

Todos recebem JSON e podem ser protegidos com `Authorization: Bearer <FIGMA_WRITE_BRIDGE_TOKEN>`.

Status prático do `figma-write` neste repositório:

- MCP stdio pronto
- contrato de operações pronto
- bridge HTTP client pronta
- bridge service local pronta em `bridges/local-figma-write-service.mjs`
- plugin Figma de desenvolvimento pronto em `bridges/figma-write-plugin/`
- testes de contrato e fim a fim do fixture prontos
- o que ainda falta fora do repo: apenas carregar o plugin no Figma Desktop e deixá-lo conectado ao bridge local

## Bridge local real

Este repositório agora inclui a implementação local completa do loop de escrita:

1. `npm run figma-write:bridge`
2. importar o plugin em `bridges/figma-write-plugin/manifest.json` no Figma Desktop
3. rodar `Start Bridge Agent`
4. manter o `mcp-hub` apontando para `http://127.0.0.1:3847`

Fluxo:

- `mcp-hub` chama a bridge HTTP local
- a bridge enfileira o comando para a sessão do plugin conectada ao `fileKey`
- o plugin executa a operação no arquivo aberto
- o resultado volta pela bridge e é devolvido ao MCP

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
