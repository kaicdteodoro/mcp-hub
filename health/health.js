import { randomUUID } from 'node:crypto';

/**
 * @typedef {import('../router/router.js').Router} Router
 * @typedef {import('../registry/registry.js').Registry} Registry
 * @typedef {import('../config/load-config.js').HubServerDefinition} HubServerDefinition
 * @typedef {import('pino').Logger} Logger
 */

export class HealthChecker {
  /** @type {Router} */
  #router;
  /** @type {Registry} */
  #registry;
  /** @type {Logger} */
  #logger;
  /** @type {Map<string, NodeJS.Timeout>} */
  #timers = new Map();

  /**
   * @param {Router} router
   * @param {Registry} registry
   * @param {Logger} logger
   */
  constructor(router, registry, logger) {
    this.#router = router;
    this.#registry = registry;
    this.#logger = logger.child({ module: 'health' });
  }

  /**
   * @param {string} name
   * @param {HubServerDefinition} def
   */
  registerServer(name, def) {
    this.#clearTimer(name);
    const hc = def.healthCheck;
    if (!hc?.enabled) {
      return;
    }
    const interval = hc.intervalMs ?? 60_000;
    const timeoutMs = hc.timeoutMs ?? 30_000;

    const t = setInterval(() => {
      void this.#runCheck(name, timeoutMs);
    }, interval);
    this.#timers.set(name, t);
  }

  /**
   * @param {string} name
   */
  #clearTimer(name) {
    const t = this.#timers.get(name);
    if (t) {
      clearInterval(t);
      this.#timers.delete(name);
    }
  }

  /**
   * @param {string} name
   * @param {number} timeoutMs
   */
  async #runCheck(name, timeoutMs) {
    const start = Date.now();
    try {
      const payload = {
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'tools/list',
        params: {}
      };
      const p = this.#router.dispatch(name, payload);
      await Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error('health check timeout')), timeoutMs))
      ]);
      const ms = Date.now() - start;
      this.#logger.info({ server: name, latencyMs: ms, ok: true }, 'health check');
    } catch (e) {
      this.#logger.warn({ server: name, err: String(e) }, 'health check failed');
    }
  }

  startAll() {
    for (const [name, def] of this.#registry.entries()) {
      this.registerServer(name, def);
    }
  }

  stopAll() {
    for (const name of this.#timers.keys()) {
      this.#clearTimer(name);
    }
  }
}
