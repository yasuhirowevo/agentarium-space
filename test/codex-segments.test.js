import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCodexWatcher } from '../src/watchers/codex.js';

const MINUTE = 60_000;
const BASE = Date.now() - 5 * MINUTE;
const PARENT = '11111111-1111-4111-8111-111111111111';
const CHILD = '22222222-2222-4222-8222-222222222222';
const OLD_SEGMENT = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const NEW_SEGMENT = '33333333-3333-4333-8333-333333333333';
const encode = (records) => records.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
const record = (type, payload, time = BASE) => ({ timestamp: new Date(time).toISOString(), type, payload });
const event = (type, extra = {}, time = BASE) => record('event_msg', { type, ...extra }, time);
const meta = (id, extra = {}, time = BASE) => record('session_meta', {
  id, cwd: '/fixture/project', ...extra,
}, time);
const paginatedMeta = (extra = {}, time = BASE) => meta(PARENT, {
  session_id: PARENT, source: 'vscode', history_mode: 'paginated', ...extra,
}, time);
const message = (text, time = BASE) => event('agent_message', { message: text, phase: 'commentary' }, time);
const filename = (time, id = PARENT, segment = null) => (
  `rollout-2026-09-24T${time}-${id}${segment ? '_' + segment : ''}.jsonl`
);
const OLD_FILE = filename('00-03-01', PARENT, OLD_SEGMENT);
const NEW_FILE = filename('00-51-14', PARENT, NEW_SEGMENT);

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentarium-segments-'));
  const directory = path.join(root, '2026', '09', '24');
  await mkdir(directory, { recursive: true });
  const watcher = createCodexWatcher({ root });
  t.after(async () => {
    await watcher.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    watcher,
    file: (name) => path.join(directory, name),
    write: (name, records) => writeFile(path.join(directory, name), encode(records)),
    append: (name, records) => appendFile(path.join(directory, name), encode(records)),
  };
}

test('a paginated rollout accepts the session UUID and rejects inherited metadata', async (t) => {
  const f = await fixture(t);
  await f.write(NEW_FILE, [
    meta(CHILD, { cwd: '/fixture/inherited', source: { subagent: { other: 'guardian' } } }),
    paginatedMeta({ cwd: '/fixture/current', originator: 'current-originator' }),
    event('task_started', { turn_id: 'current-turn' }),
    meta(NEW_SEGMENT, { cwd: '/fixture/wrong', originator: 'wrong-originator' }),
    message('Current work'),
  ]);
  const [session] = await f.watcher.scan(BASE);
  assert.equal(session.id, PARENT);
  assert.equal(session.cwd, '/fixture/current');
  assert.equal(session.originator, 'current-originator');
  assert.equal(session.isSubAgent, false);
  assert.equal(session.lastMessage, 'Current work');
});

test('a standard guardian keeps its own id when session_id names its parent', async (t) => {
  const f = await fixture(t);
  await f.write(filename('00-52-00', CHILD), [
    meta(CHILD, {
      session_id: PARENT, parent_thread_id: PARENT,
      source: { subagent: { other: 'guardian' } },
    }),
    meta(PARENT, { session_id: PARENT, cwd: '/fixture/foreign', source: 'vscode' }),
    event('task_started', { turn_id: 'child-turn' }),
  ]);
  const sessions = await f.watcher.scan(BASE);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, CHILD);
  assert.equal(sessions[0].parentId, PARENT);
  assert.equal(sessions[0].isSubAgent, true);
  assert.equal(sessions[0].cwd, '/fixture/project');
});

test('initial discovery publishes only the newest segment without merging old tools or messages', async (t) => {
  const f = await fixture(t);
  await f.write(NEW_FILE, [paginatedMeta(), message('Newest segment')]);
  await f.write(OLD_FILE, [
    paginatedMeta(),
    record('response_item', { type: 'function_call', name: 'Read', call_id: 'old-call' }),
    message('Old segment appended later', BASE + 10_000),
  ]);
  const sessions = await f.watcher.scan(BASE + 10_000);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, PARENT);
  assert.equal(sessions[0].lastMessage, 'Newest segment');
  assert.equal(sessions[0].activity, null);
  assert.equal(sessions[0].toolCallsTotal, 0);
  assert.equal(f.watcher.sessions.size, 1);
  assert.equal(f.watcher.sessions.has(f.file(NEW_FILE)), true);
});

