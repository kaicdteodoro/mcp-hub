import { describe, expect, it } from 'vitest';
import { FigmaWriteBridgeServiceCore } from '../bridges/local-figma-write-service-core.mjs';

describe('local figma write service core', () => {
  it('registers a session and dispatches a command through it', async () => {
    const core = new FigmaWriteBridgeServiceCore({
      createId: (() => {
        let index = 0;
        return () => `id-${++index}`;
      })(),
      commandTimeoutMs: 5000
    });

    const session = core.registerSession({
      fileKey: 'abc123',
      documentName: 'Santomaz'
    });

    const commandPromise = core.dispatchCommand('dry_run', {
      fileKey: 'abc123',
      operations: [{ type: 'rename_node', nodeId: '3:240', newName: 'PB_KEY:home.hero.title' }]
    });

    const next = await core.nextCommand(session.id, { waitMs: 10 });
    expect(next.status).toBe('ok');
    expect(next.command.type).toBe('dry_run');

    core.completeCommand(session.id, next.command.id, {
      status: 'ok',
      validOperations: 1
    });

    await expect(commandPromise).resolves.toMatchObject({
      status: 'ok',
      validOperations: 1
    });
  });

  it('errors when no active session matches the requested file key', async () => {
    const core = new FigmaWriteBridgeServiceCore();

    await expect(
      core.dispatchCommand('find_nodes', {
        fileKey: 'missing',
        query: 'hero'
      })
    ).rejects.toThrow('No active Figma write plugin session');
  });
});

