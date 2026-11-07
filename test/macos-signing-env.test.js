import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REQUIRED_SIGNING_ENV,
  validateSigningEnvironment,
} from '../scripts/build-macos-signed.mjs';

test('accepts a complete optional signing and notarization environment', () => {
  const env = Object.fromEntries(REQUIRED_SIGNING_ENV.map((name) => [name, 'configured']));
  assert.doesNotThrow(() => validateSigningEnvironment(env));
});

test('rejects absent or partial optional signing credentials', () => {
  assert.throws(
    () => validateSigningEnvironment({}),
    /CSC_LINK.*CSC_KEY_PASSWORD.*APPLE_API_KEY.*APPLE_API_KEY_ID.*APPLE_API_ISSUER/,
  );
  assert.throws(
    () => validateSigningEnvironment({ CSC_LINK: 'configured' }),
    /Missing: CSC_KEY_PASSWORD/,
  );
});
