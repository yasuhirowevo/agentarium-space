import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSession, toPublicSession } from '../src/state.js';
import { applyCodexExecution } from '../src/codex-execution.js';
import { applyCodexMetadata } from '../src/codex-metadata.js';
import { createCodexWatcher } from '../src/watchers/codex.js';

const BASE = Date.parse('2026-09-22T01:00:00Z');
const record = (type, payload, offset = 0) => ({
  timestamp: new Date(BASE + offset).toISOString(), type, payload,
});
function session() { return createSession('synthetic-session', 'codex', 'synthetic-key'); }
function apply(s, r) { applyCodexExecution(s, r); applyCodexMetadata(s, r); }
function start(s, id, offset = 0) {
  apply(s, record('event_msg', { type: 'task_started', turn_id: id }, offset));
}
function context(s, id, effort, model = 'model-a') {
  apply(s, record('turn_context', { turn_id: id, effort, model }));
}
function limits(s, value, offset = 0) {
  apply(s, record('event_msg', { type: 'token_count', info: null, rate_limits: value }, offset));
}

test('effort follows its turn context and cannot leak into a new turn or model', () => {
  const s = session();
  start(s, 'a');
  context(s, 'a', 'high');
  assert.equal(s.codexDetails.effort, 'high');
  start(s, 'b', 1000);
  assert.equal(s.codexDetails.effort, null);
  context(s, 'a', 'old');
  assert.equal(s.codexDetails.effort, null);
  context(s, 'b', 'future-setting');
  assert.equal(s.codexDetails.effort, 'future-setting');
  context(s, 'b', undefined, 'model-b');
  assert.equal(s.codexDetails.effort, null);
  context(s, 'c', 'low');
  start(s, 'c', 2000);
  assert.equal(s.codexDetails.effort, 'low');
  context(s, 'c', 5);
  assert.equal(s.codexDetails.effort, null);
  context(s, 'c', 'x'.repeat(100));
  assert.equal(s.codexDetails.effort.length, 32);
});

