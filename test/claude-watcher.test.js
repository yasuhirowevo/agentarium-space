import assert from 'node:assert/strict';
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createClaudeWatcher } from '../src/watchers/claude.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function record(time, type, message, extra = {}) {
  return {
    type,
    timestamp: new Date(time).toISOString(),
    sessionId: SESSION_ID,
    cwd: '/workspace/project',
    message,
    ...extra,
  };
}

function assistant(time, id, tokens, content = [{ type: 'text', text: 'Finished checking.' }]) {
  return record(time, 'assistant', {
    id,
    model: 'example-model',
    usage: {
      input_tokens: 10_000,
      cache_creation_input_tokens: 20_000,
      cache_read_input_tokens: 100_000,
      output_tokens: tokens,
    },
    content,
  });
}

function agentCall(time, id = 'tool-agent', name = 'Agent') {
  return assistant(time, `message-${id}`, 20, [{
    type: 'tool_use',
    id,
    name,
    input: { description: 'Check fixtures', subagent_type: 'worker' },
  }]);
}

function agentResult(time, id = 'tool-agent', result = {}) {
  return record(time, 'user', {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: 'Launch result' }],
  }, { toolUseResult: result });
}

function notification(time, agentId, status = 'completed') {
  return record(time, 'user', {
    role: 'user',
    content: `<task-notification>\n<task-id>${agentId}</task-id>\n<status>${status}</status>\n<summary>Task update</summary>\n<result>Completed checks.</result>\n</task-notification>`,
  }, { origin: { kind: 'task-notification' }, promptSource: 'sdk' });
}

const encode = (records) => `${records.map((entry) => JSON.stringify(entry)).join('\n')}\n`;

async function fixture(t, records) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentarium-claude-watcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  await mkdir(project);
  const filePath = path.join(project, `${SESSION_ID}.jsonl`);
  await writeFile(filePath, encode(records));
  const watcher = createClaudeWatcher({ root });
  t.after(() => watcher.close());
  return {
    watcher,
    filePath,
    append: (entries) => appendFile(filePath, encode(entries)),
    async scan(now = Date.now()) {
      const sessions = await watcher.scan(now);
      assert.equal(sessions.length, 1);
      return sessions[0];
    },
  };
}

test('counts one output usage per message across blocks, updates, and repeated scans', async (t) => {
  const now = Date.now() - 30_000;
  const f = await fixture(t, [
    { ...assistant(now, 'message-one', 220), apiBlockIndex: 0 },
    { ...assistant(now + 1, 'message-one', 220), apiBlockIndex: 1 },
    { ...assistant(now + 2, 'message-one', 220), apiBlockIndex: 2 },
  ]);
  let session = await f.scan();
  assert.equal(session.outputTokensTotal, 220);
  assert.equal(session.contextUsedTokens, 130_000);
  assert.equal(session.contextWindowTokens, null);
  assert.equal((await f.scan()).outputTokensTotal, 220);

  await f.append([
    assistant(now + 3, 'message-one', 250),
    assistant(now + 4, 'message-one', 230),
    assistant(now + 5, 'message-two', 40),
    assistant(now + 6, 'message-two', 40),
  ]);
  session = await f.scan();
  assert.equal(session.outputTokensTotal, 290);
});

test('preserves id-less usage and leaves missing usage unknown', async (t) => {
  const now = Date.now() - 30_000;
  const f = await fixture(t, [record(now, 'assistant', {
    content: [{ type: 'text', text: 'No usage available.' }],
  })]);
  assert.equal((await f.scan()).outputTokensTotal, null);
  await f.append([
    assistant(now + 1, undefined, 12),
    assistant(now + 2, undefined, 8),
  ]);
  assert.equal((await f.scan()).outputTokensTotal, 20);
});

test('keeps sidechain usage and model out of the main session', async (t) => {
  const now = Date.now() - 30_000;
  const child = assistant(now + 1, 'message-one', 900);
  child.isSidechain = true;
  child.message.model = 'child-model';
  child.message.usage.input_tokens = 500_000;
  child.message.content = [{ type: 'text', text: 'Child response.' }];
  const f = await fixture(t, [assistant(now, 'message-one', 40), child]);
  const session = await f.scan();
  assert.equal(session.outputTokensTotal, 40);
  assert.equal(session.contextUsedTokens, 130_000);
  assert.equal(session.contextWindowTokens, null);
  assert.equal(session.model, 'example-model');
  assert.equal(session.lastMessage, 'Finished checking.');
});

test('resets message usage bookkeeping after log truncation', async (t) => {
  const now = Date.now() - 30_000;
  const f = await fixture(t, [assistant(now, 'message-one', 80), assistant(now + 1, 'message-two', 120)]);
  assert.equal((await f.scan()).outputTokensTotal, 200);
  await writeFile(f.filePath, encode([assistant(now + 2, 'message-one', 30)]));
  assert.equal((await f.scan()).outputTokensTotal, 30);
  await f.append([assistant(now + 3, 'message-one', 50)]);
  assert.equal((await f.scan()).outputTokensTotal, 50);
});

