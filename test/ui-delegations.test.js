import assert from 'node:assert/strict';
import test from 'node:test';
import {
  delegationVisualState,
  normalizeDelegationLinks,
} from '../ui/delegations.js';

const sessions = new Map([
  ['claude-parent', { source: 'claude', parentId: null }],
  ['codex-child', { source: 'codex', parentId: 'native-codex-parent' }],
  ['codex-parent', { source: 'codex', parentId: null }],
  ['claude-child', { source: 'claude', parentId: null }],
]);

test('normalizes both delegation directions without changing native hierarchy', () => {
  const links = normalizeDelegationLinks([
    {
      id: 'agl_0123456789abcdefghijklmn',
      parentKey: 'claude-parent',
      childKey: 'codex-child',
      parentSource: 'claude',
      childSource: 'codex',
      status: 'running',
      count: 2,
    },
    {
      id: 'agl_abcdefghijklmnopqrstuvwx',
      parentKey: 'codex-parent',
      childKey: 'claude-child',
      parentSource: 'codex',
      childSource: 'claude',
      status: 'complete',
    },
  ], sessions);

  assert.equal(links.length, 2);
  assert.deepEqual(links.map((link) => [link.parentSource, link.childSource]), [
    ['claude', 'codex'],
    ['codex', 'claude'],
  ]);
  assert.equal(links[0].count, 2);
  assert.equal(sessions.get('codex-child').parentId, 'native-codex-parent');
});

test('stops delegation motion for reduced motion and fades terminal links', () => {
  const now = Date.now();
  assert.deepEqual(delegationVisualState({ status: 'running' }, now, false), {
    fade: 1,
    moving: true,
  });
  assert.deepEqual(delegationVisualState({ status: 'running' }, now, true), {
    fade: 1,
    moving: false,
  });
  assert.deepEqual(delegationVisualState({ status: 'complete', endedAt: now - 30_000 }, now, false), {
    fade: 0.5,
    moving: false,
  });
  assert.equal(delegationVisualState({ status: 'failed', endedAt: now - 60_000 }, now).fade, 0);
});
