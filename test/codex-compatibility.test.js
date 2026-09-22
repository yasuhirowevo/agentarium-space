import assert from 'node:assert/strict';
import fs from 'node:fs';
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCodexWatcher } from '../src/watchers/codex.js';

const SESSION_ID = '33333333-3333-4333-8333-333333333333';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentarium-codex-compatibility-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '2026', '09', '01');
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `rollout-2026-09-01T00-00-00-${SESSION_ID}.jsonl`);
  const watcher = createCodexWatcher({ root, windowMs: 60_000 });
  const startedAt = Date.now() - 10_000;
  let offset = 0;
  const record = (type, payload) => ({
    timestamp: new Date(startedAt + offset++).toISOString(), type, payload,
  });
  const encode = (records) => records.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
  await writeFile(filePath, encode([record('session_meta', { id: SESSION_ID, cwd: '/workspace/project' })]));
  return {
    filePath,
    record,
    event: (payload) => record('event_msg', payload),
    response: (payload) => record('response_item', payload),
    append: (records) => appendFile(filePath, encode(records)),
    replace: (records) => writeFile(filePath, encode(records)),
    scan: async () => {
      const sessions = await watcher.scan();
      assert.equal(sessions.length, 1);
      return sessions[0];
    },
  };
}

const assistant = (text, phase = 'commentary', extra = {}) => ({
  type: 'message', role: 'assistant', phase,
  content: [{ type: 'output_text', text }], ...extra,
});
const completed = (type, text, phase) => ({
  type: 'item_completed', item: {
    type, id: 'synthetic-message', phase,
    content: [{ type: type === 'AgentMessage' ? 'Text' : 'text', text }],
  },
});
const usage = (output, input = 1_000, lastOutput = output) => ({
  type: 'token_count', info: {
    total_token_usage: { output_tokens: output, input_tokens: input, total_tokens: input + output },
    last_token_usage: { output_tokens: lastOutput, input_tokens: input },
    model_context_window: 256_000,
  },
});

