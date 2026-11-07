import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedRendererRequest } from '../electron/network-policy.js';

const SERVER_URL = 'http://127.0.0.1:41414/launch-token/';

test('allows only HTTP and WebSocket requests to the active Agentarium server', () => {
  assert.equal(
    isAllowedRendererRequest('http://127.0.0.1:41414/launch-token/office.js', SERVER_URL),
    true,
  );
  assert.equal(
    isAllowedRendererRequest('ws://127.0.0.1:41414/launch-token/', SERVER_URL),
    true,
  );
});

test('blocks external, deceptive, and other-loopback requests', () => {
  for (const url of [
    'https://example.com/',
    'http://127.0.0.1.example.com:41414/',
    'http://localhost:41414/',
    'http://127.0.0.1:41415/',
    'file:///tmp/agentarium.html',
    'not a URL',
  ]) {
    assert.equal(isAllowedRendererRequest(url, SERVER_URL), false, url);
  }
});
