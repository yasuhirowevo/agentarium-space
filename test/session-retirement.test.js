import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectActiveSessions, createSession } from '../src/state.js';
import { createCodexWatcher } from '../src/watchers/codex.js';

const MINUTE = 60_000;
const BASE = Date.now() - 3 * 60 * MINUTE;
const PARENT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const encode = (records) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';
const record = (time, type, payload) => ({ timestamp: new Date(time).toISOString(), type, payload });
const event = (time, type, extra = {}) => record(time, 'event_msg', { type, ...extra });
const meta = (id, time = BASE, parentId = null) => record(time, 'session_meta', {
  id, cwd: '/workspace/project',
  ...(parentId ? { source: { subagent: { thread_spawn: { parent_thread_id: parentId } } } } : {}),
});
const start = (time, turn = 'turn-one') => event(time, 'task_started', { turn_id: turn });
const complete = (time, turn = 'turn-one') => event(time, 'task_complete', { turn_id: turn });

async function fixture(t, entries) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentarium-retirement-'));
  const directory = path.join(root, '2026', '01', '01');
  await mkdir(directory, { recursive: true });
  const paths = new Map();
  for (const [id, records] of entries) {
    const file = path.join(directory, 'rollout-2026-01-01T00-00-00-' + id + '.jsonl');
    await writeFile(file, encode(records));
    paths.set(id, file);
  }
  const watcher = createCodexWatcher({ root });
  t.after(async () => {
    await watcher.close();
    await rm(root, { recursive: true, force: true });
  });
  return { watcher, paths, append: (id, records) => appendFile(paths.get(id), encode(records)) };
}

function session(id = PARENT, source = 'codex') {
  const value = createSession(id, source, id);
  value.lastActivity = BASE;
  return value;
}

function visible(map, now) {
  return collectActiveSessions([map], now).map(({ id }) => id);
}

test('hides idle sessions at fifteen minutes without evicting their retained state', () => {
  for (const source of ['codex', 'claude']) {
    const item = session(PARENT, source);
    item.lastMainKind = 'assistant_text';
    const sessions = new Map([[item.id, item]]);
    assert.deepEqual(visible(sessions, BASE + 15 * MINUTE - 1), [PARENT]);
    assert.deepEqual(visible(sessions, BASE + 15 * MINUTE), []);
    assert.equal(sessions.size, 1);
    item.lastActivity = BASE + 20 * MINUTE;
    assert.deepEqual(visible(sessions, BASE + 20 * MINUTE), [PARENT]);
    assert.deepEqual(visible(sessions, item.lastActivity + 60 * MINUTE + 1), []);
    assert.equal(sessions.size, 0);
  }
});

test('keeps running turns and pending tools within the existing stale limit', () => {
  for (const kind of ['turn', 'tool', 'claude-turn', 'claude-child']) {
    const item = session(PARENT, kind.startsWith('claude') ? 'claude' : 'codex');
    if (kind === 'turn') item.taskActive = true;
    if (kind === 'tool') item.pendingTools.set('call', { name: 'Read', startedAt: BASE });
    if (kind === 'claude-turn') item.lastMainKind = 'tool_result';
    if (kind === 'claude-child') item.subAgents.set('child', { status: 'running' });
    const sessions = new Map([[item.id, item]]);
    assert.deepEqual(visible(sessions, BASE + 30 * MINUTE), [PARENT]);
    assert.deepEqual(visible(sessions, BASE + 60 * MINUTE + 1), []);
  }
});

test('an active descendant retains its stale ancestor chain, without retaining finished siblings', () => {
  const parent = session(PARENT);
  parent.lastActivity -= 2 * 60 * MINUTE;
  const child = session(CHILD);
  child.parentId = PARENT;
  child.taskActive = true;
  const sibling = session('sibling');
  sibling.parentId = PARENT;
  sibling.completedAt = BASE - MINUTE;
  const sessions = new Map([parent, child, sibling].map((item) => [item.id, item]));
  assert.deepEqual(new Set(visible(sessions, BASE)), new Set([PARENT, CHILD]));
  assert.equal(sessions.has(PARENT), true);
});

