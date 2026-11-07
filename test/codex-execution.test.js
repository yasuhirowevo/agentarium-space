import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyCodexExecution } from '../src/codex-execution.js';
import { createSession } from '../src/state.js';
import { createCodexWatcher } from '../src/watchers/codex.js';

const START = 1_800_000_000_000;
const record = (payload, offset = 0, type = 'event_msg') => ({
  type, timestamp: new Date(START + offset).toISOString(), payload,
});
const start = (id = 'turn-a', offset = 0) => record({ type: 'task_started', turn_id: id }, offset);
const command = (id, overrides = {}, turnId = 'turn-a') => record({
  type: 'item_completed', turn_id: turnId,
  started_at_ms: START + 100, completed_at_ms: START + 600,
  item: {
    type: 'CommandExecution', id, command: ['node', 'check.js'], status: 'completed',
    exit_code: 0, duration: { secs: 0, nanos: 500_000_000 }, ...overrides,
  },
}, 600);
const files = (id, changes, overrides = {}, turnId = 'turn-a') => record({
  type: 'item_completed', turn_id: turnId,
  item: { type: 'FileChange', id, status: 'completed', changes, ...overrides },
}, 700);
function fixture() {
  const session = createSession('synthetic-session', 'codex', 'synthetic-key');
  session.cwd = '/workspace/sample';
  return { session, apply: (...records) => records.forEach((entry) => applyCodexExecution(session, entry)) };
}

test('structured commands preserve parallel identities, outcomes and verified durations', () => {
  const { session, apply } = fixture();
  apply(start(), command('command-a'), command('command-a'), command('command-b', { exit_code: 2 }),
    command('command-c', { status: 'failed', exit_code: 0 }),
    command('command-d', { status: 'future-status', exit_code: 0 }),
    command('command-e', { exit_code: null, duration: 500 }));
  assert.equal(session.codexDetails.commands.length, 5);
  assert.deepEqual(session.codexDetails.commands.map((entry) => entry.outcome),
    ['success', 'failed', 'failed', 'unknown', 'unknown']);
  assert.equal(session.codexDetails.commands[0].durationMs, 500);
  assert.equal(session.codexDetails.commands[4].durationMs, 500);
  assert.equal(session.codexDetails.commands[0].label, 'node check.js');
  assert.equal(session.toolCallsTotal, 0);
  assert.match(session.recentEvents[1], /failed \(exit 2\) · 500ms$/);
});

test('incomplete and continuing command results never become success', () => {
  const { session, apply } = fixture();
  const unknown = command('unknown', { exit_code: null, duration: 4, status: 'in_progress', process_id: '1234' });
  delete unknown.payload.started_at_ms;
  delete unknown.payload.completed_at_ms;
  apply(command(undefined), record({ type: 'item_started', item: command('pending').payload.item }), unknown,
    record({ type: 'function_call_output', call_id: 'outer', output: '{"session_id":1234}' }, 800, 'response_item'));
  assert.equal(session.codexDetails.commands.length, 1);
  assert.equal(session.codexDetails.commands[0].outcome, 'unknown');
  assert.equal(session.codexDetails.commands[0].exitCode, null);
  assert.equal(session.codexDetails.commands[0].durationMs, null);
});

test('command history and identity caches are bounded without retaining raw output', () => {
  const { session, apply } = fixture();
  for (let index = 0; index < 300; index += 1) {
    apply(command(`command-${index}`, {
      command: 'x'.repeat(400), stdout: 'private-output', stderr: 'private-error',
    }));
  }
  assert.equal(session.codexDetails.commands.length, 20);
  assert.equal(session.codexExecution.items.size, 256);
  assert.equal(session.codexDetails.commands[0].id, 'command-280');
  assert.equal(session.codexDetails.commands[0].label.length, 120);
  assert.ok(!JSON.stringify(session.codexDetails).includes('private-output'));
  apply(start('turn-b'), command('command-299', {}, 'turn-b'));
  assert.equal(session.codexDetails.commands.at(-1).turnId, 'turn-b');
});

test('turn timing converts epoch seconds and freezes on completion or interruption', () => {
  const { session, apply } = fixture();
  apply(record({ type: 'task_started', turn_id: 'turn-a', started_at: START / 1000 }),
    start('turn-a', 2000));
  assert.equal(session.codexDetails.turn.startedAt, START);
  apply(record({ type: 'task_complete', turn_id: 'old-turn', duration_ms: 5000 }, 5000));
  assert.equal(session.codexDetails.turn.status, 'active');
  apply(record({ type: 'task_complete', turn_id: 'turn-a', completed_at: START / 1000 + 4,
    duration_ms: 4321 }, 4500));
  assert.deepEqual(session.codexDetails.turn, {
    id: 'turn-a', status: 'completed', startedAt: START, completedAt: START + 4000, durationMs: 4321,
  });
  apply(start('turn-a', 8000), record({ type: 'task_complete', turn_id: 'turn-a' }, 9000));
  assert.equal(session.codexDetails.turn.durationMs, 4321);
  apply(start('turn-b', 10000), record({ type: 'turn_aborted', turn_id: 'turn-b' }, 12000));
  assert.equal(session.codexDetails.turn.status, 'interrupted');
  assert.equal(session.codexDetails.turn.durationMs, 2000);
});

