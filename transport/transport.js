import Fastify from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { ServerNotFoundError } from '../registry/registry.js';
import { ServerNotRunningError } from '../router/router.js';

/**
 * @typedef {import('../router/router.js').Router} Router
 * @typedef {import('../registry/registry.js').Registry} Registry
 * @typedef {import('../process-manager/process-manager.js').ProcessManager} ProcessManager
 * @typedef {import('../health/health.js').HealthChecker} HealthChecker
 * @typedef {import('pino').Logger} Logger
 * @typedef {{ port?: number, host?: string, ssePingIntervalMs?: number }} HubSection
 */

/**
 * @param {object} opts
 * @param {Router} opts.router
 * @param {Registry} opts.registry
 * @param {ProcessManager} opts.processManager
 * @param {HealthChecker} opts.healthChecker
 * @param {Logger} opts.logger
 * @param {HubSection} opts.hub
 */
export async function buildTransport(opts) {
  const { router, registry, processManager, healthChecker, logger, hub } = opts;

  const app = Fastify({ logger: false });
  const corsAllowlist = (process.env.MCP_HUB_CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  await app.register(cors, {
    origin(origin, cb) {
      // Non-browser clients won't send Origin.
      if (!origin) return cb(null, true);
      if (corsAllowlist.length === 0) return cb(null, false);
      return cb(null, corsAllowlist.includes(origin));
    }
  });

  const ssePingMs = hub.ssePingIntervalMs ?? 15_000;
  const authToken = process.env.MCP_HUB_AUTH_TOKEN ?? '';
  const requireAuth = authToken.length > 0 || process.env.NODE_ENV === 'production';

  // Very small, dependency-free rate limiting.
  const rateRps = Number(process.env.MCP_HUB_RATE_LIMIT_RPS ?? 10);
  const rateBurst = Number(process.env.MCP_HUB_RATE_LIMIT_BURST ?? 20);
  /** @type {Map<string, { tokens: number, lastRefillMs: number }>} */
  const rateBuckets = new Map();

  /**
   * @param {string} key
   * @returns {boolean} true if allowed
   */
  function rateAllow(key) {
    if (!Number.isFinite(rateRps) || rateRps <= 0) return true;
    const now = Date.now();
    const b = rateBuckets.get(key) ?? { tokens: rateBurst, lastRefillMs: now };
    const elapsed = Math.max(0, now - b.lastRefillMs);
    const refill = (elapsed / 1000) * rateRps;
    b.tokens = Math.min(rateBurst, b.tokens + refill);
    b.lastRefillMs = now;
    if (b.tokens < 1) {
      rateBuckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    rateBuckets.set(key, b);
    return true;
  }

  /**
   * JSON-RPC error formatting for MCP clients.
   * Client validates JSON-RPC error shape strictly (incl. `error.code` number).
   *
   * @param {unknown} id
   * @param {unknown} err
   */
  function toJsonRpcError(id, err) {
    const rpcError = err && typeof err === 'object' ? /** @type {any} */ (err).rpcError : undefined;
    const message =
      (rpcError && typeof rpcError.message === 'string' && rpcError.message) ||
      String(err?.message ?? err);

    const code =
      (rpcError && typeof rpcError.code === 'number' && rpcError.code) ||
      -32000;

    const error = {
      code,
      message
    };

    if (rpcError && typeof rpcError === 'object' && 'data' in rpcError) {
      error.data = /** @type {{ data?: unknown }} */ (rpcError).data;
    }

    return {
      jsonrpc: '2.0',
      id: typeof id === 'undefined' ? null : id,
      error
    };
  }

  /**
   * @param {import('fastify').FastifyRequest} request
   * @param {import('fastify').FastifyReply} reply
   * @returns {boolean} true if ok, false if already replied
   */
  function enforceAuth(request, reply) {
    if (!requireAuth) return true;
    const h = request.headers.authorization;
    const provided = typeof h === 'string' && h.startsWith('Bearer ') ? h.slice('Bearer '.length) : '';
    if (!authToken || provided !== authToken) {
      reply.code(401).send({ error: 'unauthorized' });
      return false;
    }
    return true;
  }

  /**
   * MCP SSE compatibility:
   * - On GET /sse/:server: keep a session open and send `event: endpoint` telling the client where to POST messages.
   * - On POST /messages?session_id=...: forward JSON-RPC messages to the subprocess and emit `event: message` back to the same session.
   */
  /** @type {Map<string, { serverName: string, raw: import('node:http').ServerResponse, writeEvent: (payload: unknown) => void }>} */
  const sessions = new Map();
  /** @type {Map<string, { unsubscribe: () => void, notificationListener: (msg: unknown) => void, sessionCount: number }>} */
  const serverForwarders = new Map();
  const maxSessionsGlobal = Number(process.env.MCP_HUB_MAX_SESSIONS ?? 200);
  const maxSessionsPerServer = Number(process.env.MCP_HUB_MAX_SESSIONS_PER_SERVER ?? 50);

  /**
   * @param {import('node:http').ServerResponse} raw
   * @param {string} eventName
   * @param {string} data
   */
  function writeSseEvent(raw, eventName, data) {
    raw.write(`event: ${eventName}\n`);
    raw.write(`data: ${data}\n\n`);
    // Flush ASAP for SSE clients that buffer small chunks.
    if (typeof raw.flush === 'function') raw.flush();
  }

  /**
   * @param {string} serverName
   */
  function ensureNotificationForwarder(serverName) {
    const existing = serverForwarders.get(serverName);
    if (existing) return existing;

    const w = processManager.getWrapper(serverName);
    if (!w) {
      throw new ServerNotRunningError(serverName);
    }

    const notificationListener = (msg) => {
      // Only forward notifications (no JSON-RPC `id`) to avoid duplicating responses
      // that we already emit from the POST /messages handler.
      if (msg && typeof msg === 'object' && !('id' in msg)) {
        for (const [, s] of sessions) {
          if (s.serverName !== serverName) continue;
          writeSseEvent(s.raw, 'message', JSON.stringify(msg));
        }
      }
    };

    w.on('message', notificationListener);
    const forwarder = {
      notificationListener,
      unsubscribe: () => w.off('message', notificationListener),
      sessionCount: 0
    };
    serverForwarders.set(serverName, forwarder);
    return forwarder;
  }

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/mcp/:server', async (request, reply) => {
    if (!enforceAuth(request, reply)) return;
    const ip = request.ip ?? 'unknown';
    if (!rateAllow(`mcp:${ip}`)) {
      reply.code(429);
      return { error: 'rate_limited' };
    }
    const server = /** @type {{ server: string }} */ (request.params).server;
    const start = Date.now();
    try {
      const body = request.body;
      const payload =
        body && typeof body === 'object' && !Array.isArray(body)
          ? /** @type {Record<string, unknown>} */ (body)
          : {};
      const result = await router.dispatch(server, payload);
      logger.info({ server, route: '/mcp/:server', latencyMs: Date.now() - start }, 'mcp dispatch ok');
      return result;
    } catch (e) {
      if (e instanceof ServerNotFoundError) {
        reply.code(404);
        logger.warn({ server, route: '/mcp/:server', latencyMs: Date.now() - start }, 'mcp server not found');
        return toJsonRpcError(
          /** @type {{ id?: unknown }} */ (request.body ?? {}).id,
          e
        );
      }
      if (e instanceof ServerNotRunningError) {
        reply.code(503);
        logger.warn({ server, route: '/mcp/:server', latencyMs: Date.now() - start }, 'mcp server not running');
        return toJsonRpcError(
          /** @type {{ id?: unknown }} */ (request.body ?? {}).id,
          e
        );
      }
      logger.error({ err: String(e) }, 'dispatch failed');
      reply.code(500);
      logger.error({ server, route: '/mcp/:server', latencyMs: Date.now() - start }, 'mcp dispatch failed');
      return toJsonRpcError(
        /** @type {{ id?: unknown }} */ (request.body ?? {}).id,
        e
      );
    }
  });

  // Alias for "Streamable HTTP" fallback:
  // Client may attempt POST to the same base as the SSE endpoint (e.g. /sse/figma).
  app.post('/sse/:server', async (request, reply) => {
    if (!enforceAuth(request, reply)) return;
    const ip = request.ip ?? 'unknown';
    if (!rateAllow(`mcp:${ip}`)) {
      reply.code(429);
      return { error: 'rate_limited' };
    }
    const server = /** @type {{ server: string }} */ (request.params).server;
    const start = Date.now();
    try {
      const body = request.body;
      const payload =
        body && typeof body === 'object' && !Array.isArray(body)
          ? /** @type {Record<string, unknown>} */ (body)
          : {};
      const result = await router.dispatch(server, payload);
      logger.info({ server, route: 'POST /sse/:server', latencyMs: Date.now() - start }, 'streamable fallback ok');
      return result;
    } catch (e) {
      if (e instanceof ServerNotFoundError) {
        reply.code(404);
        logger.warn({ server, route: 'POST /sse/:server', latencyMs: Date.now() - start }, 'streamable server not found');
        return toJsonRpcError(
          /** @type {{ id?: unknown }} */ (request.body ?? {}).id,
          e
        );
      }
      if (e instanceof ServerNotRunningError) {
        reply.code(503);
        logger.warn({ server, route: 'POST /sse/:server', latencyMs: Date.now() - start }, 'streamable server not running');
        return toJsonRpcError(
          /** @type {{ id?: unknown }} */ (request.body ?? {}).id,
          e
        );
      }
      logger.error({ err: String(e) }, 'dispatch failed');
      reply.code(500);
      logger.error({ server, route: 'POST /sse/:server', latencyMs: Date.now() - start }, 'streamable fallback failed');
      return toJsonRpcError(
        /** @type {{ id?: unknown }} */ (request.body ?? {}).id,
        e
      );
    }
  });

  app.get('/sse/:server', async (request, reply) => {
    if (!enforceAuth(request, reply)) return;
    const server = /** @type {{ server: string }} */ (request.params).server;
    if (sessions.size >= maxSessionsGlobal) {
      reply.code(503).send({ error: 'too_many_sessions' });
      return;
    }
    let serverSessions = 0;
    for (const [, s] of sessions) {
      if (s.serverName === server) serverSessions += 1;
    }
    if (serverSessions >= maxSessionsPerServer) {
      reply.code(503).send({ error: 'too_many_sessions_for_server' });
      return;
    }

    try {
      // Ensure wrapper exists and is running so the session can immediately handle client initialization.
      const w = processManager.getWrapper(server);
      if (!w || !w.isRunning()) {
        await processManager.start(server);
      }
      registry.getRequired(server);
      ensureNotificationForwarder(server);
    } catch (e) {
      if (e instanceof ServerNotFoundError) {
        reply.code(404).send({ error: /** @type {Error} */ (e).message });
        return;
      }
      if (e instanceof ServerNotRunningError) {
        reply.code(503).send({ error: /** @type {Error} */ (e).message });
        return;
      }
      logger.error({ err: String(e) }, 'failed to start SSE session');
      reply.code(500).send({ error: 'failed to start session' });
      return;
    }

    const sessionId = randomUUID();
    logger.info({ server, session_id: sessionId }, 'sse session open');
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    if (typeof reply.raw.flushHeaders === 'function') reply.raw.flushHeaders();

    const postEndpoint = `/messages?session_id=${encodeURIComponent(sessionId)}`;
    // Endpoint data is a plain URL/path string (not JSON-stringified), as expected by MCP SSE clients.
    writeSseEvent(reply.raw, 'endpoint', postEndpoint);

    const sseSession = {
      serverName: server,
      raw: reply.raw,
      writeEvent: (payload) => writeSseEvent(reply.raw, 'message', JSON.stringify(payload))
    };

    sessions.set(sessionId, sseSession);
    const forwarder = serverForwarders.get(server);
    if (forwarder) forwarder.sessionCount += 1;

    const ping = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, ssePingMs);

    request.raw.on('close', () => {
      clearInterval(ping);
      sessions.delete(sessionId);
      logger.info({ server, session_id: sessionId }, 'sse session closed');

      const f = serverForwarders.get(server);
      if (f) {
        f.sessionCount = Math.max(0, f.sessionCount - 1);
        if (f.sessionCount === 0) {
          f.unsubscribe();
          serverForwarders.delete(server);
        }
      }
    });
  });

  app.get('/admin/servers', async (request, reply) => {
    if (!enforceAuth(request, reply)) return;
    const servers = [];
    for (const name of registry.names()) {
      const w = processManager.getWrapper(name);
      servers.push({
        name,
        running: w?.isRunning() ?? false,
        autoStart: registry.get(name)?.autoStart ?? false
      });
    }
    return { servers };
  });

  app.get('/admin/servers/:name', async (request, reply) => {
    if (!enforceAuth(request, reply)) return;
    const name = /** @type {{ name: string }} */ (request.params).name;
    try {
      const def = registry.getRequired(name);
      const w = processManager.getWrapper(name);
      return {
        name,
        running: w?.isRunning() ?? false,
        definition: def
      };
    } catch (e) {
      if (e instanceof ServerNotFoundError) {
        reply.code(404);
        return { error: /** @type {Error} */ (e).message };
      }
      reply.code(500);
      return { error: 'internal error' };
    }
  });

  app.get('/admin/servers/:name/logs', async (request, reply) => {
    if (!enforceAuth(request, reply)) return;
    const name = /** @type {{ name: string }} */ (request.params).name;
    const limit = typeof request.query?.limit === 'string' ? Number(request.query.limit) : 100;
    try {
      registry.getRequired(name);
      const w = processManager.getWrapper(name);
      if (!w) {
        reply.code(404);
        return { error: 'wrapper not found' };
      }
      const lines = typeof w.getRecentStderrLines === 'function' ? w.getRecentStderrLines(limit) : [];
      return { name, stderr: lines };
    } catch (e) {
      if (e instanceof ServerNotFoundError) {
        reply.code(404);
        return { error: /** @type {Error} */ (e).message };
      }
      reply.code(500);
      return { error: 'internal error' };
    }
  });

  app.post('/admin/servers', async (request, reply) => {
    if (!enforceAuth(request, reply)) return;
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      reply.code(400);
      return { error: 'expected JSON object' };
    }
    const b = /** @type {Record<string, unknown>} */ (body);
    const name = b.name;
    if (typeof name !== 'string' || !name.length) {
      reply.code(400);
      return { error: 'name is required' };
    }
    const overwrite = request.query?.overwrite === '1' || request.query?.overwrite === 'true';
    if (!overwrite && registry.get(name)) {
      reply.code(409);
      return { error: 'server already exists' };
    }
    const command = b.command;
    if (typeof command !== 'string' || !command.length) {
      reply.code(400);
      return { error: 'command is required' };
    }
    const args =
      Array.isArray(b.args) && b.args.every((x) => typeof x === 'string')
        ? /** @type {string[]} */ (b.args)
        : Array.isArray(b.args)
          ? null
          : [];
    if (args === null) {
      reply.code(400);
      return { error: 'args must be an array of strings' };
    }

    const env =
      b.env && typeof b.env === 'object' && !Array.isArray(b.env)
        ? Object.fromEntries(
            Object.entries(/** @type {Record<string, unknown>} */ (b.env)).map(([k, v]) => [k, String(v)])
          )
        : {};

    /** @type {import('../config/load-config.js').HubServerDefinition} */
    const def = {
      command,
      args,
      env,
      autoStart: Boolean(b.autoStart),
      restartDelay: typeof b.restartDelay === 'number' ? b.restartDelay : undefined,
      maxRestarts: typeof b.maxRestarts === 'number' ? b.maxRestarts : undefined,
      healthCheck:
        b.healthCheck && typeof b.healthCheck === 'object'
          ? /** @type {{ enabled?: boolean, intervalMs?: number, timeoutMs?: number }} */ (b.healthCheck)
          : undefined
    };

    registry.register(name, def);
    processManager.ensureWrapperRegistered(name);
    healthChecker.registerServer(name, def);

    if (def.autoStart) {
      await processManager.start(name);
    }

    reply.code(201);
    return { ok: true, name };
  });

  app.post('/admin/servers/:name/start', async (request, reply) => {
    if (!enforceAuth(request, reply)) return;
    const name = /** @type {{ name: string }} */ (request.params).name;
    try {
      await processManager.start(name);
      return { ok: true };
    } catch (e) {
      if (e instanceof ServerNotFoundError) {
        reply.code(404);
        return { error: /** @type {Error} */ (e).message };
      }
      logger.error({ err: String(e) }, 'admin start failed');
      reply.code(500);
      return { error: 'start failed' };
    }
  });

  app.post('/admin/servers/:name/stop', async (request, reply) => {
    if (!enforceAuth(request, reply)) return;
    const name = /** @type {{ name: string }} */ (request.params).name;
    try {
      await processManager.stop(name);
      return { ok: true };
    } catch (e) {
      if (e instanceof ServerNotFoundError) {
        reply.code(404);
        return { error: /** @type {Error} */ (e).message };
      }
      reply.code(500);
      return { error: 'stop failed' };
    }
  });

  app.post('/admin/servers/:name/restart', async (request, reply) => {
    if (!enforceAuth(request, reply)) return;
    const name = /** @type {{ name: string }} */ (request.params).name;
    try {
      await processManager.restart(name);
      return { ok: true };
    } catch (e) {
      if (e instanceof ServerNotFoundError) {
        reply.code(404);
        return { error: /** @type {Error} */ (e).message };
      }
      reply.code(500);
      return { error: 'restart failed' };
    }
  });

  app.post('/messages', async (request, reply) => {
    if (!enforceAuth(request, reply)) return;
    const ip = request.ip ?? 'unknown';
    if (!rateAllow(`messages:${ip}`)) {
      reply.code(429);
      return { error: 'rate_limited' };
    }
    const start = Date.now();
    const sessionIdParam =
      typeof request.query?.session_id === 'string'
        ? request.query.session_id
        : typeof request.query?.sessionId === 'string'
          ? request.query.sessionId
          : undefined;

    if (!sessionIdParam) {
      reply.code(400);
      return { error: 'session_id is required' };
    }

    const session = sessions.get(sessionIdParam);
    if (!session) {
      reply.code(404);
      logger.warn({ session_id: sessionIdParam, route: 'POST /messages', latencyMs: Date.now() - start }, 'unknown session');
      return { error: 'unknown session' };
    }

    const body = request.body;
    const jsonRpcMsg =
      body && typeof body === 'object' && !Array.isArray(body) ? /** @type {Record<string, unknown>} */ (body) : null;

    if (!jsonRpcMsg) {
      reply.code(400);
      return { error: 'expected JSON object' };
    }

    const w = processManager.getWrapper(session.serverName);
    if (!w || !w.isRunning()) {
      reply.code(503);
      logger.warn(
        { server: session.serverName, session_id: sessionIdParam, route: 'POST /messages', latencyMs: Date.now() - start },
        'server not running'
      );
      return { error: 'server not running' };
    }

    try {
      const responseMsg = await w.send(jsonRpcMsg);
      session.writeEvent(responseMsg);
      logger.info(
        { server: session.serverName, session_id: sessionIdParam, route: 'POST /messages', latencyMs: Date.now() - start },
        'message ok'
      );
      reply.code(202);
      return { ok: true };
    } catch (e) {
      const id = typeof jsonRpcMsg.id !== 'undefined' ? jsonRpcMsg.id : null;
      session.writeEvent(toJsonRpcError(id, e));
      logger.warn(
        { server: session.serverName, session_id: sessionIdParam, route: 'POST /messages', latencyMs: Date.now() - start },
        'message failed'
      );
      reply.code(202);
      return { ok: true };
    }
  });

  return app;
}
