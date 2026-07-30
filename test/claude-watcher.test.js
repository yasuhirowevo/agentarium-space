import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createClaudeWatcher } from '../src/watchers/claude.js';

const SESSION_ID = '33333333-3333-4333-8333-333333333333';

function assistantRecord(timestamp, content, stopReason, extra = {}) {
  return {
    type: 'assistant',
    timestamp: new Date(timestamp).toISOString(),
    sessionId: SESSION_ID,
    cwd: 'C:\\workspace\\project',
    message: {
      id: extra.messageId ?? `msg-${timestamp}`,
      content,
      ...(stopReason === undefined ? {} : { stop_reason: stopReason }),
    },
    ...extra.record,
  };
}

async function scanRecords(t, records, now = Date.now()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentarium-claude-watcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const directory = path.join(root, 'project');
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${SESSION_ID}.jsonl`);
  await writeFile(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

  const watcher = createClaudeWatcher({ root, windowMs: 60_000 });
  const sessions = await watcher.scan(now);
  assert.equal(sessions.length, 1);
  return sessions[0];
}

test('publishes Claude tool-bound text as commentary', async (t) => {
  const now = Date.now();

  await t.test('classifies tool_use text as commentary', async (subtest) => {
    const session = await scanRecords(subtest, [
      assistantRecord(now - 1_000, [{ type: 'text', text: '設定を確認します' }], 'tool_use'),
    ], now);

    assert.equal(session.lastMessage, '設定を確認します');
    assert.equal(session.lastMessageKind, 'commentary');
    assert.equal(session.status, 'thinking');
  });

  await t.test('keeps end_turn and unknown stop reasons final', async (subtest) => {
    for (const stopReason of ['end_turn', 'max_tokens', null, undefined]) {
      const session = await scanRecords(subtest, [
        assistantRecord(now - 1_000, [{ type: 'text', text: '確認が完了しました' }], stopReason),
      ], now);

      assert.equal(session.lastMessageKind, 'final');
    }
  });

  await t.test('preserves commentary when its tool_use arrives in a separate record', async (subtest) => {
    const commentaryAt = now - 2_000;
    const messageId = 'msg-with-tool';
    const session = await scanRecords(subtest, [
      assistantRecord(
        commentaryAt,
        [{ type: 'text', text: 'ファイルを読みます' }],
        'tool_use',
        { messageId },
      ),
      assistantRecord(now - 1_000, [{
        type: 'tool_use',
        id: 'toolu-read',
        name: 'Read',
        input: { file_path: 'C:\\workspace\\project\\README.md' },
      }], 'tool_use', { messageId }),
    ], now);

    assert.equal(session.lastMessage, 'ファイルを読みます');
    assert.equal(session.lastMessageAt, commentaryAt);
    assert.equal(session.lastMessageKind, 'commentary');
    assert.equal(session.status, 'tool');
  });

  await t.test('keeps older commentary in thinking while final text becomes waiting', async (subtest) => {
    const commentary = await scanRecords(subtest, [
      assistantRecord(now - 30_000, [{ type: 'text', text: '追加調査を続けます' }], 'tool_use'),
    ], now);
    const final = await scanRecords(subtest, [
      assistantRecord(now - 30_000, [{ type: 'text', text: '調査は完了です' }], 'end_turn'),
    ], now);

    assert.equal(commentary.status, 'thinking');
    assert.equal(final.status, 'waiting');
  });

  await t.test('never publishes thinking or sidechain text', async (subtest) => {
    const session = await scanRecords(subtest, [
      assistantRecord(now - 3_000, [{ type: 'text', text: '公開してよい発話' }]),
      assistantRecord(now - 2_000, [{ type: 'thinking', thinking: '非公開の思考' }], 'tool_use'),
      assistantRecord(
        now - 1_000,
        [{ type: 'text', text: 'sidechain の発話' }],
        'tool_use',
        { record: { isSidechain: true } },
      ),
    ], now);

    assert.equal(session.lastMessage, '公開してよい発話');
    assert.equal(session.lastMessageKind, 'final');
  });

  await t.test('does not advance the timestamp for repeated commentary', async (subtest) => {
    const firstAt = now - 2_000;
    const session = await scanRecords(subtest, [
      assistantRecord(firstAt, [{ type: 'text', text: '同じ進捗です' }], 'tool_use'),
      assistantRecord(now - 1_000, [{ type: 'text', text: '同じ進捗です' }], 'tool_use'),
    ], now);

    assert.equal(session.lastMessageAt, firstAt);
    assert.equal(session.lastMessageKind, 'commentary');
  });

  await t.test('classifies commentary found in a large log head', async (subtest) => {
    const session = await scanRecords(subtest, [
      assistantRecord(now - 1_000, [{ type: 'text', text: '先頭領域の途中発話' }], 'tool_use'),
      {
        type: 'queue-operation',
        timestamp: new Date(now - 500).toISOString(),
        padding: 'x'.repeat(300 * 1024),
      },
      {
        type: 'queue-operation',
        timestamp: new Date(now).toISOString(),
      },
    ], now);

    assert.equal(session.lastMessage, '先頭領域の途中発話');
    assert.equal(session.lastMessageKind, 'commentary');
  });
});
