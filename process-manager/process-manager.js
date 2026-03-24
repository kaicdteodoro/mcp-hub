import { MCPServerWrapper } from './wrapper.js';

/**
 * @typedef {import('../registry/registry.js').Registry} Registry
 * @typedef {import('../config/load-config.js').HubServerDefinition} HubServerDefinition
 * @typedef {import('pino').Logger} Logger
 */

export class ProcessManager {
  /** @type {Registry} */
  #registry;
  /** @type {Logger} */
  #logger;
  /** @type {{ requestTimeoutMs?: number }} */
  #opts;
  /** @type {Map<string, MCPServerWrapper>} */
  #wrappers = new Map();
  /** @type {Map<string, number>} */
  #restartCounts = new Map();
  /** @type {Map<string, NodeJS.Timeout | null>} */
  #restartTimers = new Map();

  /**
   * @param {Registry} registry
   * @param {Logger} logger
   * @param {{ requestTimeoutMs?: number }} [opts]
   */
  constructor(registry, logger, opts = {}) {
    this.#registry = registry;
    this.#logger = logger;
    this.#opts = opts;
  }

  /**
   * @param {string} name
   * @returns {MCPServerWrapper}
   */
  #ensureWrapper(name) {
    let w = this.#wrappers.get(name);
    if (!w) {
      const def = this.#registry.getRequired(name);
      w = new MCPServerWrapper(name, def, this.#logger);
      if (typeof this.#opts.requestTimeoutMs === 'number') {
        w.setRequestTimeoutMs(this.#opts.requestTimeoutMs);
      }
      this.#wrappers.set(name, w);
      w.on('exit', (payload) => {
        if (payload && !payload.intentional) {
          this.#onWrapperExit(name);
        }
      });
    }
    return w;
  }

  /**
   * @param {string} name
   */
  #onWrapperExit(name) {
    const def = this.#registry.get(name);
    if (!def) return;

    const max = def.maxRestarts ?? 5;
    const delay = def.restartDelay ?? 2000;
    const count = (this.#restartCounts.get(name) ?? 0) + 1;
    this.#restartCounts.set(name, count);

    if (count > max) {
      this.#logger.warn({ server: name, restarts: count }, 'max restarts reached; not restarting');
      return;
    }

    const t = setTimeout(() => {
      this.#restartTimers.set(name, null);
      this.#logger.info({ server: name, attempt: count }, 'restarting MCP server after crash');
      void this.start(name).catch((err) => {
        this.#logger.error({ server: name, err: String(err) }, 'restart failed');
      });
    }, delay);
    this.#restartTimers.set(name, t);
  }

  /**
   * @param {string} name
   * @returns {MCPServerWrapper | undefined}
   */
  getWrapper(name) {
    return this.#wrappers.get(name);
  }

  /**
   * @param {string} name
   * @returns {Promise<void>}
   */
  async start(name) {
    const w = this.#ensureWrapper(name);
    await w.start();
  }

  /**
   * @param {string} name
   * @returns {Promise<void>}
   */
  async stop(name) {
    const t = this.#restartTimers.get(name);
    if (t) clearTimeout(t);
    this.#restartTimers.set(name, null);

    const w = this.#wrappers.get(name);
    if (w) {
      await w.stop();
    }
  }

  /**
   * @param {string} name
   * @returns {Promise<void>}
   */
  async restart(name) {
    await this.stop(name);
    this.#restartCounts.set(name, 0);
    await this.start(name);
  }

  /**
   * @returns {Promise<void>}
   */
  async startAll() {
    for (const name of this.#registry.names()) {
      const def = this.#registry.get(name);
      if (def?.autoStart) {
        await this.start(name);
      }
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async stopAll() {
    for (const name of this.#wrappers.keys()) {
      const t = this.#restartTimers.get(name);
      if (t) clearTimeout(t);
      this.#restartTimers.set(name, null);
    }
    for (const w of this.#wrappers.values()) {
      await w.stop();
    }
    this.#wrappers.clear();
  }

  /**
   * When a new server is registered at runtime, create wrapper without starting unless requested elsewhere.
   * @param {string} name
   */
  ensureWrapperRegistered(name) {
    this.#ensureWrapper(name);
  }
}