for (const first of ['older', 'newer']) {
  test(`newest segment wins when the ${first} segment is discovered first and old data grows`, async (t) => {
    const f = await fixture(t);
    const firstFile = first === 'older' ? OLD_FILE : NEW_FILE;
    const secondFile = first === 'older' ? NEW_FILE : OLD_FILE;
    const label = (name) => name === NEW_FILE ? 'Newest segment' : 'Older segment';
    await f.write(firstFile, [paginatedMeta(), message(label(firstFile))]);
    const [initial] = await f.watcher.scan(BASE);
    await f.write(secondFile, [paginatedMeta(), message(label(secondFile))]);
    const [latest] = await f.watcher.scan(BASE);
    assert.equal(latest.lastMessage, 'Newest segment');
    assert.equal(latest.key, initial.key, 'segment rollover keeps the same orb identity');
    await f.append(OLD_FILE, [
      event('task_started', { turn_id: 'late-old-turn' }, BASE + 10_000),
      message('Later append to old segment', BASE + 10_000),
    ]);
    const sessions = await f.watcher.scan(BASE + 10_000);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].lastMessage, 'Newest segment');
    assert.equal(sessions[0].key, initial.key);
    assert.equal(f.watcher.sessions.size, 1);
    await f.append(NEW_FILE, [message('Current append', BASE + 20_000)]);
    assert.equal((await f.watcher.scan(BASE + 20_000))[0].lastMessage, 'Current append');
  });
}

test('a standard rollout and its later paginated segment are one session', async (t) => {
  const f = await fixture(t);
  await f.write(filename('00-00-00'), [meta(PARENT), message('Original rollout')]);
  const [initial] = await f.watcher.scan(BASE);
  await f.write(NEW_FILE, [paginatedMeta(), message('Paginated continuation')]);
  const sessions = await f.watcher.scan(BASE);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].lastMessage, 'Paginated continuation');
  assert.equal(sessions[0].key, initial.key);
});

for (const pending of ['empty', 'partial', 'foreign metadata']) {
  test(`a ${pending} latest segment preserves published state until its identity is complete`, async (t) => {
    const f = await fixture(t);
    const childFile = filename('00-52-00', CHILD);
    await f.write(OLD_FILE, [
      paginatedMeta(), event('task_started', { turn_id: 'old-turn' }), message('Published work'),
    ]);
    await f.write(childFile, [
      meta(CHILD, {
        parent_thread_id: PARENT, source: { subagent: { other: 'guardian' } },
      }),
      event('task_started', { turn_id: 'child-turn' }),
    ]);
    const original = await f.watcher.scan(BASE);
    const parent = original.find(({ id }) => id === PARENT);
    const header = JSON.stringify(paginatedMeta());
    const prefix = pending === 'partial' ? header.slice(0, -1)
      : pending === 'foreign metadata' ? encode([meta(NEW_SEGMENT), message('Unconfirmed work')]) : '';
    await writeFile(f.file(NEW_FILE), prefix);
    assert.deepEqual(await f.watcher.scan(BASE), original);
    assert.equal(f.watcher.sessions.has(f.file(OLD_FILE)), true);
    assert.equal(f.watcher.sessions.has(f.file(NEW_FILE)), false);

    // A complete JSON object without its newline still belongs to the writer.
    await appendFile(f.file(NEW_FILE), pending === 'partial' ? '}' : header);
    assert.deepEqual(await f.watcher.scan(BASE), original);
    await appendFile(f.file(NEW_FILE), '\n' + encode([
      event('task_started', { turn_id: 'current-turn' }), message('Current segment'),
    ]));
    const switched = await f.watcher.scan(BASE);
    assert.equal(switched.length, 2);
    assert.equal(switched.find(({ id }) => id === PARENT).key, parent.key);
    assert.equal(switched.find(({ id }) => id === PARENT).lastMessage, 'Current segment');
    assert.equal(switched.find(({ id }) => id === CHILD).parentId, PARENT);
    assert.equal(f.watcher.sessions.has(f.file(OLD_FILE)), false);
    assert.equal(f.watcher.sessions.has(f.file(NEW_FILE)), true);
    await f.append(OLD_FILE, [message('Late old append', BASE + 1_000)]);
    assert.equal((await f.watcher.scan(BASE + 1_000)).find(({ id }) => id === PARENT).lastMessage,
      'Current segment');
  });
}

