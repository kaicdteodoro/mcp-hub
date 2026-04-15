export const toolDefinitions = [
  {
    name: 'find_nodes',
    description: 'Locate Figma nodes by name, type, or page through a write-capable bridge',
    inputSchema: {
      type: 'object',
      properties: {
        fileKey: { type: 'string' },
        query: { type: 'string' },
        page: { type: 'string' },
        nodeType: { type: 'string' }
      },
      required: ['fileKey', 'query'],
      additionalProperties: false
    }
  },
  {
    name: 'rename_node',
    description: 'Rename a Figma node safely',
    inputSchema: {
      type: 'object',
      properties: {
        fileKey: { type: 'string' },
        nodeId: { type: 'string' },
        newName: { type: 'string' },
        dryRun: { type: 'boolean' }
      },
      required: ['fileKey', 'nodeId', 'newName'],
      additionalProperties: false
    }
  },
  {
    name: 'set_text',
    description: 'Update text content on a Figma text node safely',
    inputSchema: {
      type: 'object',
      properties: {
        fileKey: { type: 'string' },
        nodeId: { type: 'string' },
        text: { type: 'string' },
        dryRun: { type: 'boolean' }
      },
      required: ['fileKey', 'nodeId', 'text'],
      additionalProperties: false
    }
  },
  {
    name: 'dry_run',
    description: 'Validate a batch of planned Figma write operations without applying them',
    inputSchema: {
      type: 'object',
      properties: {
        fileKey: { type: 'string' },
        operations: {
          type: 'array',
          items: { type: 'object' }
        }
      },
      required: ['fileKey', 'operations'],
      additionalProperties: false
    }
  },
  {
    name: 'batch_apply',
    description: 'Apply a validated batch of Figma write operations through a configured bridge',
    inputSchema: {
      type: 'object',
      properties: {
        fileKey: { type: 'string' },
        operations: {
          type: 'array',
          items: { type: 'object' }
        },
        mode: {
          type: 'string',
          enum: ['safe_write', 'full_write']
        }
      },
      required: ['fileKey', 'operations'],
      additionalProperties: false
    }
  }
];

const planOperationTypes = new Set(['rename_node', 'set_text']);
const writeModes = new Set(['safe_write', 'full_write']);

function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pushError(errors, code, message, meta = {}) {
  errors.push({ code, message, ...meta });
}

function pushWarning(warnings, code, message, meta = {}) {
  warnings.push({ code, message, ...meta });
}

export function normalizeFindNodesArgs(args = {}) {
  const fileKey = asTrimmedString(args.fileKey);
  const query = asTrimmedString(args.query);
  const page = asTrimmedString(args.page);
  const nodeType = asTrimmedString(args.nodeType);
  const errors = [];

  if (!fileKey) pushError(errors, 'invalid_file_key', 'fileKey must be a non-empty string.');
  if (!query) pushError(errors, 'invalid_query', 'query must be a non-empty string.');

  return {
    ok: errors.length === 0,
    errors,
    value: {
      fileKey,
      query,
      ...(page ? { page } : {}),
      ...(nodeType ? { nodeType } : {})
    }
  };
}

