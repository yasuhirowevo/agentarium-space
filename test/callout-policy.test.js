import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isMainCalloutSession,
  mainCalloutsFor,
  normalizeMessageKind,
  persistentCalloutFor,
  SPOTLIGHT_CALLOUT_LIMIT,
  workCalloutFor,
} from '../ui/callout-policy.js';

test('normalizes message kinds without requiring a display expiry', () => {
  for (const kind of ['progress', 'commentary', 'final']) assert.equal(normalizeMessageKind(kind), kind);
  assert.equal(normalizeMessageKind(null), 'final');
});

test('restores the latest known speech on startup regardless of age, kind or activity', () => {
  const now = Date.parse('2026-07-26T05:00:00.000Z');
  const session = {
    status: 'thinking',
    lastMessage: '起動状態を確認',
    lastMessageAt: now - 20_000,
    lastMessageKind: 'progress',
  };

  for (const status of ['tool', 'thinking', 'waiting', 'idle']) {
    for (const kind of ['commentary', 'progress', 'final']) {
      const result = persistentCalloutFor({ ...session, status, lastMessageKind: kind, lastMessageAt: now - 600_000 });
      assert.equal(result.message, session.lastMessage);
      assert.equal(result.messageAt, now - 600_000);
      assert.equal(result.hasMessage, true);
    }
  }
});

test('falls back to the observed active tool only when speech is unavailable', () => {
  const session = { status: 'tool', activity: 'Read', activityDetail: 'src/parser.js', lastActivity: 123 };
  assert.deepEqual(persistentCalloutFor(session), {
    message: 'Read: src/parser.js', messageAt: 123, hasMessage: false,
  });
  assert.equal(persistentCalloutFor({ ...session, lastMessage: 'Recent reply' }).message, 'Recent reply');
  assert.equal(persistentCalloutFor({ ...session, status: 'waiting' }), null);
  assert.equal(persistentCalloutFor({ ...session, activity: null }), null);
  assert.equal(persistentCalloutFor(null), null);
});

const NOW = Date.parse('2026-09-23T06:00:00.000Z');

function workingSession(details = {}, overrides = {}) {
  return {
    source: 'codex', id: 'parent', status: 'tool',
    codexDetails: { turn: { id: 'current-turn', status: 'active' }, ...details },
    ...overrides,
  };
}

test('supports four automatic callouts and prioritizes explicit waiting over a current plan', () => {
  assert.equal(SPOTLIGHT_CALLOUT_LIMIT, 4);
  const session = workingSession({
    agentWait: { turnId: 'current-turn', scope: 'targets', startedAt: NOW - 1000,
      targets: [{ id: 'child' }, { path: '/root/check' }] },
    plan: { turnId: 'current-turn', updatedAt: NOW - 2000,
      steps: [{ status: 'in_progress', step: 'Review changes' }] },
  });
  const child = { source: 'codex', id: 'child', title: 'Fixture reviewer' };
  assert.deepEqual(workCalloutFor(session, [child], NOW), {
    text: 'Waiting · Fixture reviewer, /root/check', at: NOW - 1000,
  });
  session.codexDetails.agentWait.scope = 'mailbox';
  assert.equal(workCalloutFor(session, [], NOW).text, 'Waiting · agent mailbox');
  session.codexDetails.agentWait = null;
  assert.deepEqual(workCalloutFor(session, [], NOW), { text: 'Plan · Review changes', at: NOW - 2000 });
});

test('does not infer agent waiting or show plans from inactive or mismatched turns', () => {
  const details = {
    agentWait: { turnId: 'current-turn', scope: 'mailbox', startedAt: NOW },
    plan: { turnId: 'current-turn', updatedAt: NOW,
      steps: [{ status: 'in_progress', step: 'Old work' }] },
  };
  for (const status of ['completed', 'interrupted', 'unknown']) {
    assert.equal(workCalloutFor(workingSession({ ...details, turn: { id: 'current-turn', status } }), [], NOW), null);
  }
  assert.equal(workCalloutFor(workingSession(details, { status: 'waiting' }), [], NOW), null);
  assert.equal(workCalloutFor(workingSession({ ...details, turn: { id: 'another-turn', status: 'active' } }), [], NOW), null);
  assert.equal(workCalloutFor(workingSession({}, { status: 'waiting' }), [], NOW), null);
  assert.equal(workCalloutFor(workingSession({ plan: { turnId: 'current-turn', steps: [
    { status: 'completed', step: 'Finished work' }, { status: 'pending', step: 'Future work' },
  ] } }), [], NOW), null);
});

