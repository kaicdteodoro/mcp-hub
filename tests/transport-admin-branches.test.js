import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { Registry, ServerNotFoundError } from '../registry/registry.js';
import { ServerNotRunningError } from '../router/router.js';
import { buildTransport } from '../transport/transport.js';

function mkBase(overrides = {}) {
  const logger = pino({ level: 'silent' });
  const registry = new Registry({ echo: { command: 'node', autoStart: false } });
  const processManager = {
    getWrapper: () => undefined,
    start: async () => {},
    stop: async () => {},
    restart: async () => {},
    ensureWrapperRegistered: () => {},
    ...overrides.processManager
  };
  const router = {
    dispatch: async () => ({ ok: true }),
    subscribeSSE: () => () => {},
    ...overrides.router
  };
  const healthChecker = {
    registerServer: () => {},
    startAll: () => {},
    stopAll: () => {},
    ...overrides.healthChecker
  };
  return { logger, registry, processManager, router, healthChecker };
}

describe('transport admin branches', () => {
  it('GET /admin/servers/:name returns 404 unknown', async () => {
    const { logger, registry, processManager, router, healthChecker } = mkBase();
    const app = await buildTransport({ logger, registry, processManager, router, healthChecker, hub: {} });
    const res = await app.inject({ method: 'GET', url: '/admin/servers/unknown' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET /admin/servers/:name/logs handles wrapper not found', async () => {
    const { logger, registry, processManager, router, healthChecker } = mkBase();
    const app = await buildTransport({ logger, registry, processManager, router, healthChecker, hub: {} });
    const res = await app.inject({ method: 'GET', url: '/admin/servers/echo/logs' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('admin start/stop/restart generic failures map to 500', async () => {
    const failing = {
      processManager: {
        start: async () => {
          throw new Error('x');
        },
        stop: async () => {
          throw new Error('x');
        },
        restart: async () => {
          throw new Error('x');
        }
      }
    };
    const { logger, registry, processManager, router, healthChecker } = mkBase(failing);
    const app = await buildTransport({ logger, registry, processManager, router, healthChecker, hub: {} });
    const a = await app.inject({ method: 'POST', url: '/admin/servers/echo/start' });
    const b = await app.inject({ method: 'POST', url: '/admin/servers/echo/stop' });
    const c = await app.inject({ method: 'POST', url: '/admin/servers/echo/restart' });
    expect(a.statusCode).toBe(500);
    expect(b.statusCode).toBe(500);
    expect(c.statusCode).toBe(500);
    await app.close();
  });

  it('mcp/sse dispatch not-found/running errors map to status', async () => {
    const { logger, registry, processManager, healthChecker } = mkBase();
    const app = await buildTransport({
      logger,
      registry,
      processManager,
      router: {
        dispatch: async (name) => {
          if (name === 'nf') throw new ServerNotFoundError('nf');
          throw new ServerNotRunningError('echo');
        }
      },
      healthChecker,
      hub: {}
    });
    const nf = await app.inject({ method: 'POST', url: '/mcp/nf', payload: { jsonrpc: '2.0', id: 1 } });
    const nr = await app.inject({ method: 'POST', url: '/mcp/echo', payload: { jsonrpc: '2.0', id: 9 } });
    const sf = await app.inject({ method: 'POST', url: '/sse/nf', payload: { jsonrpc: '2.0', id: 2 } });
    expect(nf.statusCode).toBe(404);
    expect(nr.statusCode).toBe(503);
    expect(sf.statusCode).toBe(404);
    await app.close();
  });
});

