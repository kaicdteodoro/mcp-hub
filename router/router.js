/**
 * @typedef {import('../process-manager/process-manager.js').ProcessManager} ProcessManager
 * @typedef {import('../registry/registry.js').Registry} Registry
 */

export class ServerNotRunningError extends Error {
  /** @param {string} name */
  constructor(name) {
    super(`MCP server is not running: ${name}`);
    this.name = 'ServerNotRunningError';
    this.serverName = name;
  }
}

export class Router {
  /** @type {Registry} */
  #registry;
  /** @type {ProcessManager} */
  #processManager;

  /**
   * @param {Registry} registry
   * @param {ProcessManager} processManager
   */
  constructor(registry, processManager) {
    this.#registry = registry;
    this.#processManager = processManager;
  }

  /**
   * @param {string} serverName
   * @param {Record<string, unknown>} jsonRpcPayload
   * @returns {Promise<unknown>}
   */
  async dispatch(serverName, jsonRpcPayload) {
    this.#registry.getRequired(serverName);
    const wrapper = this.#processManager.getWrapper(serverName);
    if (!wrapper || !wrapper.isRunning()) {
      throw new ServerNotRunningError(serverName);
    }
    return wrapper.send(jsonRpcPayload);
  }

  /**
   * @param {string} serverName
   * @param {(msg: unknown) => void} listener
   * @returns {() => void}
   */
  subscribeSSE(serverName, listener) {
    this.#registry.getRequired(serverName);
    const wrapper = this.#processManager.getWrapper(serverName);
    if (!wrapper || !wrapper.isRunning()) {
      throw new ServerNotRunningError(serverName);
    }
    wrapper.on('message', listener);
    return () => {
      wrapper.off('message', listener);
    };
  }
}
