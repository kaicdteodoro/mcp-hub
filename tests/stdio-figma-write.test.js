import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { MCPServerWrapper } from '../process-manager/wrapper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(__dirname, '..', 'fixtures', 'stdio-mcp-figma-write.mjs');
const bridgeFixture = path.join(__dirname, 'fixtures', 'figma-write-test-bridge.mjs');

const logger = pino({ level: 'silent' });

function parseToolText(response) {
  return JSON.parse(response.result.content[0].text);
}

describe('stdio figma write MCP', () => {
  const wrapper = new MCPServerWrapper(
    'figma-write',
    {
      command: 'node',
      args: [fixture],
      env: {
        FIGMA_WRITE_BRIDGE_MODULE: bridgeFixture
      }
    },
    logger
  );

  beforeAll(async () => {
    await wrapper.start();
  });

  afterAll(async () => {
    await wrapper.stop();
  });

  it('lists figma write tools with dry_run mode schema', async () => {
    const response = await wrapper.send({ jsonrpc: '2.0', method: 'tools/list', id: 1 });
    const tools = response.result.tools;

    expect(tools.map((tool) => tool.name)).toEqual([
      'find_nodes',
      'rename_node',
      'set_text',
      'dry_run',
      'batch_apply'
    ]);

    const dryRunTool = tools.find((tool) => tool.name === 'dry_run');
    expect(dryRunTool.inputSchema.properties.mode).toBeDefined();
  });

  it('runs dry_run through the configured bridge', async () => {
    const response = await wrapper.send({
      jsonrpc: '2.0',
      method: 'tools/call',
      id: 2,
      params: {
        name: 'dry_run',
        arguments: {
          fileKey: 'abc123',
          mode: 'safe_write',
          operations: [{ type: 'rename_node', nodeId: '3:240', newName: 'PB_KEY:home.hero.title' }]
        }
      }
    });

    const payload = parseToolText(response);
    expect(payload.status).toBe('validated');
    expect(payload.bridge.configured).toBe(true);
    expect(payload.bridgeResult.status).toBe('ok');
  });

  it('supports single-operation dry run via rename_node', async () => {
    const response = await wrapper.send({
      jsonrpc: '2.0',
      method: 'tools/call',
      id: 3,
      params: {
        name: 'rename_node',
        arguments: {
          fileKey: 'abc123',
          nodeId: '3:240',
          newName: 'PB_KEY:home.hero.title',
          dryRun: true
        }
      }
    });

    const payload = parseToolText(response);
    expect(payload.status).toBe('validated');
    expect(payload.summary.totalOperations).toBe(1);
  });

  it('applies batch operations through the configured bridge', async () => {
    const response = await wrapper.send({
      jsonrpc: '2.0',
      method: 'tools/call',
      id: 4,
      params: {
        name: 'batch_apply',
        arguments: {
          fileKey: 'abc123',
          mode: 'safe_write',
          operations: [{ type: 'set_text', nodeId: '3:241', text: 'Titulo final' }]
        }
      }
    });

    const payload = parseToolText(response);
    expect(payload.status).toBe('applied');
    expect(payload.summary.appliedOperations).toBe(1);
    expect(payload.result.fileKey).toBe('abc123');
  });
});
