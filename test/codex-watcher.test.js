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
