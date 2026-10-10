import crypto from 'node:crypto';

const DEFAULT_SESSION_TTL_MS = 120_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_WAIT_MS = 25_000;

function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nowMs(nowFn) {
  return typeof nowFn === 'function' ? nowFn() : Date.now();
}

function createId(idFactory) {
  return typeof idFactory === 'function' ? idFactory() : crypto.randomUUID();
}

function removeFromArray(items, target) {
  const index = items.indexOf(target);
  if (index >= 0) items.splice(index, 1);
}

export class FigmaWriteBridgeServiceCore {
  constructor(options = {}) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.defaultPollWaitMs = options.defaultPollWaitMs ?? DEFAULT_POLL_WAIT_MS;
    this.sessions = new Map();
    this.commands = new Map();
    this.closed = false;
  }

  registerSession(payload = {}) {
    this.#assertOpen();
    this.#cleanStaleSessions();

    const sessionId = createId(this.createId);
    const timestamp = nowMs(this.now);
    const session = {
      id: sessionId,
      fileKey: asTrimmedString(payload.fileKey),
      documentName: asTrimmedString(payload.documentName),
      currentPageId: asTrimmedString(payload.currentPageId),
      currentPageName: asTrimmedString(payload.currentPageName),
      pluginId: asTrimmedString(payload.pluginId),
      selectionCount: Number.isFinite(payload.selectionCount) ? payload.selectionCount : 0,
      createdAt: timestamp,
      lastSeenAt: timestamp,
      pendingCommands: [],
      waiters: []
    };

    this.sessions.set(sessionId, session);
    return this.#serializeSession(session);
  }

  touchSession(sessionId, payload = {}) {
    const session = this.#requireSession(sessionId);
    session.lastSeenAt = nowMs(this.now);
    if ('fileKey' in payload) session.fileKey = asTrimmedString(payload.fileKey) || session.fileKey;
    if ('documentName' in payload) session.documentName = asTrimmedString(payload.documentName) || session.documentName;
    if ('currentPageId' in payload) session.currentPageId = asTrimmedString(payload.currentPageId) || session.currentPageId;
    if ('currentPageName' in payload) session.currentPageName = asTrimmedString(payload.currentPageName) || session.currentPageName;
    if ('pluginId' in payload) session.pluginId = asTrimmedString(payload.pluginId) || session.pluginId;
    if (Number.isFinite(payload.selectionCount)) session.selectionCount = payload.selectionCount;
    return this.#serializeSession(session);
  }

  listSessions() {
    this.#cleanStaleSessions();
    return Array.from(this.sessions.values())
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
      .map((session) => this.#serializeSession(session));
  }

  async nextCommand(sessionId, { waitMs } = {}) {
    this.#assertOpen();
    const session = this.#requireSession(sessionId);
    session.lastSeenAt = nowMs(this.now);

    const command = session.pendingCommands.shift();
    if (command) {
      return {
        status: 'ok',
        command: this.#serializeCommand(command)
      };
    }

    const effectiveWaitMs = Number.isFinite(waitMs) && waitMs > 0 ? waitMs : this.defaultPollWaitMs;
    return new Promise((resolve) => {
      const waiter = {
        resolve,
        timeout: setTimeout(() => {
          removeFromArray(session.waiters, waiter);
          resolve({ status: 'idle' });
        }, effectiveWaitMs)
      };

      session.waiters.push(waiter);
    });
  }

  async dispatchCommand(type, payload = {}) {
    this.#assertOpen();
    this.#cleanStaleSessions();

    const fileKey = asTrimmedString(payload.fileKey);
    const session = this.#resolveSessionForFile(fileKey);
    const commandId = createId(this.createId);
    const timestamp = nowMs(this.now);
    const command = {
      id: commandId,
      type,
      payload,
      fileKey,
      sessionId: session.id,
      createdAt: timestamp
    };

    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.commands.delete(commandId);
        reject(new Error(`Command ${commandId} timed out waiting for plugin response.`));
      }, this.commandTimeoutMs);

      this.commands.set(commandId, {
        command,
        resolve,
        reject,
        timeout
      });
    });

    session.pendingCommands.push(command);
    session.lastSeenAt = timestamp;
    this.#flushWaiters(session);
    return promise;
  }

  completeCommand(sessionId, commandId, payload = {}) {
    const session = this.#requireSession(sessionId);
    session.lastSeenAt = nowMs(this.now);

    const entry = this.commands.get(commandId);
    if (!entry) {
      throw new Error(`Unknown command id: ${commandId}`);
    }

    if (entry.command.sessionId !== sessionId) {
      throw new Error(`Command ${commandId} does not belong to session ${sessionId}.`);
    }

    clearTimeout(entry.timeout);
    this.commands.delete(commandId);
    entry.resolve(payload);
    return {
      status: 'ok',
      commandId
    };
  }

  close(reason = 'bridge_closed') {
    if (this.closed) return;
    this.closed = true;

    for (const session of this.sessions.values()) {
      this.#destroySession(session.id, reason);
    }
  }

  #assertOpen() {
    if (this.closed) {
      throw new Error('Bridge service is closed.');
    }
  }

  #requireSession(sessionId) {
    this.#cleanStaleSessions();
    const session = this.sessions.get(asTrimmedString(sessionId));
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    return session;
  }

  #resolveSessionForFile(fileKey) {
    if (!fileKey) {
      throw new Error('fileKey must be a non-empty string.');
    }

    const candidates = Array.from(this.sessions.values())
      .filter((session) => session.fileKey === fileKey)
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt);

    if (candidates.length === 0) {
      throw new Error(`No active Figma write plugin session for fileKey "${fileKey}".`);
    }

    return candidates[0];
  }

  #flushWaiters(session) {
    while (session.waiters.length > 0 && session.pendingCommands.length > 0) {
      const waiter = session.waiters.shift();
      clearTimeout(waiter.timeout);
      waiter.resolve({
        status: 'ok',
        command: this.#serializeCommand(session.pendingCommands.shift())
      });
    }
  }

  #cleanStaleSessions() {
    const timestamp = nowMs(this.now);

    for (const session of this.sessions.values()) {
      if (timestamp - session.lastSeenAt > this.sessionTtlMs) {
        this.#destroySession(session.id, 'session_stale');
      }
    }
  }

  #destroySession(sessionId, reason) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    while (session.waiters.length > 0) {
      const waiter = session.waiters.shift();
      clearTimeout(waiter.timeout);
      waiter.resolve({
        status: 'idle',
        reason
      });
    }

    for (const [commandId, entry] of this.commands.entries()) {
      if (entry.command.sessionId !== sessionId) continue;
      clearTimeout(entry.timeout);
      this.commands.delete(commandId);
      entry.reject(new Error(`Plugin session ended before command ${commandId} completed (${reason}).`));
    }

    this.sessions.delete(sessionId);
  }

  #serializeSession(session) {
    return {
      id: session.id,
      fileKey: session.fileKey,
      documentName: session.documentName,
      currentPageId: session.currentPageId,
      currentPageName: session.currentPageName,
      pluginId: session.pluginId,
      selectionCount: session.selectionCount,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt
    };
  }

  #serializeCommand(command) {
    return {
      id: command.id,
      type: command.type,
      payload: command.payload,
      fileKey: command.fileKey,
      createdAt: command.createdAt
    };
  }
}

