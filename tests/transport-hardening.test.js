import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pino from 'pino';
import { loadHubConfig } from '../config/load-config.js';
import { Registry } from '../registry/registry.js';
import { ProcessManager } from '../process-manager/process-manager.js';
import { Router } from '../router/router.js';
import { HealthChecker } from '../health/health.js';
import { buildTransport } from '../transport/transport.js';

describe('transport hardening', () => {
  let app;
  let processManager;
  let healthChecker;

  beforeAll(async () => {
    vi.stubEnv('MCP_HUB_AUTH_TOKEN', 't');
    vi.stubEnv('MCP_HUB_CORS_ORIGINS', 'http://allowed.local');
    vi.stubEnv('MCP_HUB_RATE_LIMIT_RPS', '1');
    vi.stubEnv('MCP_HUB_RATE_LIMIT_BURST', '1');
    vi.stubEnv('MCP_HUB_MAX_SESSIONS', '0');

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
    vi.unstubAllEnvs();
    healthChecker?.stopAll();
    await app?.close();
    await processManager?.stopAll();
  });

  it('requires Authorization Bearer token', async () => {
    const res = await app.inject({ method: 'POST', url: '/mcp/echo', payload: { jsonrpc: '2.0', id: 1 } });
    expect(res.statusCode).toBe(401);
  });

  it('rate limits per IP key', async () => {
    const headers = { authorization: 'Bearer t' };
    const a = await app.inject({
      method: 'POST',
      url: '/mcp/echo',
      headers,
      remoteAddress: '203.0.113.9',
      payload: { jsonrpc: '2.0', id: 1 }
    });
    const b = await app.inject({
      method: 'POST',
      url: '/mcp/echo',
      headers,
      remoteAddress: '203.0.113.9',
      payload: { jsonrpc: '2.0', id: 2 }
    });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(429);
  });

  it('blocks SSE when max sessions reached', async () => {
    const res = await app.inject({ method: 'GET', url: '/sse/echo', headers: { authorization: 'Bearer t' } });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).error).toMatch(/too_many_sessions/);
  });

  it('POST /sse/:server alias works and returns JSON-RPC', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/sse/echo',
      headers: { authorization: 'Bearer t' },
      remoteAddress: '203.0.113.10',
      payload: { jsonrpc: '2.0', method: 'tools/list', id: 10 }
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe(10);
    expect(body.result).toBeDefined();
  });

  it('CORS allowlist denies unknown origin', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/mcp/echo',
      headers: { origin: 'http://denied.local', authorization: 'Bearer t' }
    });
    // fastify-cors returns 204 when allowed; denied won't include allow-origin.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

