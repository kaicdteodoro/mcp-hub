/**
 * @typedef {import('../config/load-config.js').HubServerDefinition} HubServerDefinition
 */

export class ServerNotFoundError extends Error {
  /** @param {string} name */
  constructor(name) {
    super(`Unknown MCP server: ${name}`);
    this.name = 'ServerNotFoundError';
    this.serverName = name;
  }
}

export class Registry {
  /** @type {Map<string, HubServerDefinition>} */
  #servers = new Map();

  /**
   * @param {Record<string, HubServerDefinition>} [initial]
   */
  constructor(initial = {}) {
    for (const [k, v] of Object.entries(initial)) {
      this.#servers.set(k, v);
    }
  }

  /**
   * @param {Record<string, HubServerDefinition>} servers
   */
  load(servers) {
    this.#servers.clear();
    for (const [k, v] of Object.entries(servers)) {
      this.#servers.set(k, v);
    }
  }

  /**
   * @param {string} name
   * @param {HubServerDefinition} definition
   */
  register(name, definition) {
    this.#servers.set(name, definition);
  }

  /**
   * @param {string} name
   * @returns {HubServerDefinition | undefined}
   */
  get(name) {
    return this.#servers.get(name);
  }

  /**
   * @param {string} name
   * @returns {HubServerDefinition}
   */
  getRequired(name) {
    const d = this.#servers.get(name);
    if (!d) {
      throw new ServerNotFoundError(name);
    }
    return d;
  }

  /**
   * @returns {string[]}
   */
  names() {
    return [...this.#servers.keys()];
  }

  /**
   * @returns {IterableIterator<[string, HubServerDefinition]>}
   */
  entries() {
    return this.#servers.entries();
  }
}
