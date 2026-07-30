import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeMessageKind,
  shouldBootstrapSpotlight,
  spotlightDurationFor,
} from '../ui/callout-policy.js';

test('uses shorter spotlight durations for in-progress messages', () => {
  assert.equal(spotlightDurationFor('progress'), 10);
  assert.equal(spotlightDurationFor('commentary'), 18);
  assert.equal(spotlightDurationFor('final'), 45);
  assert.equal(spotlightDurationFor('unknown'), 45);
  assert.equal(normalizeMessageKind(null), 'final');
});

test('bootstraps only fresh progress from active sessions', () => {
  const now = Date.parse('2026-07-26T05:00:00.000Z');
  const session = {
    source: 'claude',
    status: 'thinking',
    lastMessage: '起動状態を確認',
    lastMessageAt: now - 20_000,
    lastMessageKind: 'progress',
  };

  assert.equal(shouldBootstrapSpotlight(session, now), true);
  assert.equal(shouldBootstrapSpotlight({ ...session, status: 'tool' }, now), true);
  assert.equal(shouldBootstrapSpotlight({ ...session, lastMessageKind: 'commentary' }, now), true);
  assert.equal(shouldBootstrapSpotlight({ ...session, lastMessageKind: 'final' }, now), false);
  assert.equal(shouldBootstrapSpotlight({ ...session, status: 'waiting' }, now), false);
  assert.equal(
    shouldBootstrapSpotlight({ ...session, lastMessageAt: now - 20_001 }, now),
    false,
  );
  assert.equal(
    shouldBootstrapSpotlight({ ...session, lastMessageAt: now + 60_001 }, now),
    false,
  );
});