test('wait labels only resolve matching Codex IDs or explicitly supplied paths and IDs', () => {
  const session = workingSession({ agentWait: { turnId: 'current-turn', scope: 'targets', startedAt: NOW,
    targets: [null, {}, { id: 'foreign', path: '/root/explicit' }, { id: 'unknown-id' }] } });
  const foreign = { source: 'claude', id: 'foreign', title: 'Wrong source' };
  assert.equal(workCalloutFor(session, [null, foreign], NOW).text, 'Waiting · /root/explicit, unknown-id');
  session.codexDetails.agentWait.targets = [null, {}];
  assert.equal(workCalloutFor(session, [foreign], NOW), null);
});

test('active children display their latest stable-ID assignment across parents', () => {
  const child = workingSession({}, { id: 'child', status: 'thinking' });
  const parent = (source, task, assignedAt, targetId = 'child') => ({
    source, codexDetails: { delegations: [{ targetId, task, assignedAt }] },
  });
  const parents = [parent('codex', 'New work', NOW - 1000), parent('codex', 'Old work', NOW - 2000),
    parent('claude', 'Wrong source', NOW), parent('codex', 'Wrong child', NOW, 'another-child')];
  assert.deepEqual(workCalloutFor(child, parents, NOW), { text: 'Assigned · New work', at: NOW - 1000 });
  assert.equal(workCalloutFor({ ...child, status: 'waiting' }, parents, NOW), null);
  assert.equal(workCalloutFor({ ...child, id: 'different-child' }, parents, NOW), null);
  assert.equal(workCalloutFor({ ...child, source: 'claude' }, parents, NOW), null);
  child.codexDetails.plan = { turnId: 'current-turn', updatedAt: NOW,
    steps: [{ status: 'in_progress', step: 'Current step' }] };
  assert.equal(workCalloutFor(child, parents, NOW).text, 'Plan · Current step');
});

test('command callouts retain actual outcome and exit code without inferring test success', () => {
  const command = { turnId: 'current-turn', label: 'pnpm test', outcome: 'failed', exitCode: 1, completedAt: NOW - 45_000 };
  const session = workingSession({ commands: [command] }, { status: 'waiting' });
  assert.deepEqual(workCalloutFor(session, [], NOW), { text: 'Failed · exit 1 · pnpm test', at: NOW - 45_000 });
  command.completedAt -= 1;
  assert.equal(workCalloutFor(session, [], NOW), null);
  command.completedAt = NOW;
  command.outcome = 'success';
  command.exitCode = 0;
  assert.equal(workCalloutFor(session, [], NOW).text, 'Success · exit 0 · pnpm test');
  command.exitCode = null;
  command.outcome = 'failed';
  assert.equal(workCalloutFor(session, [], NOW).text, 'Failed · pnpm test');
});

test('command callouts ignore old turns, future timestamps and unknown outcomes', () => {
  const command = { turnId: 'current-turn', label: 'check', outcome: 'success', exitCode: 0, completedAt: NOW };
  for (const overrides of [{ turnId: 'old-turn' }, { completedAt: NOW + 1 },
    { completedAt: null }, { outcome: 'unknown' }, { label: null }]) {
    assert.equal(workCalloutFor(workingSession({ commands: [{ ...command, ...overrides }] }), [], NOW), null);
  }
  assert.equal(workCalloutFor(workingSession({ turn: null, commands: [command] }), [], NOW), null);
  const session = workingSession({ commands: [
    { ...command, label: 'Latest', completedAt: NOW - 100 }, { ...command, label: 'Older', completedAt: NOW - 500 },
  ] });
  assert.equal(workCalloutFor(session, [], NOW).text, 'Success · exit 0 · Latest');
});

