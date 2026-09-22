import assert from 'node:assert/strict';
import test from 'node:test';
import { applyCodexExecution } from '../src/codex-execution.js';
import { applyCodexWorkflow } from '../src/codex-workflow.js';
import { createSession } from '../src/state.js';

const CHILD_ID = '22222222-2222-4222-8222-222222222222';
const BASE = Date.parse('2026-01-01T00:00:00Z');

function harness({ start = true } = {}) {
  const session = createSession('synthetic-parent', 'codex', 'synthetic-parent');
  let sequence = 0;
  const apply = (type, payload, at = BASE + sequence++ * 1000) => {
    const record = { type, payload, timestamp: new Date(at).toISOString() };
    applyCodexExecution(session, record);
    applyCodexWorkflow(session, record);
  };
  const begin = (turn = 'turn-one') => apply('event_msg', { type: 'task_started', turn_id: turn });
  const call = (id, name, args) => apply('response_item', {
    type: 'function_call', call_id: id, name, arguments: JSON.stringify(args),
  });
  const output = (id, value) => apply('response_item', {
    type: 'function_call_output', call_id: id, output: value,
  });
  const activity = (id, kind, { turn = 'turn-one', at, path = '/root/helper' } = {}) => apply('event_msg', {
    type: 'item_completed', turn_id: turn,
    item: { type: 'SubAgentActivity', id, kind, agent_thread_id: CHILD_ID, agent_path: path },
  }, at);
  if (start) begin();
  return { session, apply, begin, call, output, activity, details: session.codexDetails };
}

test('shows a structured plan only after a matching successful update', () => {
  const h = harness();
  h.call('plan-one', 'update_plan', {
    explanation: 'Review the synthetic change',
    plan: [{ step: 'Inspect fixtures', status: 'completed' }, { step: 'Run checks', status: 'in_progress' }],
  });
  assert.equal(h.details.plan, null);
  h.output('unrelated', 'Plan updated');
  assert.equal(h.details.plan, null);
  h.output('plan-one', 'Plan updated');
  assert.equal(h.details.plan.turnId, 'turn-one');
  assert.deepEqual(h.details.plan.steps, [
    { step: 'Inspect fixtures', status: 'completed' }, { step: 'Run checks', status: 'in_progress' },
  ]);
  h.call('plan-two', 'update_plan', { plan: [{ step: 'New first step', status: 'pending' }] });
  h.output('plan-two', 'Plan updated');
  assert.deepEqual(h.details.plan.steps, [{ step: 'New first step', status: 'pending' }]);
});

test('a failed or late older plan cannot replace a newer confirmed plan', () => {
  const h = harness();
  h.call('older', 'update_plan', { plan: [{ step: 'Old', status: 'pending' }] });
  h.call('newer', 'update_plan', { plan: [{ step: 'New', status: 'completed' }] });
  h.output('newer', 'Plan updated');
  h.output('older', 'Plan updated');
  h.call('failed', 'update_plan', { plan: [{ step: 'Rejected', status: 'pending' }] });
  h.output('failed', 'Tool error');
  assert.equal(h.details.plan.callId, 'newer');
});

test('ignores inferred, malformed, oversized and unknown-status plans', () => {
  const h = harness();
  h.apply('event_msg', { type: 'agent_message', message: '1. Inspect 2. Test', phase: 'commentary' });
  h.call('wrapper', 'exec', { code: 'tools.update_plan({ plan: [] })' });
  h.call('unknown', 'update_plan', { plan: [{ step: 'Inspect', status: 'almost_done' }] });
  h.output('unknown', 'Plan updated');
  h.call('large', 'update_plan', { plan: Array.from({ length: 21 }, () => ({ step: 'Step', status: 'completed' })) });
  h.output('large', 'Plan updated');
  h.apply('response_item', { type: 'function_call', call_id: 'broken', name: 'update_plan', arguments: '{' });
  assert.equal(h.details.plan, null);
  h.call('bounded', 'update_plan', { explanation: 'e'.repeat(300), plan: [{ step: 's'.repeat(300), status: 'pending' }] });
  h.output('bounded', 'Plan updated');
  assert.equal(h.details.plan.explanation.length, 160);
  assert.equal(h.details.plan.steps[0].step.length, 120);
  h.call('oversized-replacement', 'update_plan', {
    plan: Array.from({ length: 21 }, () => ({ step: 'Replacement', status: 'pending' })),
  });
  h.output('oversized-replacement', 'Plan updated');
  assert.equal(h.details.plan, null, 'an unsupported successful replacement cannot leave a stale plan visible');
});

