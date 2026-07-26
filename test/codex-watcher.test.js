import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCodexWatcher } from '../src/watchers/codex.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const PARENT_ID = '22222222-2222-4222-8222-222222222222';

async function scanSession(t, metadata) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentarium-codex-watcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const directory = path.join(root, '2026', '07', '26');
  await mkdir(directory, { recursive: true });
  const timestamp = new Date().toISOString();
  const record = {
    timestamp,
    type: 'session_meta',
    payload: {
      id: SESSION_ID,
      timestamp,
      cwd: 'C:\\workspace\\project',
      ...metadata,
    },
  };
  const filePath = path.join(directory, `rollout-2026-07-26T09-00-00-${SESSION_ID}.jsonl`);
  await writeFile(filePath, `${JSON.stringify(record)}\n`);

  const watcher = createCodexWatcher({ root, windowMs: 60_000 });
  const sessions = await watcher.scan(Date.now());
  assert.equal(sessions.length, 1);
  return sessions[0];
}

async function scanRecords(t, records) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentarium-codex-watcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const directory = path.join(root, '2026', '07', '26');
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `rollout-2026-07-26T09-00-00-${SESSION_ID}.jsonl`);
  await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

  const watcher = createCodexWatcher({ root, windowMs: 60_000 });
  const sessions = await watcher.scan(Date.now());
  assert.equal(sessions.length, 1);
  return sessions[0];
}

test('derives Codex parent relationships only from subagent metadata', async (t) => {
  await t.test('keeps the existing thread_spawn parent and nickname', async (subtest) => {
    const session = await scanSession(subtest, {
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: PARENT_ID,
            agent_nickname: 'Linnaeus',
          },
        },
      },
      parent_thread_id: 'ignored-direct-parent',
    });

    assert.equal(session.parentId, PARENT_ID);
    assert.equal(session.nickname, 'Linnaeus');
  });

  await t.test('uses a guardian subagent direct parent', async (subtest) => {
    const session = await scanSession(subtest, {
      source: {
        subagent: {
          other: 'guardian',
        },
      },
      parent_thread_id: PARENT_ID,
    });

    assert.equal(session.parentId, PARENT_ID);
    assert.equal(session.nickname, null);
  });

  await t.test('ignores a direct parent without a subagent source', async (subtest) => {
    const session = await scanSession(subtest, {
      source: 'vscode',
      parent_thread_id: PARENT_ID,
    });

    assert.equal(session.parentId, null);
  });
});

test('publishes Codex commentary and completed reasoning summaries as progress', async (t) => {
  const startedAt = Date.now() - 5_000;
  const record = (offset, type, payload) => ({
    timestamp: new Date(startedAt + offset).toISOString(),
    type,
    payload,
  });
  const sessionMeta = record(0, 'session_meta', {
    id: SESSION_ID,
    cwd: 'C:\\workspace\\project',
  });

  await t.test('classifies commentary separately from final messages', async (subtest) => {
    const session = await scanRecords(subtest, [
      sessionMeta,
      record(100, 'event_msg', { type: 'task_started' }),
      record(200, 'event_msg', {
        type: 'agent_message',
        phase: 'commentary',
        message: '起動状態を確認しています',
      }),
    ]);

    assert.equal(session.lastMessage, '起動状態を確認しています');
    assert.equal(session.lastMessageKind, 'commentary');
  });

  await t.test('uses only completed human-readable reasoning summaries', async (subtest) => {
    const firstSummaryAt = startedAt + 300;
    const session = await scanRecords(subtest, [
      sessionMeta,
      record(100, 'event_msg', { type: 'task_started' }),
      record(200, 'event_msg', {
        type: 'agent_reasoning',
        text: 'streaming fragment',
      }),
      record(300, 'response_item', {
        type: 'reasoning',
        summary: [
          { type: 'summary_text', text: '**Inspecting ' },
          { type: 'summary_text', text: 'the window**' },
        ],
        encrypted_content: 'must-not-be-exposed',
      }),
      record(400, 'response_item', {
        type: 'reasoning',
        summary: [
          { type: 'summary_text', text: 'Inspecting the window' },
        ],
        encrypted_content: 'different-hidden-content',
      }),
    ]);

    assert.equal(session.lastMessage, 'Inspecting the window');
    assert.equal(session.lastMessageKind, 'progress');
    assert.equal(session.lastMessageAt, firstSummaryAt);
  });

  await t.test('treats final and legacy agent messages as final', async (subtest) => {
    const session = await scanRecords(subtest, [
      sessionMeta,
      record(100, 'event_msg', {
        type: 'agent_message',
        phase: 'final',
        message: 'Completed',
      }),
      record(200, 'event_msg', {
        type: 'agent_message',
        message: 'Completed with legacy metadata',
      }),
    ]);

    assert.equal(session.lastMessage, 'Completed with legacy metadata');
    assert.equal(session.lastMessageKind, 'final');
  });
});
