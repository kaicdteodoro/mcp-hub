# Arquitetura

Monólito modular com composição apenas em `index.js`:

- **config** — Carrega `mcp-hub.config.json`, resolve `${ENV}` e valida forma mínima.
- **registry** — Metadados dos servidores (sem estado de processo).
- **process-manager** — `MCPServerWrapper` por servidor (stdio NDJSON, `pendingRequests` por `id`, timeout 30s, buffer stdout com teto 1MB), restart automático após crash com teto e atraso configuráveis.
- **router** — Despacho stateless para `dispatch` e assinatura SSE.
- **transport** — Fastify: REST + SSE + admin.
- **health** — `tools/list` periódico quando `healthCheck.enabled`; apenas observabilidade (não reinicia processos).

Ordem de bootstrap: `loadHubConfig` → registry → `ProcessManager` → `Router` → `HealthChecker` → `buildTransport` → `startAll` dos processos → `startAll` health → `listen`. Encerramento: parar health, fechar Fastify, `stopAll` nos subprocessos.