test('workflow requires turn evidence and resets on accepted new turns', () => {
  const missing = harness({ start: false });
  missing.call('unscoped', 'update_plan', { plan: [] });
  missing.output('unscoped', 'Plan updated');
  assert.equal(missing.session.codexDetails.plan, null);

  const h = harness();
  h.call('plan', 'update_plan', { plan: [{ step: 'Inspect', status: 'pending' }] });
  h.output('plan', 'Plan updated');
  h.call('late', 'update_plan', { plan: [] });
  h.call('waiting', 'wait_agent', { timeout_ms: 30000 });
  h.apply('turn_context', { turn_id: 'turn-two' });
  assert.equal(h.details.plan, null);
  assert.equal(h.details.agentWait, null);
  h.output('late', 'Plan updated');
  assert.equal(h.details.plan, null);
  h.begin('turn-one');
  assert.equal(h.details.turn.id, 'turn-two');
});

test('spawn and follow-up assignments retain canonical identity without child logs', () => {
  const h = harness();
  h.call('spawn', 'spawn_agent', { task_name: 'helper', message: 'Inspect the synthetic fixture' });
  h.activity('spawn', 'started');
  h.output('spawn', JSON.stringify({ task_name: '/root/helper' }));
  const spawned = h.details.delegations[0];
  assert.equal(spawned.targetId, CHILD_ID);
  assert.equal(spawned.targetPath, '/root/helper');
  assert.equal(spawned.task, 'helper');
  assert.equal(spawned.lastActivity, 'started');
  assert.equal(h.details.agentWait, null);

  h.call('follow-up', 'followup_task', { target: 'helper', message: 'Check the next fixture' });
  h.activity('follow-up', 'interacted');
  h.output('follow-up', '');
  assert.equal(h.details.delegations.length, 2);
  assert.equal(h.details.delegations[1].targetId, CHILD_ID);
  assert.equal(h.details.delegations[1].task, 'Check the next fixture');
  h.activity('completion', 'completed');
  assert.equal(h.details.delegations[1].lastActivity, 'completed');
  assert.equal(Object.hasOwn(h.details.delegations[1], 'completed'), false);
  h.output('follow-up', '');
  assert.equal(h.details.delegations.length, 2);
});

test('legacy spawn result supplies a stable ID and failed tools never create assignments', () => {
  const h = harness();
  h.call('legacy', 'spawn_agent', { message: 'Review a fixture' });
  h.output('legacy', JSON.stringify({ agent_id: CHILD_ID, nickname: 'Helper' }));
  assert.equal(h.details.delegations[0].targetId, CHILD_ID);
  assert.equal(h.details.delegations[0].targetPath, null);
  h.call('failed', 'spawn_agent', { task_name: 'failed', message: 'Inspect' });
  h.output('failed', JSON.stringify({ error: 'Unavailable' }));
  h.call('failed-followup', 'followup_task', { target: CHILD_ID, message: 'Inspect' });
  h.output('failed-followup', 'Tool error');
  h.call('message', 'send_message', { target: CHILD_ID, message: 'A note, not a task' });
  h.output('message', '');
  assert.equal(h.details.delegations.length, 1);
});

test('late activity enriches a follow-up target and older or foreign-turn activity is ignored', () => {
  const h = harness();
  h.call('follow-up', 'followup_task', { target: 'helper', message: 'Inspect fixtures' });
  h.output('follow-up', '');
  h.activity('follow-up', 'interacted', { at: BASE + 10000 });
  assert.equal(h.details.delegations[0].targetPath, '/root/helper');
  assert.equal(h.details.delegations[0].targetId, CHILD_ID);
  h.activity('old', 'completed', { at: BASE + 5000 });
  h.activity('foreign', 'completed', { turn: 'another-turn', at: BASE + 12000 });
  assert.equal(h.details.delegations[0].lastActivity, 'interacted');
});