test('missing starts stay unknown while explicit ending duration remains useful', () => {
  const { session, apply } = fixture();
  apply(record({ type: 'task_complete', turn_id: 'turn-a' }, 6000));
  assert.equal(session.codexDetails.turn.startedAt, null);
  assert.equal(session.codexDetails.turn.durationMs, null);
  apply(record({ turn_id: 'turn-b' }, 7000, 'turn_context'));
  assert.equal(session.codexDetails.turn.status, 'unknown');
  assert.equal(session.codexDetails.turn.startedAt, null);
  apply(record({ type: 'turn_aborted', turn_id: 'turn-b', duration_ms: 1200 }, 8000));
  assert.equal(session.codexDetails.turn.durationMs, 1200);
  apply(start('turn-a', 9000));
  assert.equal(session.codexDetails.turn.id, 'turn-b');
});

test('a new legacy ID-less turn clears completed edits without resetting duplicate starts', () => {
  const { session, apply } = fixture();
  apply(start(null), files('legacy-edit', { 'old.js': { type: 'add' } }, {}, null),
    start(null), record({ type: 'task_complete' }, 1000));
  assert.equal(session.codexDetails.fileChanges.length, 1);
  apply(start(null, 2000));
  assert.equal(session.codexDetails.turn.status, 'active');
  assert.equal(session.codexDetails.turn.startedAt, START + 2000);
  assert.deepEqual(session.codexDetails.fileChanges, []);
});

test('context-only turns isolate edits, permit their own start, and ignore stale context', () => {
  const { session, apply } = fixture();
  apply(start(), files('edit-a', { 'first.js': { type: 'add', content: 'private-body' } }),
    record({ turn_id: 'turn-b' }, 1000, 'turn_context'));
  assert.deepEqual(session.codexDetails.fileChanges, []);
  assert.equal(session.codexDetails.turn.status, 'unknown');
  apply(start('turn-b', 1100), record({ turn_id: 'turn-a' }, 1200, 'turn_context'));
  assert.equal(session.codexDetails.turn.id, 'turn-b');
  assert.equal(session.codexDetails.turn.startedAt, START + 1100);
  apply(files('edit-old', { 'old.js': { type: 'update' } }),
    files('edit-unknown', { 'unknown.js': { type: 'update' } }, {}, null));
  assert.deepEqual(session.codexDetails.fileChanges, []);
});

test('successful file changes distinguish add, update, delete and move without exposing patches', () => {
  const { session, apply } = fixture();
  const edit = files('edit-a', {
    '/workspace/sample/add.js': { type: 'add', content: 'private-body' },
    '/workspace/sample/src/../update.js': { type: 'update', unified_diff: 'private-diff' },
    '/workspace/sample/delete.js': { type: 'delete', content: 'private-body' },
    '/workspace/sample/old.js': { type: 'update', move_path: '/workspace/sample/new.js' },
  });
  apply(start(), edit, edit, files('failed-edit', { 'failed.js': { type: 'add' } }, { status: 'failed' }),
    files('denied-edit', { 'denied.js': { type: 'add' } }, { status: 'declined' }),
    files('later-edit', { './update.js': { type: 'update', unified_diff: 'new-private-diff' } }));
  assert.deepEqual(session.codexDetails.fileChanges, [
    { path: 'add.js', kind: 'add' }, { path: 'update.js', kind: 'update' },
    { path: 'delete.js', kind: 'delete' }, { path: 'new.js', kind: 'move', from: 'old.js' },
  ]);
  assert.ok(!JSON.stringify(session.codexDetails).includes('private'));
  assert.equal(session.recentEvents.filter((event) => event.includes('Observed edits')).length, 2);
  assert.match(session.recentEvents[1], /Observed edits: 1 file · update update.js$/);
  apply(record({ type: 'task_complete', turn_id: 'turn-a' }, 1000));
  assert.equal(session.codexDetails.fileChanges.length, 4);
  apply(start('turn-b', 1500));
  assert.deepEqual(session.codexDetails.fileChanges, []);
});

test('file bounds deduplicate complete paths and disclose overflow', () => {
  const { session, apply } = fixture();
  const changes = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`file-${index}.js`, { type: 'add' }]));
  apply(start(), files('edit-many', changes));
  assert.equal(session.codexDetails.fileChanges.length, 100);
  assert.equal(session.codexDetails.filesTruncated, true);
  apply(files('move-one', { 'file-0.js': { type: 'update', move_path: 'renamed.js' } }));
  assert.equal(session.codexDetails.fileChanges.length, 100);
  assert.ok(session.codexDetails.fileChanges.some((entry) => entry.path === 'renamed.js'));
  apply(start('turn-b', 1500));
  assert.equal(session.codexDetails.filesTruncated, false);
});

