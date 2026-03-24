import fs from 'node:fs';
import path from 'node:path';

const ENV_PLACEHOLDER = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * @param {unknown} value
 * @param {string} context
 * @param {{ optionalServers?: Set<string> }} [opts]
 * @returns {unknown}
 */
function resolvePlaceholders(value, context, opts = {}) {
  if (typeof value === 'string') {
    const m = value.match(ENV_PLACEHOLDER);
    if (m) {
      const name = m[1];
      if (process.env[name] === undefined) {
        // Allow missing env vars for servers explicitly disabled from auto-start.
        // This keeps `loadHubConfig()` usable in CI/dev without secrets.
        const envCtx = /^config\.servers\.([A-Za-z0-9_-]+)\.env\./.exec(context);
        const serverName = envCtx?.[1];
        if (serverName && opts.optionalServers?.has(serverName)) {
          return '';
        }
        throw new Error(`Missing required environment variable "${name}" (${context})`);
      }
      return process.env[name];
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => resolvePlaceholders(v, `${context}[${i}]`, opts));
  }
  if (value !== null && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolvePlaceholders(v, `${context}.${k}`, opts);
    }
    return out;
  }
  return value;
}

/**
 * @typedef {object} HubServerDefinition
 * @property {string} command
 * @property {string[]} [args]
 * @property {Record<string, string>} [env]
 * @property {boolean} [autoStart]
 * @property {number} [restartDelay]
 * @property {number} [maxRestarts]
 * @property {{ enabled?: boolean, intervalMs?: number, timeoutMs?: number }} [healthCheck]
 */

/**
 * @typedef {object} HubConfigFile
 * @property {{ port?: number, host?: string, logLevel?: string, requestTimeoutMs?: number, ssePingIntervalMs?: number }} [hub]
 * @property {Record<string, HubServerDefinition>} servers
 */

/**
 * @param {string} [configPath]
 * @returns {Promise<HubConfigFile>}
 */
export async function loadHubConfig(configPath) {
  const resolved =
    configPath ??
    process.env.MCP_HUB_CONFIG_PATH ??
    path.join(process.cwd(), 'mcp-hub.config.json');

  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }

  const raw = fs.readFileSync(resolved, 'utf8');
  /** @type {HubConfigFile} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${resolved}: ${/** @type {Error} */ (e).message}`);
  }

  const optionalServers = new Set();
  for (const [name, def] of Object.entries((parsed && parsed.servers) || {})) {
    if (def && typeof def === 'object' && def.autoStart === false) {
      optionalServers.add(name);
    }
  }

  const withEnv = /** @type {HubConfigFile} */ (
    resolvePlaceholders(parsed, 'config', { optionalServers })
  );

  if (!withEnv.servers || typeof withEnv.servers !== 'object') {
    throw new Error('config.servers must be an object');
  }

  for (const [name, def] of Object.entries(withEnv.servers)) {
    if (!def || typeof def !== 'object') {
      throw new Error(`servers.${name} must be an object`);
    }
    if (typeof def.command !== 'string' || def.command.length === 0) {
      throw new Error(`servers.${name}.command is required`);
    }
  }

  return withEnv;
}
