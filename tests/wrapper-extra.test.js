import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pino from 'pino';
import { MCPServerWrapper } from '../process-manager/wrapper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = pino({ level: 'silent' });

describe('MCPServerWrapper extra branches', () => {
  it('send throws when not running', async () => {
    const w = new MCPServerWrapper('x', { command: 'node', args: ['-e', 'process.exit(0)'], env: {} }, logger);
    await expect(w.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).rejects.toThrow(/not running/);
  });

  it('rejects on JSON-RPC error and exposes rpcError', async () => {
    const fixture = path.join(__dirname, 'fixtures', 'stdio-mcp-error.mjs');
    const w = new MCPServerWrapper('err', { command: 'node', args: [fixture], env: {} }, logger);
    await w.start();
    await expect(w.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).rejects.toMatchObject({
      rpcError: expect.any(Object)
    });
    await w.stop();
  });

  it('ignores invalid JSON lines and still resolves valid response', async () => {
    const fixture = path.join(__dirname, 'fixtures', 'stdio-mcp-invalid-json-first.mjs');
    const w = new MCPServerWrapper('badjson', { command: 'node', args: [fixture], env: {} }, logger);
    await w.start();
    const r = await w.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(r).toMatchObject({ jsonrpc: '2.0', id: 2, result: { ok: true } });
    await w.stop();
  });

  it('captures stderr lines and respects max lines', async () => {
    const fixture = path.join(__dirname, 'fixtures', 'stdio-mcp-stderr-lines.mjs');
    const w = new MCPServerWrapper('stderr', { command: 'node', args: [fixture], env: {} }, logger);
    w.setStderrMaxLines(2);
    await w.start();
    // allow stderr handler to run (poll until captured or timeout)
    const deadline = Date.now() + 2000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (w.getRecentStderrLines(10).length >= 2) break;
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(w.getRecentStderrLines(10)).toEqual(['line2', 'line3']);
    await w.stop();
  });

  it('stops server and rejects pending when stdout buffer cap exceeded', async () => {
    const fixture = path.join(__dirname, 'fixtures', 'stdio-mcp-stdout-cap.mjs');
    const w = new MCPServerWrapper('cap', { command: 'node', args: [fixture], env: {} }, logger);
    await w.start();
    // Wait for buffer cap logic to trigger stop.
    await new Promise((r) => setTimeout(r, 50));
    await expect(w.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).rejects.toThrow();
    await w.stop();
  });

  it('force kills child when SIGTERM is ignored (fake timers)', async () => {
    vi.useFakeTimers();
    const fixture = path.join(__dirname, 'fixtures', 'stdio-mcp-ignore-sigterm.mjs');
    const w = new MCPServerWrapper('term', { command: 'node', args: [fixture], env: {} }, logger);
    await w.start();
    const stopP = w.stop();
    await vi.advanceTimersByTimeAsync(9000);
    await stopP;
    vi.useRealTimers();
  });
});

