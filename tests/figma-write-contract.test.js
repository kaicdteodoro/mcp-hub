import { describe, expect, it } from 'vitest';
import {
  buildDryRunResult,
  normalizeFindNodesArgs,
  normalizePlan
} from '../fixtures/figma-write-contract.mjs';

describe('figma-write contract', () => {
  it('validates a mixed rename and set_text batch', () => {
    const result = normalizePlan({
      fileKey: 'abc123',
      operations: [
        { type: 'rename_node', nodeId: '2:10', newName: 'PB_KEY:home.hero.title' },
        { type: 'set_text', nodeId: '2:11', text: 'Titulo da hero' }
      ]
    });

    expect(result.ok).toBe(true);
    expect(result.value.mode).toBe('safe_write');
    expect(result.value.operations).toHaveLength(2);
    expect(result.warnings).toHaveLength(0);
  });

  it('flags invalid plans and duplicate rename targets', () => {
    const result = normalizePlan({
      fileKey: 'abc123',
      operations: [
        { type: 'rename_node', nodeId: '2:10', newName: 'PB_KEY:home.hero.title' },
        { type: 'rename_node', nodeId: '2:11', newName: 'pb_key:home.hero.title' },
        { type: 'set_text', nodeId: '', text: '' }
      ]
    });

    expect(result.ok).toBe(false);
    expect(result.errors.some((item) => item.code === 'invalid_node_id')).toBe(true);
    expect(result.warnings.some((item) => item.code === 'duplicate_rename_target')).toBe(true);
  });

  it('validates find_nodes arguments', () => {
    const valid = normalizeFindNodesArgs({ fileKey: 'abc123', query: 'hero' });
    const invalid = normalizeFindNodesArgs({ fileKey: '', query: '' });

    expect(valid.ok).toBe(true);
    expect(invalid.ok).toBe(false);
    expect(invalid.errors).toHaveLength(2);
  });

  it('builds dry-run output with bridge metadata', () => {
    const plan = normalizePlan({
      fileKey: 'abc123',
      operations: [{ type: 'rename_node', nodeId: '2:10', newName: 'PB_KEY:home.hero.title' }]
    });

    const payload = buildDryRunResult(plan, { status: 'bridge_missing' }, { name: 'stub', configured: false });
    expect(payload.status).toBe('validated');
    expect(payload.bridgeConfigured).toBe(false);
    expect(payload.summary.totalOperations).toBe(1);
  });
});