test('completed children retire at sixty seconds despite late metadata and pending tools', async (t) => {
  const doneAt = BASE + 1_000;
  const f = await fixture(t, [[CHILD, [
    meta(CHILD, BASE, PARENT), start(BASE),
    record(BASE + 100, 'response_item', { type: 'function_call', call_id: 'call', name: 'Read' }),
    complete(doneAt),
    event(doneAt + 59_000, 'token_count', { info: { last_token_usage: { input_tokens: 20 } } }),
  ]]]);
  assert.equal((await f.watcher.scan(doneAt + MINUTE - 1)).length, 1);
  assert.equal(f.watcher.getSessions(doneAt + MINUTE).length, 0);
  assert.equal(f.watcher.sessions.size, 1);
  await f.append(CHILD, [complete(doneAt + MINUTE), start(doneAt + MINUTE + 1)]);
  assert.equal((await f.watcher.scan(doneAt + MINUTE + 2)).length, 0);
  await f.append(CHILD, [start(doneAt + MINUTE + 3, 'turn-two')]);
  assert.equal((await f.watcher.scan(doneAt + MINUTE + 3)).length, 1);
});

test('aborted auto-review sessions without a parent also retire after sixty seconds', async (t) => {
  const doneAt = BASE + 1_000;
  const f = await fixture(t, [[CHILD, [
    meta(CHILD), record(BASE, 'turn_context', { model: 'codex-auto-review', turn_id: 'turn-one' }),
    start(BASE), event(doneAt, 'turn_aborted', { turn_id: 'turn-one' }),
  ]]]);
  assert.equal((await f.watcher.scan(doneAt + MINUTE - 1)).length, 1);
  assert.equal(f.watcher.getSessions(doneAt + MINUTE).length, 0);
});

test('a stale completion cannot retire a newer child turn', async (t) => {
  const f = await fixture(t, [[CHILD, [
    meta(CHILD, BASE, PARENT), start(BASE), complete(BASE + 100),
    start(BASE + 200, 'turn-two'), complete(BASE + 300),
  ]]]);
  assert.equal((await f.watcher.scan(BASE + 20 * MINUTE)).length, 1);
});

test('recovers completion hidden behind a large metadata tail without replaying old tools', async (t) => {
  const doneAt = BASE + 1_000;
  const f = await fixture(t, [[CHILD, [
    meta(CHILD, BASE, PARENT), start(BASE),
    record(BASE, 'unknown', { padding: 'x'.repeat(150_000) }),
    complete(doneAt),
    record(doneAt, 'unknown', { padding: 'x'.repeat(300_000) }),
    event(doneAt + MINUTE - 1, 'token_count', { info: { last_token_usage: { input_tokens: 20 } } }),
  ]]]);
  assert.equal((await f.watcher.scan(doneAt + MINUTE - 1)).length, 1);
  assert.equal(f.watcher.getSessions(doneAt + MINUTE).length, 0);
});

test('recovers a long-running turn for retirement without changing the historical public status', async (t) => {
  const f = await fixture(t, [[PARENT, [
    meta(PARENT), start(BASE),
    record(BASE, 'unknown', { padding: 'x'.repeat(400_000) }),
    event(BASE + 1, 'token_count', { info: { last_token_usage: { input_tokens: 20 } } }),
  ]]]);
  const sessions = await f.watcher.scan(BASE + 20 * MINUTE);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].status, 'idle');
});

test('discovers an old parent log for a currently running child and releases it after completion', async (t) => {
  const old = BASE - 2 * 24 * 60 * MINUTE;
  const f = await fixture(t, [
    [PARENT, [meta(PARENT, old), start(old), complete(old + 1)]],
    [CHILD, [meta(CHILD, BASE, PARENT), start(BASE)]],
  ]);
  await utimes(f.paths.get(PARENT), new Date(old), new Date(old));
  assert.deepEqual(new Set((await f.watcher.scan(BASE)).map(({ id }) => id)), new Set([PARENT, CHILD]));
  await f.append(CHILD, [complete(BASE + 1_000)]);
  assert.deepEqual((await f.watcher.scan(BASE + 1_000)).map(({ id }) => id), [CHILD]);
  assert.equal(f.watcher.getSessions(BASE + 61_000).length, 0);
});

for (const location of ['tail', 'recovered']) {
  test('ignores stale termination while recovering a running child with ' + location + ' context', async (t) => {
    const context = record(BASE + 500, 'turn_context', { turn_id: 'turn-two' });
    const f = await fixture(t, [[CHILD, [
      meta(CHILD, BASE, PARENT), start(BASE), complete(BASE + 100),
      record(BASE + 200, 'unknown', { padding: 'x'.repeat(150_000) }),
      start(BASE + 300, 'turn-two'),
      ...(location === 'recovered' ? [context] : []),
      record(BASE + 600, 'unknown', { padding: 'x'.repeat(300_000) }),
      ...(location === 'tail' ? [context] : []),
      complete(BASE + 700),
    ]]]);
    assert.equal((await f.watcher.scan(BASE + 20 * MINUTE)).length, 1);
  });
}