test('ancestor discovery selects the newest segmented parent outside the initial file window', async (t) => {
  const f = await fixture(t);
  const old = BASE - 3 * 24 * 60 * MINUTE;
  for (const [name, text] of [[NEW_FILE, 'Latest parent'], [OLD_FILE, 'Earlier parent']]) {
    await f.write(name, [paginatedMeta({}, old), message(text, old)]);
    await utimes(f.file(name), new Date(old), new Date(old));
  }
  const childFile = filename('00-52-00', CHILD);
  await f.write(childFile, [
    meta(CHILD, { parent_thread_id: PARENT, source: { subagent: { other: 'guardian' } } }),
    event('task_started', { turn_id: 'child-turn' }),
    event('task_complete', { turn_id: 'child-turn' }, BASE + 1_000),
  ]);
  const sessions = await f.watcher.scan(BASE + 30_000);
  assert.deepEqual(new Set(sessions.map(({ id }) => id)), new Set([PARENT, CHILD]));
  assert.equal(sessions.find(({ id }) => id === PARENT).lastMessage, 'Latest parent');
  assert.equal(f.watcher.sessions.has(f.file(OLD_FILE)), false);
  assert.deepEqual(f.watcher.getSessions(BASE + 61_000), []);
});

for (const pending of ['empty', 'partial']) {
  test(`cold start falls back to an older parent while the latest segment is ${pending}`, async (t) => {
    const f = await fixture(t);
    const old = BASE - 3 * 24 * 60 * MINUTE;
    await f.write(OLD_FILE, [paginatedMeta({}, old), message('Earlier parent', old)]);
    await utimes(f.file(OLD_FILE), new Date(old), new Date(old));
    const header = JSON.stringify(paginatedMeta());
    await writeFile(f.file(NEW_FILE), pending === 'partial' ? header.slice(0, -1) : '');
    await f.write(filename('00-52-00', CHILD), [
      meta(CHILD, { parent_thread_id: PARENT, source: { subagent: { other: 'guardian' } } }),
      event('task_started', { turn_id: 'child-turn' }),
    ]);
    const initial = await f.watcher.scan(BASE);
    assert.deepEqual(new Set(initial.map(({ id }) => id)), new Set([PARENT, CHILD]));
    const parent = initial.find(({ id }) => id === PARENT);
    assert.equal(parent.lastMessage, 'Earlier parent');
    assert.equal(f.watcher.sessions.has(f.file(NEW_FILE)), false);

    await f.append(OLD_FILE, [message('Prior segment continues', BASE + 1_000)]);
    const continued = await f.watcher.scan(BASE + 1_000);
    assert.equal(continued.find(({ id }) => id === PARENT).lastMessage, 'Prior segment continues');
    assert.equal(continued.find(({ id }) => id === PARENT).key, parent.key);
    await appendFile(f.file(NEW_FILE), (pending === 'partial' ? '}' : header) + '\n' + encode([
      event('task_started', { turn_id: 'current-turn' }), message('New segment ready'),
    ]));
    const latest = await f.watcher.scan(BASE + 1_000);
    assert.equal(latest.length, 2);
    assert.equal(latest.find(({ id }) => id === PARENT).lastMessage, 'New segment ready');
    assert.equal(latest.find(({ id }) => id === PARENT).key, parent.key);
    assert.equal(latest.find(({ id }) => id === CHILD).parentId, PARENT);
    assert.equal(f.watcher.sessions.has(f.file(OLD_FILE)), false);
    await f.append(OLD_FILE, [message('Obsolete append', BASE + 2_000)]);
    assert.equal((await f.watcher.scan(BASE + 2_000)).find(({ id }) => id === PARENT).lastMessage,
      'New segment ready');
  });
}

test('bounded segment recovery reads current metadata without replaying skipped activity', async (t) => {
  const f = await fixture(t);
  await f.write(NEW_FILE, [
    paginatedMeta({ cwd: '/fixture/current' }),
    record('unknown', { padding: 'x'.repeat(150_000) }),
    record('response_item', { type: 'function_call', name: 'Read', call_id: 'skipped-call' }),
    record('turn_context', { turn_id: 'current-turn', model: 'current-model' }),
    record('unknown', { padding: 'x'.repeat(300_000) }),
    message('Current tail'),
  ]);
  const [session] = await f.watcher.scan(BASE);
  assert.equal(session.id, PARENT);
  assert.equal(session.cwd, '/fixture/current');
  assert.equal(session.model, 'current-model');
  assert.equal(session.lastMessage, 'Current tail');
  assert.equal(session.toolCallsTotal, 0);
  assert.equal(session.activity, null);
});
