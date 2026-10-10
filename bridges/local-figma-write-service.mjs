#!/usr/bin/env node
import http from 'node:http';
import { URL } from 'node:url';
import { FigmaWriteBridgeServiceCore } from './local-figma-write-service-core.mjs';

const host = process.env.FIGMA_WRITE_BRIDGE_HOST?.trim() || '127.0.0.1';
const port = parsePositiveInt(process.env.FIGMA_WRITE_BRIDGE_PORT, 3847);
const authToken = process.env.FIGMA_WRITE_BRIDGE_TOKEN?.trim() || '';
const core = new FigmaWriteBridgeServiceCore({
  sessionTtlMs: parsePositiveInt(process.env.FIGMA_WRITE_BRIDGE_SESSION_TTL_MS, 120_000),
  commandTimeoutMs: parsePositiveInt(process.env.FIGMA_WRITE_BRIDGE_COMMAND_TIMEOUT_MS, 30_000)
});

function parsePositiveInt(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('Request body too large.'));
        request.destroy();
      }
    });
    request.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });
    request.on('error', reject);
  });
}

function isAuthorized(request) {
  if (!authToken) return true;
  const header = request.headers.authorization || '';
  return header === `Bearer ${authToken}`;
}

function extractSessionId(url, body = {}) {
  return body.sessionId || url.searchParams.get('session_id') || '';
}

async function routeHubCommand(type, request, response) {
  try {
    const payload = await readJsonBody(request);
    const result = await core.dispatchCommand(type, payload);
    sendJson(response, 200, result);
  } catch (error) {
    const message = error.message || 'Unknown bridge error.';
    const statusCode =
      message.includes('No active Figma write plugin session') || message.includes('fileKey must')
        ? 409
        : message.includes('timed out')
          ? 504
          : 500;

    sendJson(response, statusCode, {
      status: 'error',
      error: message
    });
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  if (!isAuthorized(request)) {
    sendJson(response, 401, {
      status: 'error',
      error: 'Unauthorized.'
    });
    return;
  }

  try {
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, {
        status: 'ok',
        sessions: core.listSessions()
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/plugin/register') {
      const body = await readJsonBody(request);
      sendJson(response, 200, {
        status: 'ok',
        session: core.registerSession(body),
        pollWaitMs: core.defaultPollWaitMs
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/plugin/heartbeat') {
      const body = await readJsonBody(request);
      sendJson(response, 200, {
        status: 'ok',
        session: core.touchSession(extractSessionId(url, body), body)
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/plugin/next') {
      const result = await core.nextCommand(extractSessionId(url), {
        waitMs: parsePositiveInt(url.searchParams.get('wait_ms'), core.defaultPollWaitMs)
      });
      sendJson(response, 200, result);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/plugin/result') {
      const body = await readJsonBody(request);
      sendJson(response, 200, core.completeCommand(extractSessionId(url, body), body.commandId, body));
      return;
    }

    if (request.method === 'POST' && url.pathname === '/find-nodes') {
      await routeHubCommand('find_nodes', request, response);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/dry-run') {
      await routeHubCommand('dry_run', request, response);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/batch-apply') {
      await routeHubCommand('batch_apply', request, response);
      return;
    }

    sendJson(response, 404, {
      status: 'error',
      error: 'Not found.'
    });
  } catch (error) {
    sendJson(response, 400, {
      status: 'error',
      error: error.message || 'Bridge request failed.'
    });
  }
});

server.listen(port, host, () => {
  process.stdout.write(
    JSON.stringify({
      status: 'listening',
      host,
      port
    }) + '\n'
  );
});

function shutdown() {
  core.close('bridge_shutdown');
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