test('subagent source retires even when its parent metadata is missing', async (t) => {
  const f = await fixture(t, [[CHILD, [
    record(BASE, 'session_meta', { id: CHILD, source: { subagent: { other: 'guardian' } } }),
    start(BASE), complete(BASE + 1_000),
  ]]]);
  assert.equal((await f.watcher.scan(BASE + 60_999)).length, 1);
  assert.equal(f.watcher.getSessions(BASE + 61_000).length, 0);
});

test('completed normal sessions retire after fifteen minutes despite unmatched old tools', async (t) => {
  const f = await fixture(t, [[PARENT, [
    meta(PARENT), start(BASE),
    record(BASE + 100, 'response_item', { type: 'function_call', call_id: 'call', name: 'Read' }),
    complete(BASE + 1_000),
  ]]]);
  assert.equal((await f.watcher.scan(BASE + 1_000 + 15 * MINUTE - 1)).length, 1);
  assert.equal(f.watcher.getSessions(BASE + 1_000 + 15 * MINUTE).length, 0);
});

for (const repeated of ['task_complete', 'task_started']) {
  for (const location of ['skipped history', 'tail']) {
    test('cold recovery preserves first completion despite a replayed ' + repeated + ' in the ' + location, async (t) => {
      const doneAt = BASE + 1_000;
      const duplicate = event(BASE + 59_000, repeated, { turn_id: 'turn-one' });
      const f = await fixture(t, [[CHILD, [
        meta(CHILD, BASE, PARENT), start(BASE),
        record(BASE + 500, 'unknown', { padding: 'x'.repeat(150_000) }),
        complete(doneAt),
        ...(location === 'skipped history' ? [duplicate] : []),
        record(BASE + 60_000, 'unknown', { padding: 'x'.repeat(300_000) }),
        ...(location === 'tail' ? [duplicate] : []),
        event(BASE + 61_000, 'token_count', { info: { last_token_usage: { input_tokens: 20 } } }),
      ]]]);
      assert.equal((await f.watcher.scan(BASE + 62_000)).length, 0);
      const internal = f.watcher.sessions.get(f.paths.get(CHILD));
      assert.equal(internal.completedAt, doneAt);
      assert.equal(internal.retirementTaskActive, false);
      await f.append(CHILD, [start(BASE + 63_000, 'turn-two')]);
      assert.equal((await f.watcher.scan(BASE + 63_000)).length, 1);
    });
  }
}

test('a replayed old start after cold recovery cannot replace a genuinely new turn', async (t) => {
  const f = await fixture(t, [[CHILD, [
    meta(CHILD, BASE, PARENT),
    record(BASE, 'unknown', { padding: 'x'.repeat(150_000) }),
    start(BASE), complete(BASE + 1_000),
    record(BASE + 2_000, 'unknown', { padding: 'x'.repeat(300_000) }),
    event(BASE + 61_000, 'token_count', { info: { last_token_usage: { input_tokens: 20 } } }),
  ]]]);
  assert.equal((await f.watcher.scan(BASE + 62_000)).length, 0);
  await f.append(CHILD, [start(BASE + 63_000, 'turn-two'), start(BASE + 64_000), complete(BASE + 65_000, 'turn-two')]);
  assert.equal((await f.watcher.scan(BASE + 125_000)).length, 0);
  assert.equal(f.watcher.sessions.get(f.paths.get(CHILD)).completedAt, BASE + 65_000);
});

test('a current start after an older context remains running on cold recovery', async (t) => {
  const f = await fixture(t, [[CHILD, [
    meta(CHILD, BASE, PARENT), start(BASE),
    record(BASE, 'turn_context', { turn_id: 'turn-one' }),
    complete(BASE + 1_000),
    record(BASE + 2_000, 'unknown', { padding: 'x'.repeat(400_000) }),
    start(BASE + 3_000, 'turn-two'),
  ]]]);
  const sessions = await f.watcher.scan(BASE + 20 * MINUTE);
  assert.equal(sessions.length, 1);
  assert.equal(f.watcher.sessions.get(f.paths.get(CHILD)).completedAt, null);
  await f.append(CHILD, [complete(BASE + 21 * MINUTE, 'turn-two')]);
  assert.equal((await f.watcher.scan(BASE + 22 * MINUTE)).length, 0);
});

