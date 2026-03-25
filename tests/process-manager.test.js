import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { Registry } from '../registry/registry.js';

// Mock wrapper to control exit/restart behavior deterministically.
vi.mock('../process-manager/wrapper.js', () => {
  class FakeWrapper {
    constructor(name, def) {
      this.name = name;
      this.def = def;
      this.running = false;
      this.timeoutMs = undefined;
      /** @type {Map<string, Set<Function>>} */
      this.listeners = new Map();
    }
    on(evt, fn) {
      const set = this.listeners.get(evt) ?? new Set();
      set.add(fn);
      this.listeners.set(evt, set);
    }
    off(evt, fn) {
      const set = this.listeners.get(evt);
      if (set) set.delete(fn);
    }
    emit(evt, payload) {
      const set = this.listeners.get(evt);
      if (!set) return;
      for (const fn of set) fn(payload);
    }
    setRequestTimeoutMs(ms) {
      this.timeoutMs = ms;
    }
    isRunning() {
      return this.running;
    }
    async start() {
      this.running = true;
    }
    async stop() {
      this.running = false;
    }
    crash() {
      this.running = false;
      this.emit('exit', { code: 1, signal: null, intentional: false });
    }
    intentionalExit() {
      this.running = false;
      this.emit('exit', { code: 0, signal: null, intentional: true });
    }
  }
  return { MCPServerWrapper: FakeWrapper };
});

/** @type {import('../process-manager/process-manager.js').ProcessManager} */
let ProcessManager;

beforeAll(async () => {
  ({ ProcessManager } = await import('../process-manager/process-manager.js'));
});

describe('ProcessManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('startAll respects autoStart and stopAll clears wrappers', async () => {
    const registry = new Registry({
      a: { command: 'node', autoStart: true },
      b: { command: 'node', autoStart: false }
    });
    const logger = pino({ level: 'silent' });
    const pm = new ProcessManager(registry, logger, { requestTimeoutMs: 123 });
    await pm.startAll();
    expect(pm.getWrapper('a')?.isRunning()).toBe(true);
    expect(pm.getWrapper('b')).toBeUndefined();
    await pm.stopAll();
    expect(pm.getWrapper('a')).toBeUndefined();
  });

  it('restarts on crash up to maxRestarts', async () => {
    const registry = new Registry({
      a: { command: 'node', autoStart: true, restartDelay: 10, maxRestarts: 1 }
    });
    const logger = pino({ level: 'silent' });
    const pm = new ProcessManager(registry, logger);
    await pm.start('a');
    const w = pm.getWrapper('a');
    expect(w?.isRunning()).toBe(true);
    w.crash();
    await vi.advanceTimersByTimeAsync(20);
    expect(pm.getWrapper('a')?.isRunning()).toBe(true);
    // crash again - should not restart (maxRestarts reached)
    pm.getWrapper('a').crash();
    await vi.advanceTimersByTimeAsync(20);
    expect(pm.getWrapper('a')?.isRunning()).toBe(false);
  });

  it('stop cancels pending restart timer', async () => {
    const registry = new Registry({
      a: { command: 'node', autoStart: true, restartDelay: 100, maxRestarts: 5 }
    });
    const logger = pino({ level: 'silent' });
    const pm = new ProcessManager(registry, logger);
    await pm.start('a');
    pm.getWrapper('a').crash();
    await pm.stop('a');
    await vi.advanceTimersByTimeAsync(200);
    // Should not have restarted because stop cleared timer.
    expect(pm.getWrapper('a')?.isRunning()).toBe(false);
  });

  it('ensureWrapperRegistered creates wrapper without starting', async () => {
    const registry = new Registry({
      a: { command: 'node', autoStart: false }
    });
    const logger = pino({ level: 'silent' });
    const pm = new ProcessManager(registry, logger);
    pm.ensureWrapperRegistered('a');
    expect(pm.getWrapper('a')).toBeDefined();
    expect(pm.getWrapper('a').isRunning()).toBe(false);
  });

  it('handles restart failure path without throwing', async () => {
    const registry = new Registry({
      a: { command: 'node', autoStart: true, restartDelay: 10, maxRestarts: 2 }
    });
    const logger = pino({ level: 'silent' });
    const pm = new ProcessManager(registry, logger);
    await pm.start('a');
    const w = pm.getWrapper('a');
    // Monkeypatch start to fail on restart attempt.
    w.start = async () => {
      throw new Error('restart failed');
    };
    w.crash();
    await vi.advanceTimersByTimeAsync(20);
    // no throw expected, wrapper stays not running
    expect(pm.getWrapper('a').isRunning()).toBe(false);
  });
});