test('explicit compaction history deduplicates item and top-level representations', () => {
  const s = session();
  start(s, 'a');
  const item = record('event_msg', {
    type: 'item_completed', turn_id: 'a', completed_at_ms: BASE + 1000,
    item: { type: 'ContextCompaction', id: 'compact-a' },
  }, 1000);
  apply(s, item);
  apply(s, record('compacted', {}, 1000));
  apply(s, item);
  apply(s, record('compacted', {}, 1000));
  assert.equal(s.codexDetails.compaction.observedCount, 1);
  assert.equal(s.recentEvents.filter((event) => event.includes('History compacted')).length, 1);
  apply(s, record('compacted', { id: 'compact-b' }, 2000));
  assert.equal(s.codexDetails.compaction.observedCount, 2);
  assert.equal(s.codexDetails.compaction.lastAt, BASE + 2000);
  // Smaller context usage is not evidence of compaction.
  apply(s, record('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 1 } } }, 3000));
  assert.equal(s.codexDetails.compaction.observedCount, 2);
});

test('compaction accepts reverse representations and preserves distinct identities', () => {
  const s = session();
  start(s, 'a');
  apply(s, record('compacted', {}, 1000));
  apply(s, record('event_msg', {
    type: 'item_completed', turn_id: 'a',
    item: { type: 'ContextCompaction', id: 'compact-a' },
  }, 1000));
  assert.equal(s.codexDetails.compaction.observedCount, 1);
  apply(s, record('event_msg', {
    type: 'item_completed', turn_id: 'a',
    item: { type: 'ContextCompaction', id: 'compact-b' },
  }, 1000));
  assert.equal(s.codexDetails.compaction.observedCount, 2);
  apply(s, record('event_msg', {
    type: 'item_completed', item: { type: 'ContextCompaction', id: 'failed', status: 'failed' },
  }, 2000));
  apply(s, { type: 'compacted', timestamp: 'invalid', payload: {} });
  assert.equal(s.codexDetails.compaction.observedCount, 2);
});

test('allowance snapshots retain separate limits and supplied windows with verified units', () => {
  const s = session();
  const reset = BASE / 1000 + 3600;
  limits(s, {
    limit_id: 'core', primary: { used_percent: 65, window_minutes: 300, resets_at: reset },
    secondary: { used_percent: 12, window_minutes: 10080, resets_at: reset + 600 },
  });
  limits(s, { limit_id: 'separate', primary: { used_percent: 101 } }, 1000);
  const [core, separate] = s.codexDetails.allowances;
  assert.deepEqual(core, {
    limitId: 'core', observedAt: BASE,
    windows: [
      { name: 'primary', remainingPercent: 35, windowMinutes: 300, resetsAt: reset * 1000 },
      { name: 'secondary', remainingPercent: 88, windowMinutes: 10080, resetsAt: (reset + 600) * 1000 },
    ],
  });
  assert.equal(separate.windows[0].remainingPercent, 0);
  assert.equal(separate.windows.length, 1);
  limits(s, { limit_id: 'separate', primary: { used_percent: -2 } }, 2000);
  assert.equal(s.codexDetails.allowances.at(-1).windows[0].remainingPercent, 100);
  limits(s, { limit_id: 'core', primary: { used_percent: 90 } }, -1000);
  assert.equal(s.codexDetails.allowances.find((entry) => entry.limitId === 'core').windows[0].remainingPercent, 35);
  // Crossing reset cannot refresh a snapshot or sum it into per-session OUT.
  const pub = toPublicSession(s, BASE + 86400_000);
  assert.equal(pub.codexDetails.allowances[0].observedAt, BASE);
  assert.equal(pub.outputTokensTotal, null);
});

test('missing and malformed allowance values stay unknown and retention is bounded', () => {
  const s = session();
  for (const rate_limits of [null, [], 'invalid', 9]) limits(s, rate_limits);
  assert.deepEqual(s.codexDetails.allowances, []);
  limits(s, { primary: { used_percent: '40', window_minutes: -1, resets_at: null }, secondary: null });
  assert.deepEqual(s.codexDetails.allowances[0].windows, [
    { name: 'primary', remainingPercent: null, windowMinutes: null, resetsAt: null },
  ]);
  for (let index = 0; index < 12; index++) {
    limits(s, { limit_id: 'limit-' + index, primary: {} }, index * 1000);
  }
  assert.equal(s.codexDetails.allowances.length, 8);
  assert.equal(s.codexAllowanceSnapshots.size, 8);
  for (let index = 0; index < 300; index++) {
    apply(s, record('compacted', { id: 'compact-' + index }, index * 1000));
  }
  assert.equal(s.codexCompactionIds.size, 256);
  assert.equal(s.codexCompactionTimes.size, 256);
});

test('public snapshots expose selected summaries and preserve absent-source behavior', () => {
  const s = session();
  start(s, 'a');
  context(s, 'a', 'high');
  s.codexDetails.internalRecord = { patch: 'must-not-leak' };
  s.codexDetails.commands.push({
    id: 'command', turnId: 'a', label: 'node verify.js', outcome: 'success',
    exitCode: 0, durationMs: 100, completedAt: BASE,
    stdout: 'must-not-leak',
  });
  assert.ok(!JSON.stringify(toPublicSession(s, BASE)).includes('must-not-leak'));
  assert.equal(toPublicSession(s, BASE).codexDetails.effort, 'high');
  assert.equal(toPublicSession(createSession('c', 'claude', 'c'), BASE).codexDetails, null);
  assert.equal(toPublicSession(session(), BASE).codexDetails.turn, null);
});

test('watcher publishes metadata from the observed tail without replaying historical head', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentarium-metadata-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '2026', '09', '22');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'synthetic.jsonl');
  const head = [
    record('session_meta', { id: 'synthetic', cwd: '/workspace/sample' }),
    record('event_msg', { type: 'task_started', turn_id: 'old' }),
    record('turn_context', { turn_id: 'old', effort: 'old' }),
    record('compacted', { id: 'old-compact' }),
    record('event_msg', { type: 'token_count', rate_limits: { limit_id: 'old', primary: { used_percent: 99 } } }),
  ];
  const tail = [
    record('turn_context', { turn_id: 'current', effort: 'high' }, 5000),
    record('event_msg', {
      type: 'token_count', rate_limits: { limit_id: 'core', primary: { used_percent: 25 } },
    }, 6000),
    record('compacted', { id: 'new-compact' }, 7000),
  ];
  const padding = JSON.stringify(record('unknown', { text: 'x'.repeat(700000) }));
  await writeFile(file, head.map(JSON.stringify).join('\n') + '\n' + padding + '\n'
    + tail.map(JSON.stringify).join('\n') + '\n');
  const watcher = createCodexWatcher({ root, windowMs: 86400_000 });
  const [publicSession] = await watcher.scan(BASE + 8000);
  assert.equal(publicSession.codexDetails.effort, 'high');
  assert.equal(publicSession.codexDetails.compaction.observedCount, 1);
  assert.equal(publicSession.codexDetails.allowances.length, 1);
  assert.equal(publicSession.codexDetails.allowances[0].limitId, 'core');
  assert.equal(publicSession.codexDetails.turn.status, 'unknown');
});


test('watcher keeps model, effort and workspace on the same accepted turn after replay', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentarium-context-replay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '2026', '09', '22');
  await mkdir(directory, { recursive: true });
  const earlier = { turn_id: 'a', model: 'model-a', effort: 'high', cwd: '/workspace/earlier' };
  const rows = [
    record('session_meta', { id: 'synthetic', cwd: '/workspace/earlier' }),
    record('event_msg', { type: 'task_started', turn_id: 'a' }),
    record('turn_context', earlier, 1000),
    record('event_msg', { type: 'task_complete', turn_id: 'a' }, 2000),
    record('event_msg', { type: 'task_started', turn_id: 'b' }, 3000),
    record('turn_context', { turn_id: 'b', model: 'model-b', effort: 'low', cwd: '/workspace/current' }, 4000),
    record('turn_context', earlier, 5000),
    record('event_msg', { type: 'task_complete', turn_id: 'a' }, 6000),
    record('event_msg', { type: 'item_completed', turn_id: 'b', item: { type: 'FileChange', id: 'current-edit',
      status: 'completed', changes: { '/workspace/current/src/file.js': { type: 'update' } } } }, 7000),
  ];
  await writeFile(path.join(directory, 'synthetic.jsonl'), rows.map(JSON.stringify).join('\n') + '\n');
  const watcher = createCodexWatcher({ root, windowMs: 86400_000 });
  const [actual] = await watcher.scan(BASE + 8000);
  assert.equal(actual.model, 'model-b');
  assert.equal(actual.codexDetails.effort, 'low');
  assert.equal(actual.cwd, '/workspace/current');
  assert.equal(actual.codexDetails.turn.id, 'b');
  assert.equal(actual.codexDetails.turn.status, 'active');
  assert.deepEqual(actual.codexDetails.fileChanges, [{ path: 'src/file.js', kind: 'update' }]);
});