for (const mode of ['live', 'cold-small', 'cold-partial']) {
  test('a new turn context restores active child work without task_started (' + mode + ')', async (t) => {
    const history = [meta(CHILD, BASE, PARENT), start(BASE), complete(BASE + 1_000)];
    const resumed = [
      record(BASE + 120_000, 'turn_context', { turn_id: 'turn-two', model: 'example-model' }),
      record(BASE + 121_000, 'response_item', { type: 'function_call', call_id: 'call-two', name: 'Read' }),
    ];
    const f = await fixture(t, [[CHILD, [
      ...history,
      ...(mode === 'cold-partial' ? [record(BASE + 60_000, 'unknown', { padding: 'x'.repeat(400_000) })] : []),
      ...(mode === 'live' ? [] : resumed),
    ]]]);
    if (mode === 'live') {
      assert.equal((await f.watcher.scan(BASE + 62_000)).length, 0);
      await f.append(CHILD, resumed);
    }
    let sessions = await f.watcher.scan(BASE + 122_000);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].status, 'tool');
    let internal = f.watcher.sessions.get(f.paths.get(CHILD));
    assert.equal(internal.completedAt, null);
    assert.equal(internal.codexTurnId, 'turn-two');

    await f.append(CHILD, [
      record(BASE + 122_100, 'turn_context', { turn_id: 'turn-one' }),
      complete(BASE + 122_200),
    ]);
    sessions = await f.watcher.scan(BASE + 122_300);
    assert.equal(sessions.length, 1);
    internal = f.watcher.sessions.get(f.paths.get(CHILD));
    assert.equal(internal.completedAt, null);
    assert.equal(internal.codexTurnId, 'turn-two');

    await f.append(CHILD, [
      complete(BASE + 123_000, 'turn-two'),
      record(BASE + 124_000, 'turn_context', { turn_id: 'turn-two' }),
    ]);
    assert.equal((await f.watcher.scan(BASE + 183_000)).length, 0);
    assert.equal(internal.completedAt, BASE + 123_000);
  });
}

test('late metadata for a completed turn without its start keeps the original completion', async (t) => {
  const f = await fixture(t, [[CHILD, [
    meta(CHILD), complete(BASE + 1_000),
    record(BASE + 2_000, 'turn_context', { turn_id: 'turn-one', model: 'codex-auto-review' }),
  ]]]);
  assert.equal((await f.watcher.scan(BASE + 61_000)).length, 0);
  const internal = f.watcher.sessions.get(f.paths.get(CHILD));
  assert.equal(internal.model, 'codex-auto-review');
  assert.equal(internal.completedAt, BASE + 1_000);
});

test('cold recovery keeps an ID-less started child when context later supplies its identity', async (t) => {
  const old = BASE - 2 * 60 * MINUTE;
  const f = await fixture(t, [
    [PARENT, [meta(PARENT, old), start(old), complete(old + 1)]],
    [CHILD, [
      meta(CHILD, BASE, PARENT), event(BASE, 'task_started'),
      record(BASE + 1, 'turn_context', { turn_id: 'turn-one' }),
      record(BASE + 2, 'unknown', { padding: 'x'.repeat(400_000) }),
      event(BASE + 3, 'token_count', { info: { last_token_usage: { input_tokens: 20 } } }),
    ]],
  ]);
  const sessions = await f.watcher.scan(BASE + 20 * MINUTE);
  assert.deepEqual(new Set(sessions.map(({ id }) => id)), new Set([PARENT, CHILD]));
  const internal = f.watcher.sessions.get(f.paths.get(CHILD));
  assert.equal(internal.retirementTaskActive, true);
  assert.equal(internal.codexTurnId, 'turn-one');
  assert.equal(sessions.find(({ id }) => id === CHILD).status, 'idle');
  await f.append(CHILD, [complete(BASE + 21 * MINUTE)]);
  assert.deepEqual((await f.watcher.scan(BASE + 21 * MINUTE)).map(({ id }) => id), [CHILD]);
  assert.equal(f.watcher.getSessions(BASE + 22 * MINUTE).length, 0);
});
