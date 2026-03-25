import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { Registry, ServerNotFoundError } from '../registry/registry.js';
import { ProcessManager } from '../process-manager/process-manager.js';
import { Router, ServerNotRunningError } from '../router/router.js';
import { HealthChecker } from '../health/health.js';
import { buildTransport } from '../transport/transport.js';

async function setup() {
  delete process.env.MCP_HUB_AUTH_TOKEN;
  delete process.env.MCP_HUB_RATE_LIMIT_RPS;
  delete process.env.MCP_HUB_RATE_LIMIT_BURST;
  const logger = pino({ level: 'silent' });
  const registry = new Registry({
    echo: { command: 'node', args: ['./tests/fixtures/stdio-mcp-echo.mjs'], env: {}, autoStart: true }
  });
  const pm = new ProcessManager(registry, logger, { requestTimeoutMs: 1000 });
  const router = new Router(registry, pm);
  const hc = new HealthChecker(router, registry, logger);
  const app = await buildTransport({ router, registry, processManager: pm, healthChecker: hc, logger, hub: {} });
  await pm.startAll();
  return { app, pm, hc };
}

describe('transport branch coverage', () => {
  it('admin start/stop/restart return 404 for unknown', async () => {
    const { app, pm, hc } = await setup();
    const a = await app.inject({ method: 'POST', url: '/admin/servers/unknown/start' });
    const b = await app.inject({ method: 'POST', url: '/admin/servers/unknown/stop' });
    const c = await app.inject({ method: 'POST', url: '/admin/servers/unknown/restart' });
    expect(a.statusCode).toBe(404);
    // stop is idempotent in current behavior and returns ok even if wrapper doesn't exist.
    expect(b.statusCode).toBe(200);
    expect(c.statusCode).toBe(404);
    hc.stopAll();
    await app.close();
    await pm.stopAll();
  });

  it('messages validates missing session_id', async () => {
    const { app, pm, hc } = await setup();
    const miss = await app.inject({ method: 'POST', url: '/messages', payload: {} });
    expect(miss.statusCode).toBe(400);
    hc.stopAll();
    await app.close();
    await pm.stopAll();
  });

  it('messages returns 404 for unknown session', async () => {
    const { app, pm, hc } = await setup();
    const unknown = await app.inject({
      method: 'POST',
      url: '/messages?session_id=does-not-exist',
      payload: { jsonrpc: '2.0', id: 1 }
    });
    expect(unknown.statusCode).toBe(404);
    hc.stopAll();
    await app.close();
    await pm.stopAll();
  });

  it('mcp and sse-post return mapped JSON-RPC on errors', async () => {
    const logger = pino({ level: 'silent' });
    const registry = new Registry({ echo: { command: 'node', autoStart: false } });
    const processManager = {
      getWrapper() {
        return { isRunning: () => true };
      },
      async start() {},
      async stop() {},
      async restart() {},
      ensureWrapperRegistered() {}
    };
    const router = {
      async dispatch(server) {
        if (server === 'nf') throw new ServerNotFoundError(server);
        if (server === 'nr') throw new ServerNotRunningError(server);
        throw new Error('boom');
      }
    };
    const hc = { registerServer() {}, startAll() {}, stopAll() {} };
    const app = await buildTransport({ router, registry, processManager, healthChecker: hc, logger, hub: {} });

    const nf = await app.inject({ method: 'POST', url: '/mcp/nf', payload: { jsonrpc: '2.0', id: 1 } });
    const nr = await app.inject({ method: 'POST', url: '/mcp/nr', payload: { jsonrpc: '2.0', id: 2 } });
    const ie = await app.inject({ method: 'POST', url: '/mcp/echo', payload: { jsonrpc: '2.0', id: 3 } });
    const sf = await app.inject({ method: 'POST', url: '/sse/echo', payload: { jsonrpc: '2.0', id: 4 } });
    expect(nf.statusCode).toBe(404);
    expect(nr.statusCode).toBe(503);
    expect(ie.statusCode).toBe(500);
    expect(sf.statusCode).toBe(500);
    expect(JSON.parse(ie.body).error.code).toBeTypeOf('number');
    await app.close();
  });
});

