import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createClaudeWatcher } from '../src/watchers/claude.js';

const LINK_ID = 'agl_0123456789abcdefghijklmn';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';

test('records a Claude parent only for an allowlisted Codex wrapper marker', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentarium-claude-watcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await mkdir(project, { recursive: true });
  const timestamp = new Date().toISOString();
  const record = {
    type: 'assistant',
    timestamp,
    sessionId: SESSION_ID,
    cwd: '/workspace/project',
    message: {
      content: [{
        type: 'tool_use',
        id: 'tool-1',
        name: 'Bash',
        input: {
          command: `bash /Users/test/.claude/skills/codex/scripts/run-codex.sh /workspace/project /tmp/prompt --agentarium-link ${LINK_ID}`,
        },
      }],
    },
  };
  const filePath = path.join(project, `${SESSION_ID}.jsonl`);
  await writeFile(filePath, `${JSON.stringify(record)}\n`);

  const watcher = createClaudeWatcher({ root, windowMs: 60_000 });
  await watcher.scan();
  const starts = watcher.getDelegationStarts();
  assert.equal(starts.length, 1);
  assert.equal(starts[0].linkId, LINK_ID);
  assert.equal(starts[0].parentKey, path.resolve(filePath).replaceAll('\\', '/'));
});

test('recovers a delegation marker from the skipped middle of a large Claude log', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentarium-claude-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await mkdir(project, { recursive: true });
  const startedAt = Date.now() - 2_000;
  const filler = (index) => JSON.stringify({
    type: 'assistant',
    timestamp: new Date(startedAt + index).toISOString(),
    sessionId: SESSION_ID,
    cwd: '/workspace/project',
    message: { content: [{ type: 'text', text: `filler-${index}-${'x'.repeat(900)}` }] },
  });
  const marker = JSON.stringify({
    type: 'assistant',
    timestamp: new Date(startedAt).toISOString(),
    sessionId: SESSION_ID,
    cwd: '/workspace/project',
    message: {
      content: [{
        type: 'tool_use',
        id: 'tool-middle',
        name: 'Bash',
        input: {
          command: `bash /Users/test/.claude/skills/codex/scripts/run-codex.sh /workspace/project /tmp/prompt --agentarium-link ${LINK_ID}`,
        },
      }],
    },
  });
  const lines = [];
  for (let index = 0; index < 180; index += 1) lines.push(filler(index));
  lines.push(marker);
  for (let index = 180; index < 620; index += 1) lines.push(filler(index));
  const filePath = path.join(project, `${SESSION_ID}.jsonl`);
  await writeFile(filePath, `${lines.join('\n')}\n`);

  const watcher = createClaudeWatcher({ root, windowMs: 60_000 });
  await watcher.scan();
  assert.equal(watcher.getDelegationStarts().length, 0);
  await watcher.recoverDelegationStarts([{
    version: 1,
    linkId: LINK_ID,
    childSource: 'codex',
    childSessionId: '33333333-3333-4333-8333-333333333333',
    status: 'running',
    startedAt,
    updatedAt: startedAt + 500,
    expiresAt: startedAt + 60_000,
  }]);
  const starts = watcher.getDelegationStarts();
  assert.equal(starts.length, 1);
  assert.equal(starts[0].linkId, LINK_ID);
  assert.equal(starts[0].parentKey, path.resolve(filePath).replaceAll('\\', '/'));
});
