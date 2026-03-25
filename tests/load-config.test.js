import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadHubConfig } from '../config/load-config.js';

function writeTmpJson(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
  return file;
}

describe('loadHubConfig', () => {
  it('throws when config file is missing', async () => {
    await expect(loadHubConfig('/tmp/does-not-exist.json')).rejects.toThrow(/Config file not found/);
  });

  it('throws on invalid JSON', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-hub-'));
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, '{', 'utf8');
    await expect(loadHubConfig(file)).rejects.toThrow(/Invalid JSON/);
  });

  it('requires servers to be an object', async () => {
    const file = writeTmpJson({ hub: {}, servers: null });
    await expect(loadHubConfig(file)).rejects.toThrow(/config\.servers must be an object/);
  });

  it('requires server definition objects and command', async () => {
    const file1 = writeTmpJson({ servers: { a: null } });
    await expect(loadHubConfig(file1)).rejects.toThrow(/servers\.a must be an object/);

    const file2 = writeTmpJson({ servers: { a: {} } });
    await expect(loadHubConfig(file2)).rejects.toThrow(/servers\.a\.command is required/);
  });

  it('resolves ${ENV} and throws if missing for autoStart true', async () => {
    const prev = process.env.REQ_ENV;
    delete process.env.REQ_ENV;
    const file = writeTmpJson({
      servers: {
        a: { command: 'node', env: { X: '${REQ_ENV}' }, autoStart: true }
      }
    });
    await expect(loadHubConfig(file)).rejects.toThrow(/Missing required environment variable "REQ_ENV"/);
    process.env.REQ_ENV = prev;
  });

  it('allows missing ${ENV} for autoStart false servers (sets blank)', async () => {
    const prev = process.env.OPT_ENV;
    delete process.env.OPT_ENV;
    const file = writeTmpJson({
      servers: {
        a: { command: 'node', env: { X: '${OPT_ENV}' }, autoStart: false }
      }
    });
    const cfg = await loadHubConfig(file);
    expect(cfg.servers.a.env.X).toBe('');
    process.env.OPT_ENV = prev;
  });

  it('resolves existing ${ENV} and keeps plain strings unchanged', async () => {
    const prev = process.env.REQ_ENV_OK;
    process.env.REQ_ENV_OK = 'value-ok';
    const file = writeTmpJson({
      servers: {
        a: {
          command: 'node',
          args: ['--x', 'plain'],
          env: { X: '${REQ_ENV_OK}', Y: 'plain-text' },
          autoStart: true
        }
      }
    });
    const cfg = await loadHubConfig(file);
    expect(cfg.servers.a.env.X).toBe('value-ok');
    expect(cfg.servers.a.env.Y).toBe('plain-text');
    process.env.REQ_ENV_OK = prev;
  });
});

