import { describe, it, expect } from 'vitest';
import pino from 'pino';
import http from 'node:http';
import { Registry } from '../registry/registry.js';
import { ProcessManager } from '../process-manager/process-manager.js';
import { Router } from '../router/router.js';
import { HealthChecker } from '../health/health.js';
import { buildTransport } from '../transport/transport.js';

async function startApp(env = {}) {
  // Reset hardening envs to avoid cross-test bleed.
  for (const k of [
    'MCP_HUB_AUTH_TOKEN',
    'MCP_HUB_CORS_ORIGINS',
    'MCP_HUB_RATE_LIMIT_RPS',
    'MCP_HUB_RATE_LIMIT_BURST',
    'MCP_HUB_MAX_SESSIONS',
    'MCP_HUB_MAX_SESSIONS_PER_SERVER'
  ]) {
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) process.env[k] = String(v);
  const logger = pino({ level: 'silent' });
  const registry = new Registry({
    echo: { command: 'node', args: ['./tests/fixtures/stdio-mcp-echo.mjs'], env: {}, autoStart: true }
  });
  const pm = new ProcessManager(registry, logger, { requestTimeoutMs: 2000 });
  const router = new Router(registry, pm);
  const hc = new HealthChecker(router, registry, logger);
  const app = await buildTransport({ router, registry, processManager: pm, healthChecker: hc, logger, hub: {} });
  await pm.startAll();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const port = app.server.address().port;
  return { app, pm, hc, port };
}

function parseEndpoint(text) {
  const m = text.match(/event: endpoint\r?\ndata: ([^\r\n]+)/);
  return m?.[1]?.trim() ?? '';
}

async function openSseSession(base) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `${base}/sse/echo`,
      { headers: { accept: 'text/event-stream' } },
      (res) => {
        if (res.statusCode !== 200) {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (body += c));
          res.on('end', () => reject(new Error(`bad status ${res.statusCode}: ${body}`)));
          return;
        }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          const ep = parseEndpoint(buf);
          if (ep) resolve({ endpoint: ep, destroy: () => req.destroy() });
        });
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    setTimeout(() => {
      req.destroy();
      reject(new Error('timeout waiting endpoint'));
    }, 5000);
  });
}

describe('transport (full)', () => {
  it('admin overwrite policy: 409 unless overwrite=1', async () => {
    const ctx = await startApp({ MCP_HUB_AUTH_TOKEN: '', NODE_ENV: 'test' });
    const base = `http://127.0.0.1:${ctx.port}`;

    const r1 = await fetch(`${base}/admin/servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', command: 'node', args: [], env: {} })
    });
    expect(r1.status).toBe(201);

    const r2 = await fetch(`${base}/admin/servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', command: 'node', args: [], env: {} })
    });
    expect(r2.status).toBe(409);

    const r3 = await fetch(`${base}/admin/servers?overwrite=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', command: 'node', args: [], env: {} })
    });
    expect(r3.status).toBe(201);

    ctx.hc.stopAll();
    await ctx.app.close();
    await ctx.pm.stopAll();
  });

  it(
    'SSE emits endpoint and message on /messages',
    async () => {
      const ctx = await startApp({ MCP_HUB_AUTH_TOKEN: '', NODE_ENV: 'test' });
      const base = `http://127.0.0.1:${ctx.port}`;
      try {
        const { endpoint, destroy } = await openSseSession(base);
        expect(endpoint).toMatch(/\/messages\?session_id=/);

        const post = await fetch(`${base}${endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 })
        });
        expect(post.status).toBe(202);
        destroy();
      } finally {
        ctx.hc.stopAll();
        await ctx.app.close();
        await ctx.pm.stopAll();
      }
    },
    20_000
  );

  it('auth rejects when token configured', async () => {
    // new app instance with auth required
    const c2 = await startApp({ MCP_HUB_AUTH_TOKEN: 't', NODE_ENV: 'production' });
    const base = `http://127.0.0.1:${c2.port}`;
    const r = await fetch(`${base}/admin/servers`);
    expect(r.status).toBe(401);
    c2.hc.stopAll();
    await c2.app.close();
    await c2.pm.stopAll();
  });

  it('args validation rejects non-string arrays', async () => {
    const ctx = await startApp({ MCP_HUB_AUTH_TOKEN: '', NODE_ENV: 'test' });
    const base = `http://127.0.0.1:${ctx.port}`;
    const r = await fetch(`${base}/admin/servers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'bad', command: 'node', args: [1], env: {} })
    });
    expect(r.status).toBe(400);
    ctx.hc.stopAll();
    await ctx.app.close();
    await ctx.pm.stopAll();
  });

  it('messages returns 400 on invalid payload with valid session', async () => {
    const ctx = await startApp({ MCP_HUB_AUTH_TOKEN: '', NODE_ENV: 'test' });
    const base = `http://127.0.0.1:${ctx.port}`;
    const { endpoint, destroy } = await openSseSession(base);
    const r = await fetch(`${base}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([])
    });
    expect(r.status).toBe(400);
    destroy();
    ctx.hc.stopAll();
    await ctx.app.close();
    await ctx.pm.stopAll();
  });

  it('messages returns 503 when server down for valid session', async () => {
    const ctx = await startApp({ MCP_HUB_AUTH_TOKEN: '', NODE_ENV: 'test' });
    const base = `http://127.0.0.1:${ctx.port}`;
    const { endpoint, destroy } = await openSseSession(base);
    await ctx.pm.stop('echo');
    const r = await fetch(`${base}${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 2 })
    });
    expect(r.status).toBe(503);
    destroy();
    ctx.hc.stopAll();
    await ctx.app.close();
    await ctx.pm.stopAll();
  });
});

