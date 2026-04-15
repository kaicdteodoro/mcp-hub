import { pathToFileURL } from 'node:url';
import path from 'node:path';

const defaultBridge = {
  name: 'stub',
  configured: false,
  async findNodes({ fileKey, query, page, nodeType }) {
    return {
      status: 'bridge_missing',
      fileKey,
      query,
      ...(page ? { page } : {}),
      ...(nodeType ? { nodeType } : {}),
      matches: [],
      nextStep: 'Configure FIGMA_WRITE_BRIDGE_MODULE with a write-capable bridge to enable real Figma search.'
    };
  },
  async dryRun({ fileKey, operations }) {
    return {
      status: 'bridge_missing',
      fileKey,
      operationsReceived: operations.length,
      nextStep: 'Configure FIGMA_WRITE_BRIDGE_MODULE with a write-capable bridge to validate node mutations.'
    };
  },
  async batchApply({ fileKey, operations, mode }) {
    return {
      status: 'bridge_missing',
      fileKey,
      operationsReceived: operations.length,
      mode,
      nextStep: 'Configure FIGMA_WRITE_BRIDGE_MODULE with a write-capable bridge before attempting writes.'
    };
  }
};

function resolveModuleSpecifier(specifier) {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return specifier;
  }

  const absolutePath = path.resolve(process.cwd(), specifier);
  return pathToFileURL(absolutePath).href;
}

function normalizeBridge(moduleExports = {}) {
  const candidate = moduleExports.default ?? moduleExports;
  return {
    name: candidate.name ?? 'custom',
    configured: candidate.configured !== false,
    findNodes: typeof candidate.findNodes === 'function' ? candidate.findNodes.bind(candidate) : null,
    dryRun: typeof candidate.dryRun === 'function' ? candidate.dryRun.bind(candidate) : null,
    batchApply: typeof candidate.batchApply === 'function' ? candidate.batchApply.bind(candidate) : null
  };
}

let cachedBridgePromise;

export async function loadBridge() {
  if (cachedBridgePromise) return cachedBridgePromise;

  cachedBridgePromise = (async () => {
    const specifier = process.env.FIGMA_WRITE_BRIDGE_MODULE?.trim();
    if (!specifier) return defaultBridge;

    const imported = await import(resolveModuleSpecifier(specifier));
    return normalizeBridge(imported);
  })().catch((error) => {
    cachedBridgePromise = null;
    return {
      ...defaultBridge,
      name: 'bridge-load-error',
      error: {
        message: error.message
      }
    };
  });

  return cachedBridgePromise;
}