test('work callouts are bounded, normalized and safe with missing or malformed fields', () => {
  for (const value of [null, {}, { source: 'claude' }, workingSession({
    commands: {}, agentWait: { targets: {} }, plan: { steps: {} },
  })]) {
    assert.equal(workCalloutFor(value, [null, {}], NOW), null);
  }
  const session = workingSession({ plan: { turnId: 'current-turn', steps: [
    null, { status: 'in_progress', step: `  Read\n\t${'😀'.repeat(300)}  ` },
  ] } });
  const result = workCalloutFor(session, null, NOW);
  assert.equal(Array.from(result.text).length, 160);
  assert.ok(result.text.startsWith('Plan · Read 😀'));
  assert.ok(result.text.endsWith('…'));
  assert.equal(result.at, 0);
});

test('main callouts exclude child sessions and auto-review agents', () => {
  const session = workingSession({}, { model: 'fixture-model' });
  assert.equal(isMainCalloutSession(session), true);
  assert.equal(isMainCalloutSession({ source: 'claude' }), true);
  assert.equal(isMainCalloutSession(null), false);
  for (const child of [{ parentId: 'parent' }, { isSubAgent: true }, { model: 'codex-auto-review' }]) {
    const candidate = { ...session, ...child };
    assert.equal(isMainCalloutSession(candidate), false);
    assert.deepEqual(mainCalloutsFor(candidate, [], NOW), []);
  }
});

test('main work keeps turn duration, explicit waiting and current plan in three paragraphs', () => {
  const session = workingSession({
    turn: { id: 'current-turn', status: 'active', startedAt: NOW - 60_000 },
    agentWait: { turnId: 'current-turn', scope: 'targets', targets: [{ id: 'child' }] },
    plan: { turnId: 'current-turn', steps: [
      { status: 'completed', step: 'Inspect' },
      { status: 'in_progress', step: 'Review fixture' },
      { status: 'pending', step: 'Report' },
    ] },
  }, { activity: 'wait_agent' });
  const result = mainCalloutsFor(session, [{ source: 'codex', id: 'child', title: 'Fixture reviewer' }], NOW);
  assert.deepEqual(result, [{ kind: 'work', title: 'Turn status', paragraphs: [
    'In progress · Elapsed 1m 0s', 'wait_agent · Waiting · Fixture reviewer', 'Plan 1/3 completed · Review fixture',
  ] }]);
  assert.equal(mainCalloutsFor(session, [], NOW + 1000)[0].paragraphs[0], 'In progress · Elapsed 1m 1s');
});

test('main work does not present inactive or mismatched plans and waits as current work', () => {
  const session = workingSession({
    agentWait: { turnId: 'current-turn', scope: 'mailbox' },
    plan: { turnId: 'current-turn', steps: [{ status: 'in_progress', step: 'Previous work' }] },
  });
  for (const status of ['completed', 'interrupted', 'unknown']) {
    const result = mainCalloutsFor({ ...session, codexDetails: {
      ...session.codexDetails, turn: { id: 'current-turn', status },
    } }, [], NOW);
    assert.doesNotMatch(JSON.stringify(result), /Previous work|Waiting ·|Plan /);
  }
  assert.doesNotMatch(JSON.stringify(mainCalloutsFor({ ...session, status: 'waiting' }, [], NOW)), /Previous work|Waiting ·|Plan /);
  session.codexDetails.turn.id = 'new-turn';
  assert.doesNotMatch(JSON.stringify(mainCalloutsFor(session, [], NOW)), /Previous work|Waiting ·|Plan /);
});

