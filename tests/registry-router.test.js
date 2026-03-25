import { describe, it, expect } from 'vitest';
import { Registry, ServerNotFoundError } from '../registry/registry.js';
import { Router, ServerNotRunningError } from '../router/router.js';

describe('Registry', () => {
  it('load/register/names/entries work', () => {
    const r = new Registry();
    r.register('a', { command: 'node' });
    expect(r.get('a')).toMatchObject({ command: 'node' });
    expect(r.names()).toEqual(['a']);

    r.load({ b: { command: 'python' } });
    expect(r.get('a')).toBeUndefined();
    expect(r.getRequired('b')).toMatchObject({ command: 'python' });
    expect([...r.entries()]).toEqual([['b', { command: 'python' }]]);
  });

  it('getRequired throws ServerNotFoundError', () => {
    const r = new Registry();
    expect(() => r.getRequired('x')).toThrow(ServerNotFoundError);
  });
});

describe('Router', () => {
  it('dispatch throws when wrapper missing or not running', async () => {
    const registry = new Registry({ a: { command: 'node' } });
    const pm = {
      getWrapper() {
        return undefined;
      }
    };
    const router = new Router(registry, pm);
    await expect(router.dispatch('a', { jsonrpc: '2.0' })).rejects.toThrow(ServerNotRunningError);
  });

  it('subscribeSSE returns unsubscribe that detaches listener', () => {
    const registry = new Registry({ a: { command: 'node' } });
    const listeners = new Set();
    const wrapper = {
      isRunning() {
        return true;
      },
      on(_evt, fn) {
        listeners.add(fn);
      },
      off(_evt, fn) {
        listeners.delete(fn);
      }
    };
    const pm = {
      getWrapper() {
        return wrapper;
      }
    };
    const router = new Router(registry, pm);
    const fn = () => {};
    const unsub = router.subscribeSSE('a', fn);
    expect(listeners.has(fn)).toBe(true);
    unsub();
    expect(listeners.has(fn)).toBe(false);
  });

  it('subscribeSSE throws when wrapper missing or stopped', () => {
    const registry = new Registry({ a: { command: 'node' } });
    const pmMissing = { getWrapper: () => undefined };
    const pmStopped = { getWrapper: () => ({ isRunning: () => false, on() {}, off() {} }) };
    const routerMissing = new Router(registry, pmMissing);
    const routerStopped = new Router(registry, pmStopped);
    expect(() => routerMissing.subscribeSSE('a', () => {})).toThrow(ServerNotRunningError);
    expect(() => routerStopped.subscribeSSE('a', () => {})).toThrow(ServerNotRunningError);
  });
});

