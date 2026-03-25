import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { execa } from 'execa';

describe('index.js lifecycle', () => {
  it(
    'starts and shuts down on SIGTERM',
    async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-'));
    const configPath = path.join(dir, 'mcp-hub.config.json');
    const port = 38451;
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        hub: { host: '127.0.0.1', port, logLevel: 'silent' },
        servers: {
          echo: { command: 'node', args: ['./tests/fixtures/stdio-mcp-echo.mjs'], env: {}, autoStart: true }
        }
      }),
      'utf8'
    );

    const child = execa('node', ['index.js'], {
      cwd: path.resolve(process.cwd()),
      env: {
        ...process.env,
        MCP_HUB_CONFIG_PATH: configPath,
        PORT: String(port),
        NODE_ENV: 'production'
      },
      reject: false
    });

    // wait until health responds
    const deadline = Date.now() + 10_000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        if (r.ok) break;
      } catch {
        // ignore
      }
      if (Date.now() > deadline) throw new Error('server did not start');
      await new Promise((r) => setTimeout(r, 100));
    }

    child.kill('SIGTERM');
    const res = await child;
    expect(res.exitCode).toBe(0);
    },
    20_000
  );
});

