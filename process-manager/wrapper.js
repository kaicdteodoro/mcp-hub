import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execa } from 'execa';

/**
 * @typedef {import('../config/load-config.js').HubServerDefinition} HubServerDefinition
 * @typedef {import('pino').Logger} Logger
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_BUFFER_CAP = 1024 * 1024;
const DEFAULT_STDERR_MAX_LINES = 200;

/**
 * Build env for child: only keys from definition.env plus a minimal safe baseline.
 * @param {HubServerDefinition} def
 */
function buildChildEnv(def) {
  const base = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    LANG: process.env.LANG ?? 'C.UTF-8',
    NODE_ENV: process.env.NODE_ENV ?? 'production'
  };
  const extra = def.env && typeof def.env === 'object' ? def.env : {};
  return { ...base, ...extra };
}

export class MCPServerWrapper extends EventEmitter {
  /** @type {string} */
  #name;
  /** @type {HubServerDefinition} */
  #def;
  /** @type {Logger} */
  #logger;
  /** @type {import('execa').ResultPromise | null} */
  #child = null;
  /** @type {Map<string, { resolve: (v: unknown) => void, reject: (e: Error) => void, timeoutHandle: NodeJS.Timeout }>} */
  #pending = new Map();
  #lineBuffer = '';
  #maxBuffer = DEFAULT_BUFFER_CAP;
  #timeoutMs = DEFAULT_TIMEOUT_MS;
  #intentionalStop = false;
  /** @type {string[]} */
  #stderrLines = [];
  #stderrMaxLines = DEFAULT_STDERR_MAX_LINES;

  /**
   * @param {string} name
   * @param {HubServerDefinition} definition
   * @param {Logger} logger
   */
  constructor(name, definition, logger) {
    super();
    this.#name = name;
    this.#def = definition;
    this.#logger = logger.child({ server: name });
  }

  get name() {
    return this.#name;
  }

  isRunning() {
    return this.#child !== null && this.#child.pid !== undefined;
  }

  /**
   * @param {number} ms
   */
  setRequestTimeoutMs(ms) {
    this.#timeoutMs = ms;
  }

  /**
   * @param {number} maxLines
   */
  setStderrMaxLines(maxLines) {
    if (Number.isFinite(maxLines) && maxLines > 0) {
      this.#stderrMaxLines = Math.floor(maxLines);
      if (this.#stderrLines.length > this.#stderrMaxLines) {
        this.#stderrLines = this.#stderrLines.slice(-this.#stderrMaxLines);
      }
    }
  }

  /**
   * @param {number} [n]
   * @returns {string[]}
   */
  getRecentStderrLines(n = 100) {
    const count = Math.max(0, Math.min(this.#stderrLines.length, Math.floor(n)));
    return this.#stderrLines.slice(-count);
  }

  /**
   * @param {string} line
   */
  async #writeLine(line) {
    const child = this.#child;
    if (!child?.stdin) {
      throw new Error('MCP process is not running');
    }
    await new Promise((resolve, reject) => {
      const ok = child.stdin.write(line, (err) => {
        if (err) reject(err);
      });
      if (ok) resolve(undefined);
      else child.stdin.once('drain', resolve);
    });
  }

  async start() {
    if (this.#child) {
      return;
    }

    const env = buildChildEnv(this.#def);
    const subprocess = execa(this.#def.command, this.#def.args ?? [], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env,
      reject: false
    });

    this.#child = subprocess;
    this.#lineBuffer = '';
    this.#stderrLines = [];

    subprocess.stdout?.setEncoding('utf8');
    subprocess.stderr?.setEncoding('utf8');

    subprocess.stdout?.on('data', (chunk) => {
      this.#onStdoutChunk(chunk);
    });

    subprocess.stderr?.on('data', (chunk) => {
      this.#logger.info({ stderr: chunk });
      // Store stderr lines for admin troubleshooting.
      const s = String(chunk);
      for (const line of s.split('\n')) {
        if (!line) continue;
        this.#stderrLines.push(line);
        if (this.#stderrLines.length > this.#stderrMaxLines) {
          this.#stderrLines = this.#stderrLines.slice(-this.#stderrMaxLines);
        }
      }
    });

    subprocess.on('exit', (code, signal) => {
      const intentional = this.#intentionalStop;
      this.#intentionalStop = false;
      this.#logger.info({ exit: { code, signal, intentional } });
      this.#child = null;
      this.#failAllPending(new Error(`MCP process exited (code=${code}, signal=${signal})`));
      this.emit('exit', { code, signal, intentional });
    });

    this.#logger.info({ spawn: { command: this.#def.command, args: this.#def.args ?? [] } });
  }

  /**
   * @param {string} chunk
   */
  #onStdoutChunk(chunk) {
    this.#lineBuffer += chunk;
    if (this.#lineBuffer.length > this.#maxBuffer) {
      this.#logger.error('stdout line buffer exceeded cap; stopping server');
      this.#failAllPending(new Error('stdout buffer cap exceeded'));
      void this.stop();
      return;
    }

    let idx;
    while ((idx = this.#lineBuffer.indexOf('\n')) >= 0) {
      const line = this.#lineBuffer.slice(0, idx);
      this.#lineBuffer = this.#lineBuffer.slice(idx + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (e) {
        this.#logger.warn({ parseError: String(/** @type {Error} */ (e)), line: trimmed.slice(0, 500) });
        continue;
      }

      if (parsed && typeof parsed === 'object' && 'id' in parsed && parsed.id !== undefined) {
        const key = String(parsed.id);
        const pending = this.#pending.get(key);
        if (pending) {
          clearTimeout(pending.timeoutHandle);
          this.#pending.delete(key);
          if ('error' in parsed && parsed.error) {
            pending.reject(
              Object.assign(new Error(/** @type {{ message?: string }} */ (parsed.error).message ?? 'JSON-RPC error'), {
                rpcError: parsed.error
              })
            );
          } else {
            pending.resolve(parsed);
          }
        }
      }

      this.emit('message', parsed);
    }
  }

  /**
   * @param {Error} err
   */
  #failAllPending(err) {
    for (const [, p] of this.#pending) {
      clearTimeout(p.timeoutHandle);
      p.reject(err);
    }
    this.#pending.clear();
  }

  /**
   * @param {Record<string, unknown>} message
   * @returns {Promise<unknown>}
   */
  async send(message) {
    if (!this.#child?.stdin) {
      throw new Error('MCP server is not running');
    }

    const id = message.id ?? randomUUID();
    const payload = { ...message, id };

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.#pending.delete(String(id));
        reject(new Error(`Request timeout after ${this.#timeoutMs}ms`));
      }, this.#timeoutMs);

      this.#pending.set(String(id), { resolve, reject, timeoutHandle });

      this.#writeLine(`${JSON.stringify(payload)}\n`).catch((err) => {
        const p = this.#pending.get(String(id));
        if (p) {
          clearTimeout(p.timeoutHandle);
          this.#pending.delete(String(id));
          p.reject(/** @type {Error} */ (err));
        }
      });
    });
  }

  async stop() {
    const child = this.#child;
    if (!child) return;

    this.#intentionalStop = true;
    this.#failAllPending(new Error('Server stopped'));

    try {
      child.kill('SIGTERM');
      await Promise.race([
        child,
        new Promise((_, rej) => setTimeout(() => rej(new Error('graceful stop timeout')), 8000))
      ]).catch(() => {
        child.kill('SIGKILL');
      });
    } catch {
      // ignore
    }

    this.#child = null;
    this.#lineBuffer = '';
  }
}
