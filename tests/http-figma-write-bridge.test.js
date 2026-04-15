import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import bridge from '../bridges/http-figma-write-bridge.mjs';

describe('http figma write bridge', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.FIGMA_WRITE_BRIDGE_URL = 'http://127.0.0.1:3847';
    process.env.FIGMA_WRITE_BRIDGE_TOKEN = 'secret-token';
    process.env.FIGMA_WRITE_BRIDGE_TIMEOUT_MS = '2500';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.FIGMA_WRITE_BRIDGE_URL;
    delete process.env.FIGMA_WRITE_BRIDGE_TOKEN;
    delete process.env.FIGMA_WRITE_BRIDGE_TIMEOUT_MS;
    vi.restoreAllMocks();
  });

  it('posts JSON payloads with auth header', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'ok', matches: [] })
    });
    global.fetch = fakeFetch;

    const result = await bridge.findNodes({ fileKey: 'abc123', query: 'hero' });

    expect(result.status).toBe('ok');
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = fakeFetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:3847/find-nodes');
    expect(init.headers.authorization).toBe('Bearer secret-token');
    expect(JSON.parse(init.body)).toEqual({ fileKey: 'abc123', query: 'hero' });
  });

  it('throws on non-ok bridge responses', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ error: 'duplicate target name' })
    });

    await expect(
      bridge.batchApply({ fileKey: 'abc123', mode: 'safe_write', operations: [] })
    ).rejects.toThrow('duplicate target name');
  });

  it('requires bridge url', async () => {
    delete process.env.FIGMA_WRITE_BRIDGE_URL;
    await expect(bridge.dryRun({ fileKey: 'abc123', mode: 'safe_write', operations: [] })).rejects.toThrow(
      'Missing required environment variable: FIGMA_WRITE_BRIDGE_URL'
    );
  });
});
