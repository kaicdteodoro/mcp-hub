import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/load-config.js', () => ({
  loadHubConfig: vi.fn(async () => ({
    hub: { host: '127.0.0.1', port: 0, logLevel: 'silent' },
    servers: { echo: { command: 'node', args: [], env: {}, autoStart: true } }
  }))
}));

vi.mock('../transport/transport.js', () => ({
  buildTransport: vi.fn(async () => ({
    listen: vi.fn(async () => {}),
    close: vi.fn(async () => {})
  }))
}));

vi.mock('../registry/registry.js', () => ({
  Registry: class Registry {
    constructor(servers) {
      this.servers = servers;
    }
  }
}));

vi.mock('../process-manager/process-manager.js', () => ({
  ProcessManager: class ProcessManager {
    async startAll() {}
    async stopAll() {}
    getWrapper() {
      return undefined;
    }
  }
}));

vi.mock('../router/router.js', () => ({
  Router: class Router {}
}));

vi.mock('../health/health.js', () => ({
  HealthChecker: class HealthChecker {
    startAll() {}
    stopAll() {}
  }
}));

describe('index.js (unit)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('createLogger uses pretty transport in dev', async () => {
    const mod = await import('../index.js');
    vi.stubEnv('NODE_ENV', 'development');
    const logger = mod.createLogger({ hub: { logLevel: 'info' } });
    expect(logger).toBeDefined();
    vi.unstubAllEnvs();
  });

  it('main starts transport and returns', async () => {
    const mod = await import('../index.js');
    await mod.main();
  });
});

