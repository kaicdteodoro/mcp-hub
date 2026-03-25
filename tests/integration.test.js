import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pino from 'pino';
import { loadHubConfig } from '../config/load-config.js';
import { Registry } from '../registry/registry.js';
import { ProcessManager } from '../process-manager/process-manager.js';
import { Router } from '../router/router.js';
import { HealthChecker } from '../health/health.js';
import { buildTransport } from '../transport/transport.js';

describe('HTTP transport', () => {
  let app;
  let processManager;
  let healthChecker;

  beforeAll(async () => {
    const hubConfig = await loadHubConfig();
    const logger = pino({ level: 'silent' });
    const registry = new Registry(hubConfig.servers);
    processManager = new ProcessManager(registry, logger, {
      requestTimeoutMs: hubConfig.hub?.requestTimeoutMs
    });
    const router = new Router(registry, processManager);
    healthChecker = new HealthChecker(router, registry, logger);

    app = await buildTransport({
      router,
      registry,
      processManager,
      healthChecker,
      logger,
      hub: hubConfig.hub ?? {}
    });

    await processManager.startAll();
  });

  afterAll(async () => {
    healthChecker?.stopAll();
    await app?.close();
    await processManager?.stopAll();
  });

  it('GET /health', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });

  it('POST /mcp/:server proxies JSON-RPC', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/echo',
      headers: { 'content-type': 'application/json' },
      payload: { jsonrpc: '2.0', method: 'tools/list', id: 42 }
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(42);
    expect(body.result).toBeDefined();
  });

  it('GET /admin/servers', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/servers' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.servers).toBeInstanceOf(Array);
    expect(body.servers.some((s) => s.name === 'echo' && s.running)).toBe(true);
  });

  it('returns 404 for unknown server', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/does-not-exist',
      payload: { jsonrpc: '2.0', id: 1 }
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 503 when server is stopped', async () => {
    await processManager.stop('echo');
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/echo',
      payload: { jsonrpc: '2.0', id: 1 }
    });
    expect(res.statusCode).toBe(503);
    await processManager.start('echo');
  });
});