test('explicit waits are separate from assignments and clear only on matching output', () => {
  const h = harness();
  h.call('spawn', 'spawn_agent', { task_name: 'helper', message: 'Inspect' });
  h.activity('spawn', 'started');
  h.output('spawn', JSON.stringify({ task_name: '/root/helper' }));
  h.call('wait-one', 'wait_agent', { targets: ['helper'], timeout_ms: 30000 });
  assert.deepEqual(h.details.agentWait.targets, [{ id: CHILD_ID, path: '/root/helper' }]);
  assert.equal(h.details.agentWait.scope, 'targets');
  h.output('unrelated', '{}');
  assert.equal(h.details.agentWait.callId, 'wait-one');
  h.call('mailbox', 'wait_agent', { timeout_ms: 30000 });
  assert.equal(h.details.agentWait.scope, 'mailbox');
  assert.deepEqual(h.details.agentWait.targets, []);
  h.output('mailbox', JSON.stringify({ message: 'Mailbox changed', timed_out: false }));
  assert.equal(h.details.agentWait.callId, 'wait-one');
  h.output('wait-one', JSON.stringify({ timed_out: true }));
  assert.equal(h.details.agentWait, null);
  assert.equal(h.details.delegations.length, 1);
});

test('orchestration waits do not masquerade as agent waits; terminal turns clear waits', () => {
  const h = harness();
  h.call('cell', 'wait', { cell_id: 'synthetic-cell' });
  assert.equal(h.details.agentWait, null);
  h.call('cli-wait', 'wait', { ids: [CHILD_ID], timeout_ms: 30000 });
  assert.deepEqual(h.details.agentWait.targets, [{ id: CHILD_ID, path: null }]);
  h.apply('event_msg', { type: 'turn_aborted', turn_id: 'turn-one' });
  assert.equal(h.details.agentWait, null);
  h.call('after-stop', 'wait_agent', { timeout_ms: 30000 });
  assert.equal(h.details.agentWait, null);
});

test('bounds assignment storage and does not publish full delegation text', () => {
  const h = harness();
  for (let i = 0; i < 40; i++) {
    h.call(`assignment-${i}`, 'spawn_agent', { message: 'x'.repeat(500) });
    h.output(`assignment-${i}`, JSON.stringify({ agent_id: `synthetic-child-${i}` }));
  }
  assert.equal(h.details.delegations.length, 32);
  assert.equal(h.details.delegations[0].callId, 'assignment-8');
  assert.equal(h.details.delegations[0].task.length, 120);
  assert.equal(JSON.stringify(h.details).includes('x'.repeat(121)), false);
  h.begin('turn-two');
  assert.deepEqual(h.details.delegations, []);
});

test('bounded correlation storage cannot leave an observed wait stuck', () => {
  const h = harness();
  h.call('waiting', 'wait_agent', { timeout_ms: 30000 });
  for (let i = 0; i < 260; i++) h.call(`pending-${i}`, 'update_plan', { plan: [] });
  assert.equal(h.session.codexWorkflow.calls.size, 256);
  h.output('waiting', JSON.stringify({ timed_out: true }));
  assert.equal(h.details.agentWait, null);
});


test('late activity resolves short aliases for pending waits and subsequent follow-ups', () => {
  const h = harness();
  h.call('followup', 'followup_task', { target: 'helper', message: 'Review the fixture' });
  h.output('followup', '');
  h.call('early-wait', 'wait_agent', { targets: ['helper'] });
  h.activity('followup', 'interacted');
  assert.deepEqual(h.details.agentWait.targets, [{ id: CHILD_ID, path: '/root/helper' }]);
  h.output('early-wait', '{}');
  h.call('later-wait', 'wait_agent', { targets: ['helper'] });
  assert.deepEqual(h.details.agentWait.targets, [{ id: CHILD_ID, path: '/root/helper' }]);
  h.call('next-followup', 'followup_task', { target: 'helper', message: 'Verify the next fixture' });
  h.output('next-followup', '');
  assert.equal(h.details.delegations.at(-1).targetId, CHILD_ID);
  assert.equal(h.details.delegations.at(-1).targetPath, '/root/helper');
});