test('main results retain observed current-turn outcomes until the next turn', () => {
  const session = workingSession({
    turn: { id: 'current-turn', status: 'completed', durationMs: 1000 },
    commands: [
      { turnId: 'current-turn', label: 'fixture check', outcome: 'failed', exitCode: 2, durationMs: 2500, completedAt: NOW - 60_000 },
      { turnId: 'old-turn', label: 'Old successful check', outcome: 'success', exitCode: 0, completedAt: NOW },
    ],
    fileChanges: [{ path: 'src/fixture.js', kind: 'update' }],
  }, { status: 'waiting' });
  const observed = mainCalloutsFor(session, [], NOW).find((entry) => entry.kind === 'result');
  assert.deepEqual(observed, { kind: 'result', title: 'Result', paragraphs: [
    'Failed · exit 2 · 2.5s', 'Command · fixture check', '1 observed edit · src/fixture.js',
  ] });
  assert.deepEqual(mainCalloutsFor(session, [], NOW + 24 * 60 * 60 * 1000).find((entry) => entry.kind === 'result'), observed);
  session.codexDetails.turn = { id: 'next-turn', status: 'active' };
  session.codexDetails.fileChanges = [];
  assert.equal(mainCalloutsFor(session, [], NOW).some((entry) => entry.kind === 'result'), false);
});

test('main results select the latest observed command and never claim complete edit coverage', () => {
  const command = { turnId: 'current-turn', outcome: 'success', exitCode: 0 };
  const session = workingSession({ commands: [
    { ...command, label: 'latest', completedAt: NOW - 10 },
    { ...command, label: 'older', completedAt: NOW - 100 },
    { ...command, label: 'future', completedAt: NOW + 1 },
  ], fileChanges: [{ path: 'fixture.js', kind: 'delete' }], filesTruncated: true });
  assert.deepEqual(mainCalloutsFor(session, [], NOW).find((entry) => entry.kind === 'result').paragraphs,
    ['Success · exit 0', 'Command · latest', '1+ observed edits · fixture.js']);
});

test('main session readout shares context semantics and separates uptime from turn duration', () => {
  const session = workingSession({ effort: 'high' }, {
    model: 'fixture-model', startedAt: NOW - 120_000,
    contextUsedTokens: 50_000, contextWindowTokens: 100_000,
    outputTokensTotal: 2400, gitBranch: 'fixture-branch',
  });
  assert.deepEqual(mainCalloutsFor(session, [], NOW).find((entry) => entry.kind === 'context'), {
    kind: 'context', title: 'Session', paragraphs: [
      'fixture-model · Effort high · Session 2m 0s', 'CTX 50% · OUT 2k tokens', 'Branch · fixture-branch',
    ],
  });
  session.contextWindowTokens = null;
  assert.equal(mainCalloutsFor(session, [], NOW).at(-1).paragraphs[1], 'CTX 50k tokens · OUT 2k tokens');
  session.contextWindowTokens = 100;
  assert.equal(mainCalloutsFor(session, [], NOW).at(-1).paragraphs[1], 'CTX 50k tokens · OUT 2k tokens');
});

test('main Claude readouts use only observed activity and session metadata', () => {
  const session = {
    source: 'claude', status: 'tool', activity: 'Read', activityDetail: 'fixture.js',
    model: 'fixture-model', contextUsedTokens: 12_000, outputTokensTotal: 42, gitBranch: 'fixture',
    codexDetails: { effort: 'Incorrect source', turn: { status: 'active' } },
  };
  assert.deepEqual(mainCalloutsFor(session, [], NOW), [
    { kind: 'work', title: 'Activity', paragraphs: ['Read: fixture.js'] },
    { kind: 'context', title: 'Session', paragraphs: ['fixture-model', 'CTX 12k tokens · OUT 42 tokens', 'Branch · fixture'] },
  ]);
});

test('main callouts omit unavailable values without inventing progress or empty edit results', () => {
  for (const session of [null, {}, { source: 'claude', status: 'waiting' }, workingSession({
    turn: null, commands: {}, fileChanges: [], plan: { steps: {} }, agentWait: { targets: {} },
  }, { contextUsedTokens: -1, outputTokensTotal: NaN, startedAt: NOW + 1 })]) {
    assert.deepEqual(mainCalloutsFor(session, [null, {}], NOW), []);
  }
  const session = workingSession({
    turn: { id: 'current-turn', status: 'unknown' },
    commands: [{ turnId: 'current-turn', label: 'Observed command', outcome: 'unknown' }],
  });
  assert.deepEqual(mainCalloutsFor(session, null, NOW), [{
    kind: 'result', title: 'Result', paragraphs: ['Command · Observed command'],
  }]);
});
