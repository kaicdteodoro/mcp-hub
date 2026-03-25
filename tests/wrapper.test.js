import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pino from 'pino';
import { MCPServerWrapper } from '../process-manager/wrapper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, 'fixtures', 'stdio-mcp-echo.mjs');

const logger = pino({ level: 'silent' });

describe('MCPServerWrapper', () => {
  const def = {
    command: 'node',
    args: [fixture],
    env: {}
  };

  const w = new MCPServerWrapper('echo', def, logger);

  beforeAll(async () => {
    await w.start();
  });

  afterAll(async () => {
    await w.stop();
  });

  it('resolves JSON-RPC by id', async () => {
    const r = await w.send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(r).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: expect.any(Array) }
    });
  });

  it('generates id when omitted', async () => {
    const r = await w.send({ jsonrpc: '2.0', method: 'tools/list' });
    expect(r).toMatchObject({ jsonrpc: '2.0', result: expect.any(Object) });
    expect(r.id).toBeDefined();
  });

  it('handles concurrent requests with distinct ids', async () => {
    const a = w.send({ jsonrpc: '2.0', method: 'tools/list', id: 100 });
    const b = w.send({ jsonrpc: '2.0', method: 'tools/list', id: 200 });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.id).toBe(100);
    expect(rb.id).toBe(200);
  });
});
