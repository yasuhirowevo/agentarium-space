import assert from 'node:assert/strict';
import test from 'node:test';
import { allowanceReadouts, assignmentLabel, codexDetailReadout, executionDuration, turnReadout } from '../ui/codex-details.js';

test('only current turns tick; completed and interrupted durations stay fixed', () => {
  const active = { status: 'active', startedAt: 1000 };
  assert.deepEqual(turnReadout(active, 2500), { label: 'Current turn', duration: '1s' });
  assert.equal(turnReadout(active, 65_000).duration, '1m 4s');
  for (const status of ['completed', 'interrupted']) {
    const finished = { status, startedAt: 1000, completedAt: 3500 };
    assert.equal(turnReadout(finished, 4000).duration, '2.5s');
    assert.equal(turnReadout(finished, 100_000).duration, '2.5s');
    assert.equal(turnReadout({ ...finished, durationMs: 1200 }, 100_000).duration, '1.2s');
    assert.equal(turnReadout({ status, durationMs: 0 }).duration, '0s');
  }
});

test('missing, invalid or unknown turn timing never inherits session uptime', () => {
  for (const turn of [null, {}, { status: 'active' }, { status: 'active', startedAt: 5000 },
    { status: 'completed', startedAt: 5000, completedAt: 1000 },
    { status: 'unknown', startedAt: 0 }, { status: 'toString', startedAt: 0 }]) {
    assert.equal(turnReadout(turn, 2000).duration, 'Unknown');
  }
  for (const value of [null, undefined, -1, NaN, Infinity, '3']) assert.equal(executionDuration(value), 'Unknown');
  assert.equal(executionDuration(3_723_000), '1h 2m 3s');
});

test('latest result keeps failure, exit and duration separate from command text', () => {
  const details = { commands: [
    { label: 'first', outcome: 'success', exitCode: 0, durationMs: 100 },
    { label: '<script>alert(1)</script>', outcome: 'failed', exitCode: 7, durationMs: 2500 },
  ] };
  const view = codexDetailReadout(details);
  assert.equal(view.command.label, '<script>alert(1)</script>');
  assert.equal(view.command.result, 'Failed · exit 7 · 2.5s');
  assert.equal(view.command.failed, true);
  const unknown = codexDetailReadout({ commands: [{ outcome: 'returned', exitCode: NaN }] });
  assert.equal(unknown.command.result, 'Unknown · exit unknown · duration unknown');
});

test('observed file operations retain scope, kinds and incomplete-list qualification', () => {
  const details = { turn: { status: 'completed', durationMs: 2000 }, filesTruncated: true,
    fileChanges: [
      { kind: 'add', path: 'new.js' }, { kind: 'update', path: 'main.js' },
      { kind: 'delete', path: 'old.js' }, { kind: 'move', from: 'from.js', path: 'to.js' },
    ] };
  const edits = codexDetailReadout(details).edits;
  assert.equal(edits.label, 'Completed turn · observed edits');
  assert.equal(edits.count, '4+ observed');
  assert.deepEqual(edits.files, ['Added · new.js', 'Updated · main.js', 'Deleted · old.js', 'Moved · from.js → to.js']);
  assert.equal(codexDetailReadout({ fileChanges: [] }).edits.count, '0 observed');
  assert.equal(codexDetailReadout(null).edits.count, 'Unknown');
});

test('allowance values become stale at age or reset without replenishing percentages', () => {
  const snapshot = [{ limitId: 'account-limit', observedAt: 1000,
    windows: [{ name: 'primary', remainingPercent: 23.4, windowMinutes: 300, resetsAt: 2_000_000 }] }];
  const current = allowanceReadouts(snapshot, 900_999)[0];
  assert.equal(current.limit, 'account-limit');
  assert.equal(current.windows[0].value, '23.4% remaining');
  assert.equal(current.windows[0].label, 'primary · 5h window');
  assert.equal(allowanceReadouts(snapshot, 901_000)[0].windows[0].value, '23.4% remaining · stale snapshot');
  assert.equal(allowanceReadouts(snapshot, 2_000_000)[0].windows[0].value, '23.4% remaining · stale snapshot');
  snapshot[0].windows[0].resetsAt = 1500;
  assert.equal(allowanceReadouts(snapshot, 1500)[0].windows[0].stale, true);
  assert.equal(snapshot[0].windows[0].remainingPercent, 23.4);
});

