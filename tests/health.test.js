import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { Registry } from '../registry/registry.js';
import { HealthChecker } from '../health/health.js';

describe('HealthChecker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does nothing when healthCheck.enabled is false', async () => {
    const registry = new Registry({
      a: { command: 'node', healthCheck: { enabled: false } }
    });
    const router = { dispatch: vi.fn() };
    const logger = pino({ level: 'silent' });
    const hc = new HealthChecker(router, registry, logger);
    hc.startAll();
    await vi.runOnlyPendingTimersAsync();
    expect(router.dispatch).not.toHaveBeenCalled();
    hc.stopAll();
  });

  it('runs periodic health checks and handles success + failure', async () => {
    const registry = new Registry({
      ok: { command: 'node', healthCheck: { enabled: true, intervalMs: 10, timeoutMs: 50 } },
      fail: { command: 'node', healthCheck: { enabled: true, intervalMs: 10, timeoutMs: 50 } }
    });

    const router = {
      dispatch: vi.fn(async (name) => {
        if (name === 'fail') throw new Error('nope');
        return { ok: true };
      })
    };

    const logger = pino({ level: 'silent' });
    const hc = new HealthChecker(router, registry, logger);
    hc.startAll();

    await vi.advanceTimersByTimeAsync(30);
    expect(router.dispatch).toHaveBeenCalled();

    hc.stopAll();
    const calls = router.dispatch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
    expect(router.dispatch.mock.calls.length).toBe(calls);
  });

  it('uses default interval and timeout when omitted', async () => {
    const registry = new Registry({
      a: { command: 'node', healthCheck: { enabled: true } }
    });
    const router = { dispatch: vi.fn(async () => ({ ok: true })) };
    const logger = pino({ level: 'silent' });
    const hc = new HealthChecker(router, registry, logger);
    hc.startAll();
    // default is 60s; advance enough to trigger once
    await vi.advanceTimersByTimeAsync(60_100);
    expect(router.dispatch).toHaveBeenCalledTimes(1);
    hc.stopAll();
  });
});

