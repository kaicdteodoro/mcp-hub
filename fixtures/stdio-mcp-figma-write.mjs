#!/usr/bin/env node
import readline from 'node:readline';
import {
  buildBatchApplyMissingBridgeResult,
  buildDryRunResult,
  normalizeFindNodesArgs,
  normalizePlan,
  toolDefinitions
} from './figma-write-contract.mjs';
import { loadBridge } from './figma-write-bridge.mjs';

function writeResponse(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function writeError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function writeToolResult(id, payload) {
  writeResponse(id, {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2)
      }
    ]
  });
}

async function handleFindNodes(id, args = {}) {
  const normalized = normalizeFindNodesArgs(args);
  if (!normalized.ok) {
    writeToolResult(id, {
      status: 'invalid',
      errors: normalized.errors
    });
    return;
  }

  const bridge = await loadBridge();
  const bridgeResult = bridge.findNodes
    ? await bridge.findNodes(normalized.value)
    : {
        status: 'bridge_missing',
        matches: [],
        nextStep: 'Bridge does not expose findNodes.'
      };

  writeToolResult(id, {
    status: bridgeResult.status ?? 'ok',
    bridge: {
      name: bridge.name,
      configured: bridge.configured
    },
    query: normalized.value,
    result: bridgeResult
  });
}

async function handleDryRun(id, args = {}) {
  const planResult = normalizePlan(args, { modeDefault: 'safe_write' });
  const bridge = await loadBridge();

  if (!planResult.ok) {
    writeToolResult(id, buildDryRunResult(planResult, bridge.error ? { bridgeLoadError: bridge.error } : null, bridge));
    return;
  }

  const bridgeResult = bridge.dryRun ? await bridge.dryRun(planResult.value) : null;
  writeToolResult(id, buildDryRunResult(planResult, bridgeResult, bridge));
}

async function handleBatchApply(id, args = {}) {
  const planResult = normalizePlan(args, { modeDefault: 'safe_write' });
  const bridge = await loadBridge();

  if (!planResult.ok) {
    writeToolResult(id, buildBatchApplyMissingBridgeResult(planResult, bridge));
    return;
  }

  if (!bridge.configured || !bridge.batchApply) {
    writeToolResult(id, buildBatchApplyMissingBridgeResult(planResult, bridge));
    return;
  }

  const bridgeResult = await bridge.batchApply(planResult.value);
  writeToolResult(id, {
    status: bridgeResult.status ?? 'applied',
    bridge: {
      name: bridge.name,
      configured: bridge.configured
    },
    summary: {
      requestedOperations: planResult.value.operations.length,
      appliedOperations: bridgeResult.appliedOperations ?? planResult.value.operations.length
    },
    result: bridgeResult
  });
}

async function handleSingleOperation(id, toolName, args = {}) {
  const operation =
    toolName === 'rename_node'
      ? { type: 'rename_node', nodeId: args.nodeId, newName: args.newName }
      : { type: 'set_text', nodeId: args.nodeId, text: args.text };

  const payload = {
    fileKey: args.fileKey,
    operations: [operation]
  };

  if (args.dryRun === true) {
    await handleDryRun(id, payload);
    return;
  }

  await handleBatchApply(id, {
    ...payload,
    mode: 'safe_write'
  });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;

  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    continue;
  }

  const id = req.id;
  if (id === undefined) continue;

  if (req.method === 'tools/list') {
    writeResponse(id, { tools: toolDefinitions });
    continue;
  }

  if (req.method === 'tools/call') {
    const toolName = req.params?.name;
    const tool = toolDefinitions.find((item) => item.name === toolName);

    if (!tool) {
      writeError(id, -32601, `Unknown tool: ${toolName}`);
      continue;
    }

    const args = req.params?.arguments ?? {};

    try {
      if (toolName === 'find_nodes') {
        await handleFindNodes(id, args);
        continue;
      }

      if (toolName === 'dry_run') {
        await handleDryRun(id, args);
        continue;
      }

      if (toolName === 'batch_apply') {
        await handleBatchApply(id, args);
        continue;
      }

      if (toolName === 'rename_node' || toolName === 'set_text') {
        await handleSingleOperation(id, toolName, args);
        continue;
      }
    } catch (error) {
      writeToolResult(id, {
        status: 'error',
        tool: toolName,
        message: error.message
      });
      continue;
    }

    continue;
  }

  writeError(id, -32601, `Unknown method: ${req.method}`);
}