test('allowances keep unavailable measurements unknown instead of inventing zero', () => {
  const view = allowanceReadouts([{ observedAt: Infinity, windows: [
    { name: 'primary', remainingPercent: null, windowMinutes: 0, resetsAt: NaN },
    { name: 'secondary', remainingPercent: 200, windowMinutes: 10080, resetsAt: 1e30 },
  ] }], 1000)[0];
  assert.equal(view.observed, 'Observed Unknown');
  assert.equal(view.windows[0].value, 'Remaining unknown');
  assert.equal(view.windows[0].label, 'primary · window unknown');
  assert.equal(view.windows[0].reset, 'Reset Unknown');
  assert.equal(view.windows[0].stale, false);
  assert.equal(view.windows[1].value, 'Remaining unknown');
  assert.equal(view.windows[1].label, 'secondary · 7d window');
});

test('explicit plans and delegations preserve observed states without completion estimates', () => {
  const details = { plan: { explanation: 'Observed plan', steps: [
    { step: 'Read files', status: 'completed' }, { step: 'Change files', status: 'in_progress' },
    { step: 'Check result', status: 'pending' },
  ] }, delegations: [{ targetId: 'child', targetPath: '/root/helper', task: 'Review changes', lastActivity: 'completed', lastActivityAt: 1000 }],
  agentWait: { scope: 'targets', targets: [{ id: 'child' }, { path: '/root/missing' }] } };
  const view = codexDetailReadout(details, 3000, [{ source: 'codex', id: 'child', title: 'Helper' }]);
  assert.deepEqual(view.plan.steps, ['Completed · Read files', 'In progress · Change files', 'Pending · Check result']);
  assert.equal(view.delegations[0].target, 'Helper');
  assert.equal(view.delegations[0].task, 'Review changes');
  assert.match(view.delegations[0].activity, /^Last child activity · completed · /);
  assert.equal(view.wait, 'Waiting for agents · Helper, /root/missing');
  assert.equal(codexDetailReadout({ agentWait: { scope: 'mailbox' } }).wait, 'Waiting for agent mailbox');
  assert.equal(codexDetailReadout({}).wait, null);
});

test('tree assignment labels require matching stable Codex IDs and use the latest assignment', () => {
  const child = { source: 'codex', id: 'child-id', title: 'helper' };
  const parent = { source: 'codex', codexDetails: { delegations: [
    { targetId: 'child-id', task: 'Current task', assignedAt: 3000 },
    { targetId: 'child-id', task: 'Earlier task', assignedAt: 1000 },
    { targetPath: 'helper', task: 'Do not infer identity', assignedAt: 4000 },
  ] } };
  assert.equal(assignmentLabel(child, [parent, child]), 'Assigned · Current task');
  assert.equal(assignmentLabel({ ...child, id: 'other' }, [parent]), null);
  assert.equal(assignmentLabel({ ...child, source: 'claude' }, [parent]), null);
});

test('long and malformed detail payloads remain bounded and renderable as text', () => {
  const value = 'x'.repeat(10_000);
  const view = codexDetailReadout({ effort: value, commands: [null, { label: value, outcome: 'toString' }],
    fileChanges: Array.from({ length: 200 }, () => ({ path: value, kind: 'constructor' })),
    compaction: { observedCount: NaN, lastAt: Infinity },
    plan: { steps: [null, { step: value, status: 'toString' }] },
    allowances: [null, { windows: [null, {}] }], delegations: [null, {}],
  });
  assert.equal(view.effort.length, 32);
  assert.equal(view.command.label.length, 120);
  assert.match(view.command.result, /^Unknown ·/);
  assert.equal(view.edits.files.length, 100);
  assert.equal(view.edits.count, '100+ observed');
  assert.equal(view.edits.files[0].length, 'Unknown · '.length + 240);
  assert.equal(view.compaction, 'Unknown');
  assert.match(view.plan.steps[0], /^Unknown ·/);
  assert.doesNotThrow(() => codexDetailReadout({ commands: {}, fileChanges: {}, allowances: {}, delegations: {}, plan: {} }));
});
