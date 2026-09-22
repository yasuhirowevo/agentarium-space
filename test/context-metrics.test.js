import assert from 'node:assert/strict';
import test from 'node:test';
import { contextLabel, contextUsage } from '../ui/context-metrics.js';

test('unknown context windows show measured tokens without a percentage ring', () => {
  for (const contextWindowTokens of [null, undefined, 0, -1, NaN, Infinity]) {
    const session = { contextUsedTokens: 123_456, contextWindowTokens };
    assert.equal(contextUsage(session), null);
    assert.equal(contextLabel(session), 'CTX 123k');
  }
});

test('known context windows retain percentages and overflow uses raw tokens', () => {
  const session = { contextUsedTokens: 50_000, contextWindowTokens: 200_000 };
  assert.equal(contextUsage(session), 0.25);
  assert.equal(contextLabel(session), 'CTX 25%');
  assert.equal(contextLabel({ ...session, contextUsedTokens: 0 }), 'CTX 0%');
  assert.equal(contextLabel({ ...session, contextUsedTokens: 200_000 }), 'CTX 100%');
  assert.equal(contextUsage({ ...session, contextUsedTokens: 250_000 }), null);
  assert.equal(contextLabel({ ...session, contextUsedTokens: 250_000 }), 'CTX 250k');
});

test('missing and invalid usage does not produce a fabricated measurement', () => {
  for (const contextUsedTokens of [undefined, null, -1, NaN, Infinity]) {
    const session = { contextUsedTokens, contextWindowTokens: 200_000 };
    assert.equal(contextLabel(session), '');
    assert.equal(contextUsage(session), null);
  }
  assert.equal(contextLabel(null), '');
});