test('path summaries normalize Windows workspaces and tolerate missing cwd and malformed records', () => {
  const { session, apply } = fixture();
  session.cwd = 'C:\\workspace\\sample';
  apply(start(), files('windows', { 'C:\\workspace\\sample\\src\\check.js': { type: 'update' } }));
  assert.equal(session.codexDetails.fileChanges[0].path, 'src/check.js');
  session.cwd = '';
  apply(files('no-cwd', { '/elsewhere/check.js': { type: 'update' } }), null, {},
    record({ type: 'item_completed', item: null }), files('bad', { 'bad.js': null }));
  assert.equal(session.codexDetails.fileChanges[1].path, '/elsewhere/check.js');
});

test('watcher observes structured inner outcomes without counting them as new outer tool calls', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentarium-execution-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '2026', '09', '01');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'synthetic.jsonl');
  const now = Date.now();
  const stamp = (entry) => ({ ...entry, timestamp: new Date(now).toISOString() });
  const encode = (entries) => `${entries.map((entry) => JSON.stringify(stamp(entry))).join('\n')}\n`;
  await writeFile(file, encode([
    record({ id: 'synthetic-session', cwd: '/workspace/sample' }, 0, 'session_meta'), start(),
    record({ type: 'custom_tool_call', name: 'functions.exec', call_id: 'outer', input: 'opaque-wrapper' }, 0, 'response_item'),
    command('inner', { status: 'failed', exit_code: 3 }),
    record({ type: 'custom_tool_call_output', call_id: 'outer', output: 'opaque-output' }, 0, 'response_item'),
  ]));
  const watcher = createCodexWatcher({ root });
  const [published] = await watcher.scan(now);
  let session = [...watcher.sessions.values()][0];
  assert.equal(session.codexDetails.commands.length, 1);
  assert.equal(session.codexDetails.commands[0].outcome, 'failed');
  assert.equal(session.toolCallsTotal, 1);
  assert.equal(published.codexDetails.commands[0].outcome, 'failed');
  assert.equal(published.codexDetails.turn.status, 'active');
  assert.ok(!JSON.stringify(published.codexDetails).includes('opaque-output'));
  assert.match(session.recentEvents.at(-1), /returned$/);
  await appendFile(file, encode([command('inner', { status: 'failed', exit_code: 3 })]));
  await watcher.scan(now);
  assert.equal(session.codexDetails.commands.length, 1);
  await appendFile(file, encode([
    record({ type: 'function_call', name: 'update_plan', call_id: 'plan-call',
      arguments: JSON.stringify({ plan: [{ step: 'Check fixture', status: 'in_progress' }] }) }, 0, 'response_item'),
    record({ type: 'function_call_output', call_id: 'plan-call', output: 'Plan updated' }, 0, 'response_item'),
  ]));
  const [withPlan] = await watcher.scan(now);
  assert.deepEqual(withPlan.codexDetails.plan.steps, [{ step: 'Check fixture', status: 'in_progress' }]);
  assert.equal(withPlan.toolCallsTotal, 2);
  await writeFile(file, encode([start('turn-new')]));
  await watcher.scan(now);
  session = [...watcher.sessions.values()][0];
  assert.deepEqual(session.codexDetails.commands, []);
});

test('large-file historical head does not replay execution details', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentarium-execution-head-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '2026', '09', '01');
  await mkdir(directory, { recursive: true });
  const now = Date.now();
  const stamp = (entry) => ({ ...entry, timestamp: new Date(now).toISOString() });
  const entries = [start(), command('historical-command'), files('historical-edit', { 'old.js': { type: 'add' } }),
    record({ padding: 'x'.repeat(400_000) }, 0, 'unknown'),
    record({ turn_id: 'current-turn' }, 0, 'turn_context')].map(stamp);
  await writeFile(path.join(directory, 'synthetic.jsonl'), `${entries.map(JSON.stringify).join('\n')}\n`);
  const watcher = createCodexWatcher({ root });
  await watcher.scan(now);
  const session = [...watcher.sessions.values()][0];
  assert.equal(session.codexDetails.turn.status, 'unknown');
  assert.deepEqual(session.codexDetails.commands, []);
  assert.deepEqual(session.codexDetails.fileChanges, []);
});


test('Windows drive-letter casing does not split observed file identities', () => {
  const session = createSession('synthetic', 'codex', 'synthetic');
  session.cwd = 'C:/workspace/sample';
  for (const [index, file] of ['c:/workspace/sample/src/file.js', 'C:/workspace/sample/src/file.js'].entries()) {
    applyCodexExecution(session, {
      timestamp: new Date().toISOString(), type: 'event_msg',
      payload: { type: 'item_completed', turn_id: 'turn-a',
        item: { type: 'FileChange', id: 'edit-' + index, status: 'completed',
          changes: { [file]: { type: 'update' } } } },
    });
  }
  assert.deepEqual(session.codexDetails.fileChanges, [{ path: 'src/file.js', kind: 'update' }]);
});