test('retains async Agent and Task children after launch and parent final text', async (t) => {
  for (const name of ['Agent', 'Task']) {
    await t.test(name, async (subtest) => {
      const now = Date.now() - 30_000;
      const result = name === 'Agent'
        ? { isAsync: true, agentId: 'agent-one' }
        : { status: 'async_launched', agentId: 'agent-one' };
      const f = await fixture(subtest, [
        agentCall(now, 'tool-agent', name),
        agentResult(now + 1, 'tool-agent', result),
        assistant(now + 2, 'parent-final', 50),
      ]);
      let session = await f.scan(now + 70_000);
      assert.equal(session.status, 'waiting');
      assert.equal(session.activity, null);
      assert.equal(session.subAgents.length, 1);
      assert.equal(session.subAgents[0].status, 'running');
      assert.ok(session.recentEvents.some((event) => event.endsWith('started')));
      assert.ok(!session.recentEvents.some((event) => event.endsWith('done')));

      await f.append([notification(now + 80_000, 'agent-one')]);
      session = await f.scan(now + 80_000);
      assert.equal(session.subAgents[0].status, 'done');
      assert.equal(session.status, 'waiting');
      assert.equal(session.lastActivity, now + 2);
      assert.equal(session.lastMessage, 'Finished checking.');
      assert.equal(session.title, SESSION_ID.slice(0, 8));
      assert.equal((await f.scan(now + 140_000)).subAgents.length, 0);
    });
  }
});

test('only completes the matching async child and recognizes failure and stop notifications', async (t) => {
  const now = Date.now() - 30_000;
  const f = await fixture(t, [
    agentCall(now, 'tool-one'),
    agentResult(now + 1, 'tool-one', { isAsync: true, agentId: 'agent-one' }),
    agentCall(now + 2, 'tool-two'),
    agentResult(now + 3, 'tool-two', { isAsync: true, agentId: 'agent-two' }),
    assistant(now + 4, 'parent-final', 10),
    notification(now + 5, 'unrelated-agent'),
    notification(now + 6, 'agent-one', 'running'),
    notification(now + 7, 'agent-one', 'failed'),
  ]);
  let session = await f.scan();
  assert.deepEqual(session.subAgents.map(({ status }) => status), ['done', 'running']);
  await f.append([notification(now + 8, 'agent-two', 'stopped')]);
  session = await f.scan();
  assert.deepEqual(session.subAgents.map(({ status }) => status), ['done', 'done']);
  assert.equal(session.status, 'waiting');
});

test('keeps synchronous Agent completion and ignores task-like result text', async (t) => {
  const now = Date.now() - 30_000;
  const f = await fixture(t, [
    agentCall(now),
    agentResult(now + 1, 'tool-agent', { status: 'completed', agentId: 'agent-one' }),
    assistant(now + 2, 'parent-final', 10),
  ]);
  const session = await f.scan();
  assert.equal(session.subAgents[0].status, 'done');
  assert.ok(session.recentEvents.some((event) => event.endsWith('done')));

  const g = await fixture(t, [
    agentCall(now),
    agentResult(now + 1, 'tool-agent', { status: 'async_launched', agentId: 'agent-one' }),
    assistant(now + 2, 'parent-final', 10),
    record(now + 3, 'user', {
      content: '<task-notification><task-id>unrelated-agent</task-id><status>running</status><summary>Update</summary><result><task-id>agent-one</task-id><status>completed</status></result></task-notification>',
    }, { origin: { kind: 'task-notification' } }),
  ]);
  assert.equal((await g.scan()).subAgents[0].status, 'running');
});

test('recovers a tail async launch without its call and deduplicates head and tail usage', async (t) => {
  const now = Date.now() - 30_000;
  const f = await fixture(t, [
    agentCall(now),
    assistant(now + 2, 'split-message', 100),
    { type: 'unknown-padding', data: 'x'.repeat(400_000) },
    agentResult(now + 3, 'tool-agent', {
      status: 'async_launched', agentId: 'agent-one', description: 'Check fixtures',
    }),
    assistant(now + 3, 'split-message', 100),
    assistant(now + 4, 'parent-final', 10),
    notification(now + 5, 'agent-one'),
  ]);
  const session = await f.scan();
  assert.equal(session.outputTokensTotal, 130);
  assert.equal(session.subAgents[0].status, 'done');
  assert.equal(session.status, 'waiting');
  assert.equal(session.activity, null);
  assert.equal(session.contextWindowTokens, null);
  assert.equal(session.lastMessage, 'Finished checking.');
});


test('does not resurrect old head agents whose completion is in the unread middle', async (t) => {
  for (const background of [false, true]) {
    await t.test(background ? 'background' : 'synchronous', async (subtest) => {
      const now = Date.now() - 30_000;
      const records = [agentCall(now)];
      if (background) {
        records.push(agentResult(now + 1, 'tool-agent', {
          status: 'async_launched', agentId: 'agent-one', description: 'Old checks',
        }));
      }
      records.push(
        { type: 'unknown-padding', data: 'x'.repeat(150_000) },
        background ? notification(now + 2, 'agent-one') : agentResult(now + 2),
        { type: 'unknown-padding', data: 'x'.repeat(300_000) },
        assistant(now + 3, 'recent-final', 10),
      );
      const f = await fixture(subtest, records);
      const session = await f.scan();
      assert.deepEqual(session.subAgents, []);
      assert.equal(session.status, 'waiting');
      assert.equal(session.activity, null);
    });
  }
});