test('reads modern user events and assistant response messages without exposing context', async (t) => {
  const f = await fixture(t);
  await f.append([
    f.event({ type: 'task_started', turn_id: 'turn-1' }),
    f.response({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Embedded context' }] }),
    f.event(completed('UserMessage', 'Check the project')),
    f.response(assistant('Checking the project')),
  ]);
  let session = await f.scan();
  assert.equal(session.title, 'Check the project');
  assert.equal(session.lastMessage, 'Checking the project');
  assert.equal(session.lastMessageKind, 'commentary');
  const messageAt = session.lastMessageAt;
  await f.append([
    f.response(assistant('System content', 'final_answer', { role: 'system' })),
    f.response(assistant('Developer content', 'final_answer', { role: 'developer' })),
    f.response(assistant('Private analysis', null, { channel: 'analysis' })),
    f.response(assistant('Tool command', 'commentary', { recipient: 'functions.exec' })),
    f.response(assistant('Tool command', 'commentary', { recipient_name: 'functions.exec' })),
    f.response(assistant('Unknown phase', 'internal')),
    f.response(assistant('User context', 'final_answer', { role: 'user' })),
    f.event({ type: 'item_completed', item: { type: 'UnknownMessage', content: [{ type: 'Text', text: 'Unknown' }] } }),
    f.event({ type: 'item_completed', item: { type: 'AgentMessage', content: [null, { type: 'Audio', text: 'Unsupported' }] } }),
    null,
    f.record('unknown_record', { type: 'unknown' }),
  ]);
  session = await f.scan();
  assert.equal(session.lastMessage, 'Checking the project');
  assert.equal(session.lastMessageAt, messageAt);
  assert.equal(session.title, 'Check the project');
});

test('deduplicates modern and legacy messages and protects the final answer', async (t) => {
  const f = await fixture(t);
  const first = f.response(assistant('Checking inputs'));
  await f.append([
    f.event({ type: 'task_started', turn_id: 'turn-1' }),
    f.event(completed('UserMessage', 'Inspect inputs')),
    f.event({ type: 'user_message', message: 'Inspect inputs' }),
    first,
    f.event(completed('AgentMessage', 'Checking inputs', 'commentary')),
    f.event({ type: 'agent_message', phase: 'commentary', message: 'Checking inputs' }),
  ]);
  let session = await f.scan();
  assert.equal(session.lastMessageAt, Date.parse(first.timestamp));
  assert.equal(session.recentEvents.filter((event) => event.endsWith('User message')).length, 1);
  const final = f.event(completed('AgentMessage', 'Checks completed', 'final_answer'));
  await f.append([
    f.response(assistant('Checking output')),
    f.event(completed('AgentMessage', 'Checking inputs', 'commentary')),
  ]);
  session = await f.scan();
  assert.equal(session.lastMessage, 'Checking output');
  await f.append([
    final,
    f.response(assistant('Checks completed', 'final_answer')),
    f.event({ type: 'agent_message', message: 'Checks completed' }),
    f.response(assistant('Late commentary')),
    f.response({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Trailing summary' }] }),
    f.event({ type: 'task_complete', turn_id: 'turn-1' }),
  ]);
  session = await f.scan();
  assert.equal(session.lastMessage, 'Checks completed');
  assert.equal(session.lastMessageKind, 'final');
  assert.equal(session.lastMessageAt, Date.parse(final.timestamp));
  await f.append([
    f.event({ type: 'task_started', turn_id: 'turn-2' }),
    f.response(assistant('Checking inputs')),
  ]);
  session = await f.scan();
  assert.equal(session.lastMessage, 'Checking inputs');
  assert.equal(session.lastMessageKind, 'commentary');
});

test('turn abort clears tools while stale termination events preserve the active turn', async (t) => {
  const f = await fixture(t);
  await f.append([
    f.event({ type: 'task_started', turn_id: 'turn-2' }),
    f.response({ type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: '{"cmd":"pwd"}' }),
    f.event({ type: 'turn_aborted', turn_id: 'turn-1' }),
    f.event({ type: 'task_complete', turn_id: 'turn-1' }),
  ]);
  let session = await f.scan();
  assert.equal(session.status, 'tool');
  assert.equal(session.activity, 'exec_command');
  await f.append([f.event({ type: 'turn_aborted', turn_id: 'turn-2' })]);
  session = await f.scan();
  assert.equal(session.status, 'waiting');
  assert.equal(session.activity, null);
  assert.equal(session.activityDetail, null);
  assert.match(session.recentEvents.at(-1), /Task aborted$/);
  await f.append([
    f.event({ type: 'task_started' }),
    f.response({ type: 'custom_tool_call', call_id: 'call-2', name: 'exec', input: 'pwd' }),
    f.event({ type: 'turn_aborted' }),
  ]);
  assert.equal((await f.scan()).status, 'waiting');
});

test('counts cumulative output once through duplicates, append, and supported counter resets', async (t) => {
  const f = await fixture(t);
  await f.append([
    f.event({ type: 'task_started', turn_id: 'turn-1' }),
    f.event(usage(100)), f.event(usage(100)), f.event(usage(140, 2_000, 40)),
    f.event(usage(100)), // Regressive notification within a turn is not a counter reset.
  ]);
  let session = await f.scan();
  assert.equal(session.outputTokensTotal, 140);
  assert.equal(session.contextUsedTokens, 2_000);
  assert.equal(session.contextWindowTokens, 256_000);
  await f.append([f.event(usage(140, 2_000, 40)), f.event(usage(170, 3_000, 30))]);
  session = await f.scan();
  assert.equal(session.outputTokensTotal, 170);
  assert.equal(session.contextUsedTokens, 3_000);
  assert.equal((await f.scan()).outputTokensTotal, 170);
  await f.append([
    f.event({ type: 'task_complete', turn_id: 'turn-1' }),
    f.event({ type: 'task_started', turn_id: 'turn-2' }),
    f.event(usage(20, 500)), f.event(usage(20, 500)), f.event(usage(35, 1_000, 15)),
  ]);
  assert.equal((await f.scan()).outputTokensTotal, 205);
  // Truncating a file starts a fresh session and accounting baseline.
  await f.replace([f.event(usage(7, 100)), f.event(usage(7, 100))]);
  assert.equal((await f.scan()).outputTokensTotal, 7);
});

test('keeps legacy usage support and unknown usage values remain unknown', async (t) => {
  const f = await fixture(t);
  await f.append([f.event({ type: 'token_count', info: null })]);
  assert.equal((await f.scan()).outputTokensTotal, null);
  await f.append([
    f.event({ type: 'token_count', info: { last_token_usage: { output_tokens: 9, input_tokens: 100 } } }),
    f.event({ type: 'token_count', info: { last_token_usage: { output_tokens: 11, input_tokens: 200 } } }),
  ]);
  assert.equal((await f.scan()).outputTokensTotal, 20);
});

test('recovers latest turn metadata beyond the head without replaying old activity', async (t) => {
  const f = await fixture(t);
  await f.append([
    f.record('turn_context', { model: 'old-model', cwd: '/workspace/old', approval_policy: 'never' }),
    f.record('unknown_record', { padding: 'x'.repeat(150_000) }),
    f.record('turn_context', {
      model: 'current-model', cwd: '/workspace/current', approval_policy: 'on-request',
      sandbox_policy: { type: 'workspace-write' }, developer_instructions: 'x'.repeat(150_000),
    }),
    f.response({ type: 'function_call', call_id: 'historical-call', name: 'historical-tool' }),
    f.event(usage(123, 1_000)),
    f.event({ type: 'task_started', turn_id: 'historical-turn' }),
    f.record('unknown_record', { padding: 'x'.repeat(300_000) }),
    f.response(assistant('Recent response', 'final_answer')),
  ]);
  const session = await f.scan();
  assert.equal(session.model, 'current-model');
  assert.equal(session.cwd, '/workspace/current');
  assert.equal(session.approvalPolicy, 'on-request');
  assert.equal(session.writeAccess, 'write');
  assert.equal(session.outputTokensTotal, null);
  assert.equal(session.toolCallsTotal, 0);
  assert.equal(session.status, 'waiting');
  assert.equal(session.lastMessage, 'Recent response');
});

test('tail context takes precedence and old head finals do not block current commentary', async (t) => {
  const f = await fixture(t);
  await f.append([
    f.record('turn_context', { model: 'old-model' }),
    f.response(assistant('Previous turn completed', 'final_answer')),
    f.record('unknown_record', { padding: 'x'.repeat(400_000) }),
    f.record('turn_context', { model: 'tail-model', cwd: '/workspace/tail' }),
    f.response(assistant('Current turn in progress')),
  ]);
  const session = await f.scan();
  assert.equal(session.model, 'tail-model');
  assert.equal(session.lastMessage, 'Current turn in progress');
  assert.equal(session.lastMessageKind, 'commentary');
});

for (const format of ['legacy', 'response', 'completed']) {
  test(`current tail speech uses its own timestamp when the head has identical text (${format})`, async (t) => {
    const f = await fixture(t);
    const message = () => {
      if (format === 'legacy') return f.event({ type: 'agent_message', message: 'Checking inputs', phase: 'commentary' });
      if (format === 'completed') return f.event(completed('AgentMessage', 'Checking inputs', 'commentary'));
      return f.response(assistant('Checking inputs'));
    };
    await f.append([
      f.event({ type: 'task_started', turn_id: 'old-turn' }), message(),
      f.record('unknown_record', { padding: 'x'.repeat(150_000) }),
      f.event({ type: 'task_started', turn_id: 'current-turn' }),
      f.record('unknown_record', { padding: 'x'.repeat(300_000) }),
    ]);
    const current = message();
    await f.append([current]);
    const session = await f.scan();
    assert.equal(session.lastMessage, 'Checking inputs');
    assert.equal(session.lastMessageAt, Date.parse(current.timestamp));
  });

  test(`head message dedup does not suppress current tail messages (${format})`, async (t) => {
    const f = await fixture(t);
    const message = (text, phase) => {
      if (format === 'legacy') return f.event({ type: 'agent_message', message: text, phase });
      if (format === 'completed') return f.event(completed('AgentMessage', text, phase));
      return f.response(assistant(text, phase));
    };
    const currentText = 'Checking project compatibility';
    await f.append([
      f.event({ type: 'task_started', turn_id: 'old-turn' }),
      message(currentText, 'commentary'),
      message('Previous turn completed', 'final_answer'),
      f.record('unknown_record', { padding: 'x'.repeat(150_000) }),
      f.event({ type: 'task_started', turn_id: 'current-turn' }),
      f.record('unknown_record', { padding: 'x'.repeat(300_000) }),
      message(currentText, 'commentary'),
    ]);
    const session = await f.scan();
    assert.equal(session.lastMessage, currentText);
    assert.equal(session.lastMessageKind, 'commentary');
  });
}

test('distinct messages sharing an excerpt still update the current speech', async (t) => {
  const f = await fixture(t);
  const prefix = 'Checking the current project and its compatibility with logs. ';
  const records = [
    f.event({ type: 'task_started', turn_id: 'turn-1' }),
    f.response(assistant(prefix + 'First check.')),
  ];
  const current = f.response(assistant(prefix + 'Last check.'));
  await f.append([...records, current]);
  const session = await f.scan();
  assert.equal(session.lastMessage, 'Checking the current project and its compatibility with logs');
  assert.equal(session.lastMessageAt, Date.parse(current.timestamp));
});

for (const format of ['response', 'completed']) {
  test(`distinct ${format} message IDs can repeat text without replaying older IDs`, async (t) => {
    const f = await fixture(t);
    const message = (id, text) => format === 'response'
      ? f.response(assistant(text, 'commentary', { id }))
      : f.event({ type: 'item_completed', item: { ...completed('AgentMessage', text, 'commentary').item, id } });
    await f.append([
      f.event({ type: 'task_started', turn_id: 'turn-1' }),
      message('message-1', 'Running tests'),
      message('message-2', 'Fixing test failures'),
    ]);
    const repeated = message('message-3', 'Running tests');
    await f.append([repeated]);
    let session = await f.scan();
    assert.equal(session.lastMessage, 'Running tests');
    assert.equal(session.lastMessageAt, Date.parse(repeated.timestamp));
    const latest = message('message-4', 'Checking results');
    await f.append([latest, message('message-1', 'Running tests'), message('message-3', 'Running tests')]);
    session = await f.scan();
    assert.equal(session.lastMessage, 'Checking results');
    assert.equal(session.lastMessageAt, Date.parse(latest.timestamp));
  });
}

for (const idFirst of [false, true]) {
  test(`new turn speech updates once with ID ${idFirst ? 'first' : 'last'}`, async (t) => {
    const f = await fixture(t);
    const message = (id) => f.event({ type: 'item_completed', item: {
      ...completed('AgentMessage', 'Completed', 'final_answer').item, id,
    } });
    for (const turn of ['turn-1', 'turn-2']) {
      await f.append([f.event({ type: 'task_started', turn_id: turn })]);
      const first = idFirst ? message(turn) : f.response(assistant('Completed', 'final_answer'));
      await f.append([first]);
      const duplicate = idFirst ? f.response(assistant('Completed', 'final_answer')) : message(turn);
      await f.append([duplicate, message(turn)]);
      const session = await f.scan();
      assert.equal(session.lastMessageAt, Date.parse(first.timestamp));
      await f.append([f.event({ type: 'task_complete', turn_id: turn })]);
    }
  });

  test(`matches ID-less and identified messages with ID ${idFirst ? 'first' : 'last'}`, async (t) => {
    const f = await fixture(t);
    const text = 'Running tests';
    const first = idFirst
      ? f.event(completed('AgentMessage', text, 'commentary'))
      : f.response(assistant(text));
    const duplicate = idFirst
      ? f.response(assistant(text))
      : f.event(completed('AgentMessage', text, 'commentary'));
    await f.append([f.event({ type: 'task_started', turn_id: 'turn-1' }), first, duplicate]);
    assert.equal((await f.scan()).lastMessageAt, Date.parse(first.timestamp));
    const repeated = f.event({ type: 'item_completed', item: {
      ...completed('AgentMessage', text, 'commentary').item, id: 'another-message',
    } });
    await f.append([repeated]);
    assert.equal((await f.scan()).lastMessageAt, Date.parse(repeated.timestamp));
  });
}

test('repeated starts preserve the final answer and do not reopen a completed turn', async (t) => {
  const f = await fixture(t);
  const final = f.response(assistant('Checks completed', 'final_answer'));
  await f.append([
    f.event({ type: 'task_started', turn_id: 'turn-1' }), final,
    f.event({ type: 'task_started', turn_id: 'turn-1' }),
    f.response(assistant('Late commentary')),
  ]);
  let session = await f.scan();
  assert.equal(session.lastMessage, 'Checks completed');
  assert.equal(session.lastMessageAt, Date.parse(final.timestamp));
  assert.equal(session.recentEvents.filter((event) => event.endsWith('Task started')).length, 1);
  await f.append([
    f.event({ type: 'task_complete', turn_id: 'turn-1' }),
    f.event({ type: 'task_started', turn_id: 'turn-1' }),
    f.response(assistant('More late commentary')),
  ]);
  session = await f.scan();
  assert.equal(session.status, 'waiting');
  assert.equal(session.lastMessage, 'Checks completed');
  await f.append([
    f.record('turn_context', { turn_id: 'turn-2' }),
    f.event({ type: 'task_started', turn_id: 'turn-2' }),
    f.response(assistant('New turn commentary')),
  ]);
  session = await f.scan();
  assert.equal(session.lastMessage, 'New turn commentary');
  assert.equal(session.lastMessageKind, 'commentary');
});

test('a later message ID updates legacy same-text speech without requiring an earlier ID', async (t) => {
  const f = await fixture(t);
  const first = f.event({ type: 'agent_message', message: 'Completed' });
  await f.append([
    f.event({ type: 'task_started', turn_id: 'turn-1' }), first,
    f.event({ type: 'task_complete', turn_id: 'turn-1' }),
    f.event({ type: 'task_started', turn_id: 'turn-2' }),
  ]);
  const current = f.event({ type: 'agent_message', message: 'Completed' });
  await f.append([current]);
  assert.equal((await f.scan()).lastMessageAt, Date.parse(first.timestamp));
  await f.append([f.event(completed('AgentMessage', 'Completed', 'final_answer'))]);
  assert.equal((await f.scan()).lastMessageAt, Date.parse(current.timestamp));
});

test('a delayed alias does not replace progress shown after suppressed speech', async (t) => {
  const f = await fixture(t);
  await f.append([
    f.event({ type: 'task_started', turn_id: 'turn-1' }),
    f.response(assistant('Checking inputs')),
    f.event({ type: 'task_complete', turn_id: 'turn-1' }),
    f.event({ type: 'task_started', turn_id: 'turn-2' }),
    f.response(assistant('Checking inputs')),
  ]);
  const progress = f.response({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Inspecting results' }] });
  await f.append([progress, f.event(completed('AgentMessage', 'Checking inputs', 'commentary'))]);
  const session = await f.scan();
  assert.equal(session.lastMessage, 'Inspecting results');
  assert.equal(session.lastMessageKind, 'progress');
  assert.equal(session.lastMessageAt, Date.parse(progress.timestamp));
});

test('a past start and abort cannot replace the current turn or clear its tools', async (t) => {
  const f = await fixture(t);
  await f.append([
    f.event({ type: 'task_started', turn_id: 'previous-turn' }),
    f.event({ type: 'task_complete', turn_id: 'previous-turn' }),
    f.event({ type: 'task_started', turn_id: 'current-turn' }),
    f.response({ type: 'function_call', call_id: 'current-call', name: 'exec_command' }),
    f.event({ type: 'task_started', turn_id: 'previous-turn' }),
    f.event({ type: 'turn_aborted', turn_id: 'previous-turn' }),
  ]);
  const session = await f.scan();
  assert.equal(session.status, 'tool');
  assert.equal(session.activity, 'exec_command');
  assert.equal(session.recentEvents.filter((event) => event.endsWith('Task started')).length, 2);
});

for (const termination of ['task_complete', 'turn_aborted']) {
  for (const recoverContext of [false, true]) {
    test(`an observed ${termination} prevents reopening when the start was skipped (context ${recoverContext})`, async (t) => {
      const f = await fixture(t);
      await f.append([
        f.record('unknown_record', { padding: 'x'.repeat(150_000) }),
        f.event({ type: 'task_started', turn_id: 'previous-turn' }),
        ...(recoverContext ? [f.record('turn_context', { turn_id: 'previous-turn' })] : []),
        f.record('unknown_record', { padding: 'x'.repeat(300_000) }),
        f.response(assistant('Finished', 'final_answer')),
        f.event({ type: termination, turn_id: 'previous-turn' }),
      ]);
      assert.equal((await f.scan()).status, 'waiting');
      await f.append([
        f.event({ type: 'task_started', turn_id: 'previous-turn' }),
        f.response(assistant('Late commentary')),
      ]);
      let session = await f.scan();
      assert.equal(session.status, 'waiting');
      assert.equal(session.lastMessage, 'Finished');
      await f.append([
        f.event({ type: 'task_started', turn_id: 'current-turn' }),
        f.response(assistant('New work')),
      ]);
      session = await f.scan();
      assert.equal(session.lastMessage, 'New work');
      assert.equal(session.lastMessageKind, 'commentary');
    });
  }
}

test('a new start resets message identities even when its turn context arrived first', async (t) => {
  const f = await fixture(t);
  await f.append([
    f.event({ type: 'task_started', turn_id: 'turn-1' }),
    f.event(completed('AgentMessage', 'Checking inputs', 'commentary')),
    f.record('turn_context', { turn_id: 'turn-2' }),
    f.event({ type: 'task_started', turn_id: 'turn-2' }),
  ]);
  const current = f.event(completed('AgentMessage', 'Checking inputs', 'commentary'));
  await f.append([current]);
  assert.equal((await f.scan()).lastMessageAt, Date.parse(current.timestamp));
});

for (const location of ['tail', 'recovered']) {
  test(`uses latest turn context identity to reject stale termination (${location})`, async (t) => {
    const f = await fixture(t);
    await f.append([
      f.record('turn_context', { turn_id: 'previous-turn', model: 'previous-model' }),
      f.record('unknown_record', { padding: 'x'.repeat(150_000) }),
      f.event({ type: 'task_started', turn_id: 'current-turn' }),
      ...(location === 'tail' ? [f.record('unknown_record', { padding: 'x'.repeat(300_000) })] : []),
      f.record('turn_context', { turn_id: 'current-turn', model: 'current-model' }),
      ...(location === 'recovered' ? [f.record('unknown_record', { padding: 'x'.repeat(300_000) })] : []),
      f.response({ type: 'function_call', call_id: 'current-call', name: 'exec_command' }),
    ]);
    const initial = await f.scan();
    assert.equal(initial.model, 'current-model');
    assert.equal(initial.status, 'tool');
    await f.append([
      f.event({ type: 'turn_aborted', turn_id: 'previous-turn' }),
      f.event({ type: 'task_complete', turn_id: 'previous-turn' }),
    ]);
    const session = await f.scan();
    assert.equal(session.status, 'tool');
    assert.equal(session.activity, 'exec_command');
    assert.deepEqual(session.recentEvents, initial.recentEvents);
    await f.append([f.event({ type: 'turn_aborted', turn_id: 'current-turn' })]);
    assert.equal((await f.scan()).status, 'waiting');
  });
}

for (const location of ['tail', 'recovered']) {
  test(`counts usage resets when only turn context identifies the new turn (${location})`, async (t) => {
    const f = await fixture(t);
    await f.append([
      f.event({ type: 'task_started', turn_id: 'old-turn' }),
      f.record('turn_context', { turn_id: 'old-turn' }),
      f.event(usage(100, 1_000)),
      f.record('unknown_record', { padding: 'x'.repeat(150_000) }),
      f.event({ type: 'task_started', turn_id: 'current-turn' }),
      ...(location === 'tail' ? [f.record('unknown_record', { padding: 'x'.repeat(300_000) })] : []),
      f.record('turn_context', { turn_id: 'current-turn' }),
      ...(location === 'recovered' ? [f.record('unknown_record', { padding: 'x'.repeat(300_000) })] : []),
      f.event(usage(20, 500)),
    ]);
    let session = await f.scan();
    assert.equal(session.outputTokensTotal, 120);
    assert.equal(session.contextUsedTokens, 500);
    await f.append([f.event(usage(20, 500)), f.event(usage(35, 600, 15))]);
    session = await f.scan();
    assert.equal(session.outputTokensTotal, 135);
    assert.equal(session.contextUsedTokens, 600);
  });
}

test('recovering context from the same turn does not manufacture a usage reset', async (t) => {
  const f = await fixture(t);
  await f.append([
    f.record('turn_context', { turn_id: 'current-turn' }),
    f.event(usage(100, 1_000)),
    f.record('unknown_record', { padding: 'x'.repeat(400_000) }),
    f.event(usage(20, 500)),
  ]);
  const session = await f.scan();
  assert.equal(session.outputTokensTotal, 100);
  assert.equal(session.contextUsedTokens, 1_000);
});

test('metadata recovery does not read a new turn appended after the tail snapshot', async (t) => {
  const f = await fixture(t);
  await f.append([
    f.record('unknown_record', { padding: 'x'.repeat(150_000) }),
    f.event({ type: 'task_started', turn_id: 'first-turn' }),
    f.record('turn_context', { turn_id: 'first-turn', model: 'first-model' }),
    f.record('unknown_record', { padding: 'x'.repeat(300_000) }),
    f.response({ type: 'function_call', call_id: 'first-call', name: 'exec_command' }),
    f.event({ type: 'turn_aborted', turn_id: 'first-turn' }),
  ]);
  const appended = [
    f.event({ type: 'task_started', turn_id: 'next-turn' }),
    f.record('turn_context', { turn_id: 'next-turn', model: 'next-model' }),
    f.event({ type: 'task_complete', turn_id: 'next-turn' }),
  ];
  const createReadStream = fs.createReadStream;
  let reads = 0;
  t.mock.method(fs, 'createReadStream', (...args) => {
    const stream = createReadStream(...args);
    if (args[0] === f.filePath && ++reads === 2) {
      stream.once('end', () => fs.appendFileSync(f.filePath,
        appended.map((entry) => JSON.stringify(entry)).join('\n') + '\n'));
    }
    return stream;
  });
  const initial = await f.scan();
  assert.equal(initial.model, 'first-model');
  assert.equal(initial.status, 'waiting');
  assert.equal(initial.activity, null);
  const updated = await f.scan();
  assert.equal(updated.model, 'next-model');
  assert.equal(updated.status, 'waiting');
  assert.equal(updated.activity, null);
});
