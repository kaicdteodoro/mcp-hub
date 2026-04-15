const DEFAULT_TIMEOUT_MS = 10_000;

function getRequiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getOptionalEnv(name) {
  const value = process.env[name]?.trim();
  return value || '';
}

function getTimeoutMs() {
  const raw = getOptionalEnv('FIGMA_WRITE_BRIDGE_TIMEOUT_MS');
  if (!raw) return DEFAULT_TIMEOUT_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('FIGMA_WRITE_BRIDGE_TIMEOUT_MS must be a positive number.');
  }
  return parsed;
}

function joinUrl(base, path) {
  return `${base.replace(/\/+$/, '')}${path}`;
}

async function callBridge(path, payload) {
  const baseUrl = getRequiredEnv('FIGMA_WRITE_BRIDGE_URL');
  const authToken = getOptionalEnv('FIGMA_WRITE_BRIDGE_TOKEN');
  const timeoutMs = getTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(joinUrl(baseUrl, path), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authToken ? { authorization: `Bearer ${authToken}` } : {})
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error(`Bridge returned non-JSON response with status ${response.status}.`);
      }
    }

    if (!response.ok) {
      const message = body?.error ?? body?.message ?? `Bridge request failed with status ${response.status}.`;
      throw new Error(message);
    }

    return body ?? {};
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  name: 'http-figma-write-bridge',
  configured: true,
  async findNodes({ fileKey, query, page, nodeType }) {
    return callBridge('/find-nodes', {
      fileKey,
      query,
      ...(page ? { page } : {}),
      ...(nodeType ? { nodeType } : {})
    });
  },
  async dryRun({ fileKey, mode, operations }) {
    return callBridge('/dry-run', {
      fileKey,
      mode,
      operations
    });
  },
  async batchApply({ fileKey, mode, operations }) {
    return callBridge('/batch-apply', {
      fileKey,
      mode,
      operations
    });
  }
};

