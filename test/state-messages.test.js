import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSession, setLastMessage, toPublicSession } from '../src/state.js';
import { createClaudeWatcher } from '../src/watchers/claude.js';
import { createCodexWatcher } from '../src/watchers/codex.js';
import { isMainCalloutSession } from '../ui/callout-policy.js';

test('public snapshots preserve child identity even when parent metadata is absent', () => {
  const child = createSession('child', 'codex', 'child');
  child.isSubAgent = true;
  child.parentId = null;
  const snapshot = toPublicSession(child, 1_000);
  assert.equal(snapshot.isSubAgent, true);
  assert.equal(isMainCalloutSession(snapshot), false);
  assert.equal(isMainCalloutSession(toPublicSession(createSession('main', 'codex', 'main'), 1_000)), true);
});

test('public child identity is a boolean for parent-only and auto-review metadata', () => {
  for (const fields of [{ parentId: 'parent' }, { model: 'codex-auto-review' }]) {
    const child = Object.assign(createSession('child', 'codex', 'child'), fields);
    assert.equal(toPublicSession(child, 1_000).isSubAgent, true);
  }
});

test('publishes bounded Unicode callout text while preserving the short excerpt', () => {
  const session = createSession('synthetic', 'codex', 'synthetic');
  assert.equal(toPublicSession(session, 1_000).lastMessageText, null);
  const characters = '星🌟'.repeat(180);
  setLastMessage(session, ` \n${characters}\t `, 1_000, 'commentary');
  const snapshot = toPublicSession(session, 1_000);
  assert.equal(snapshot.lastMessage, '星🌟'.repeat(30));
  assert.equal(snapshot.lastMessageText, '星🌟'.repeat(160));
  assert.equal(snapshot.lastMessageAt, 1_000);
  assert.equal(snapshot.lastMessageKind, 'commentary');
});

test('new callout text beyond the shared excerpt advances its timestamp, duplicates do not', () => {
  const session = createSession('synthetic', 'claude', 'synthetic');
  const prefix = 'A'.repeat(60);
  assert.equal(setLastMessage(session, `${prefix}\nfirst\tstep`, 1_000), true);
  assert.equal(session.lastMessageText, `${prefix} first step`);
  assert.equal(setLastMessage(session, `${prefix} second step`, 2_000), true);
  assert.equal(session.lastMessage, prefix);
  assert.equal(session.lastMessageText, `${prefix} second step`);
  assert.equal(session.lastMessageAt, 2_000);
  assert.equal(setLastMessage(session, ` ${prefix}\nsecond\tstep `, 3_000), undefined);
  assert.equal(session.lastMessageAt, 2_000);
  assert.equal(setLastMessage(session, `${prefix} second step`, 4_000, 'progress'), true);
  assert.equal(session.lastMessageKind, 'progress');
  assert.equal(session.lastMessageAt, 4_000);
  assert.equal(setLastMessage(session, `${prefix} second step`, 5_000, 'progress', { deduplicate: false }), true);
  assert.equal(session.lastMessageAt, 5_000);
});

test('invalid message data leaves the excerpt and callout text together', () => {
  const session = createSession('synthetic', 'codex', 'synthetic');
  setLastMessage(session, 'Readable message', 1_000, 'unsupported-kind');
  const snapshot = toPublicSession(session, 1_000);
  assert.equal(snapshot.lastMessageKind, 'final');
  for (const [value, time] of [[null, 2_000], [' \t\n ', 2_000], ['Other message', NaN]]) {
    setLastMessage(session, value, time);
    assert.deepEqual(toPublicSession(session, 1_000), snapshot);
  }
});

for (const source of ['claude', 'codex']) {
  test(`${source} carries long messages through append, duplicate replay, and log reset`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agentarium-long-messages-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const id = '44444444-4444-4444-8444-444444444444';
    const directory = source === 'claude' ? path.join(root, 'project') : path.join(root, '2026', '09', '23');
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, source === 'claude' ? `${id}.jsonl` : `rollout-2026-09-23T00-00-00-${id}.jsonl`);
    const now = Date.now() - 10_000;
    const timestamp = (offset) => new Date(now + offset).toISOString();
    const message = (text, offset) => source === 'claude' ? {
      type: 'assistant', timestamp: timestamp(offset), sessionId: id, cwd: '/workspace/project',
      message: { content: [{ type: 'text', text }] },
    } : {
      type: 'response_item', timestamp: timestamp(offset),
      payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text }] },
    };
    const encode = (records) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';
    const prefix = '星'.repeat(60);
    await writeFile(filePath, encode([message(`${prefix} First part`, 0)]));
    const watcher = source === 'claude' ? createClaudeWatcher({ root }) : createCodexWatcher({ root });
    t.after(() => watcher.close());
    const scan = async () => {
      const sessions = await watcher.scan();
      assert.equal(sessions.length, 1);
      return sessions[0];
    };
    assert.equal((await scan()).lastMessageText, `${prefix} First part`);
    await appendFile(filePath, encode([
      message(`${prefix} Second part`, 1),
      message(` ${prefix}\nSecond\tpart `, 2),
    ]));
    const updated = await scan();
    assert.equal(updated.lastMessage, prefix);
    assert.equal(updated.lastMessageText, `${prefix} Second part`);
    assert.equal(updated.lastMessageAt, now + 1);
    assert.equal(updated.lastMessageKind, source === 'claude' ? 'final' : 'commentary');
    assert.equal((await scan()).lastMessageAt, now + 1);

    const resetRecord = source === 'claude' ? {
      type: 'user', timestamp: timestamp(3), sessionId: id, message: { content: 'New task' },
    } : {
      type: 'session_meta', timestamp: timestamp(3), payload: { id, cwd: '/workspace/project' },
    };
    await writeFile(filePath, encode([resetRecord]));
    const reset = await scan();
    assert.equal(reset.lastMessage, null);
    assert.equal(reset.lastMessageText, null);
    assert.equal(reset.lastMessageAt, null);
    assert.equal(reset.lastMessageKind, null);
    await appendFile(filePath, encode([message('Fresh response', 4)]));
    assert.equal((await scan()).lastMessageText, 'Fresh response');
  });
}