export function normalizeOperation(input, index = 0) {
  const type = asTrimmedString(input?.type);
  const nodeId = asTrimmedString(input?.nodeId);
  const errors = [];
  const warnings = [];

  if (!planOperationTypes.has(type)) {
    pushError(errors, 'unsupported_operation', `Unsupported operation type "${type || '(empty)'}".`, {
      index
    });
    return { ok: false, errors, warnings };
  }

  if (!nodeId) {
    pushError(errors, 'invalid_node_id', 'nodeId must be a non-empty string.', { index, type });
  }

  if (type === 'rename_node') {
    const newName = asTrimmedString(input?.newName);
    if (!newName) {
      pushError(errors, 'invalid_new_name', 'newName must be a non-empty string.', { index, type, nodeId });
    } else if (newName.length > 512) {
      pushError(errors, 'new_name_too_long', 'newName exceeds 512 characters.', { index, type, nodeId });
    }

    return {
      ok: errors.length === 0,
      errors,
      warnings,
      value: {
        type,
        nodeId,
        newName
      }
    };
  }

  const text = typeof input?.text === 'string' ? input.text : '';
  if (!text.trim()) {
    pushError(errors, 'invalid_text', 'text must be a non-empty string.', { index, type, nodeId });
  }
  if (text.length > 5000) {
    pushWarning(warnings, 'text_large_payload', 'text is larger than 5000 characters.', {
      index,
      type,
      nodeId
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    value: {
      type,
      nodeId,
      text
    }
  };
}

export function normalizePlan(args = {}, { modeDefault = 'safe_write' } = {}) {
  const fileKey = asTrimmedString(args.fileKey);
  const mode = asTrimmedString(args.mode) || modeDefault;
  const rawOperations = Array.isArray(args.operations) ? args.operations : [];
  const errors = [];
  const warnings = [];
  const operations = [];
  const duplicateNodeOps = new Map();
  const renameTargets = new Map();

  if (!fileKey) pushError(errors, 'invalid_file_key', 'fileKey must be a non-empty string.');
  if (!Array.isArray(args.operations)) {
    pushError(errors, 'invalid_operations', 'operations must be an array.');
  } else if (rawOperations.length === 0) {
    pushError(errors, 'empty_operations', 'operations must contain at least one operation.');
  }

  if (!writeModes.has(mode)) {
    pushError(errors, 'invalid_mode', `mode must be one of: ${Array.from(writeModes).join(', ')}.`);
  }

  rawOperations.forEach((item, index) => {
    const normalized = normalizeOperation(item, index);
    errors.push(...normalized.errors);
    warnings.push(...normalized.warnings);

    if (!normalized.ok) return;

    const value = normalized.value;
    operations.push({
      index,
      ...value
    });

    const nodeOps = duplicateNodeOps.get(value.nodeId) ?? [];
    nodeOps.push(value.type);
    duplicateNodeOps.set(value.nodeId, nodeOps);

    if (value.type === 'rename_node') {
      const target = value.newName.toLowerCase();
      const targets = renameTargets.get(target) ?? [];
      targets.push(value.nodeId);
      renameTargets.set(target, targets);
    }
  });

  for (const [nodeId, nodeOps] of duplicateNodeOps.entries()) {
    if (nodeOps.length > 1) {
      pushWarning(
        warnings,
        'multiple_operations_same_node',
        `Multiple operations target node "${nodeId}" in the same batch.`,
        { nodeId, operations: nodeOps }
      );
    }
  }

  for (const [targetName, nodeIds] of renameTargets.entries()) {
    if (nodeIds.length > 1) {
      pushWarning(
        warnings,
        'duplicate_rename_target',
        `Multiple rename operations converge on the same target name "${targetName}".`,
        { targetName, nodeIds }
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    value: {
      fileKey,
      mode,
      operations
    }
  };
}

export function summarizePlan(planResult) {
  const operations = planResult?.value?.operations ?? [];
  const byType = operations.reduce((acc, operation) => {
    acc[operation.type] = (acc[operation.type] ?? 0) + 1;
    return acc;
  }, {});

  return {
    totalOperations: operations.length,
    byType,
    warningsCount: planResult?.warnings?.length ?? 0,
    errorsCount: planResult?.errors?.length ?? 0
  };
}

export function buildDryRunResult(planResult, bridgeResult = null, bridgeInfo = {}) {
  const summary = summarizePlan(planResult);
  const bridgeConfigured = Boolean(bridgeInfo.configured);

  return {
    status: planResult.ok ? 'validated' : 'invalid',
    bridgeConfigured,
    bridge: {
      name: bridgeInfo.name ?? 'stub',
      configured: bridgeConfigured
    },
    summary,
    errors: planResult.errors,
    warnings: planResult.warnings,
    operations: (planResult.value?.operations ?? []).map((operation) => ({
      index: operation.index,
      type: operation.type,
      nodeId: operation.nodeId,
      status: 'validated',
      ...(operation.newName ? { newName: operation.newName } : {}),
      ...(Object.prototype.hasOwnProperty.call(operation, 'text')
        ? { textPreview: operation.text.slice(0, 80) }
        : {})
    })),
    ...(bridgeResult ? { bridgeResult } : {}),
    nextStep: bridgeConfigured
      ? 'Batch is structurally valid. You can call batch_apply once the bridge dry-run checks are acceptable.'
      : 'Attach FIGMA_WRITE_BRIDGE_MODULE to enable real dry-run checks against a write-capable Figma bridge.'
  };
}

export function buildBatchApplyMissingBridgeResult(planResult, bridgeInfo = {}) {
  return {
    status: 'bridge_missing',
    bridgeConfigured: false,
    bridge: {
      name: bridgeInfo.name ?? 'stub',
      configured: false
    },
    summary: summarizePlan(planResult),
    errors: planResult.errors,
    warnings: planResult.warnings,
    nextStep: 'Configure FIGMA_WRITE_BRIDGE_MODULE with a write-capable bridge before calling batch_apply.'
  };
}

