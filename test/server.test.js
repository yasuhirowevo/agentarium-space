import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { startServer } from '../src/server.js';

function requestStatus(url, headers = {}, rawPath) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const outgoing = request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: rawPath ?? `${target.pathname}${target.search}`,
      headers,
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
}

function rejectedWebSocketStatus(url, options = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options);
    let settled = false;
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      operation();
    };
    const timeout = setTimeout(() => {
      finish(() => reject(new Error('WebSocket rejection timed out')));
      socket.terminate();
    }, 3000);

    socket.once('unexpected-response', (_request, response) => {
      const { statusCode } = response;
      response.resume();
      finish(() => resolve(statusCode));
    });
    socket.once('open', () => {
      finish(() => reject(new Error('WebSocket unexpectedly opened')));
      socket.close();
    });
    socket.once('error', (error) => {
      finish(() => reject(error));
    });
  });
}

async function receiveSnapshot(url, options = {}) {
  const socket = new WebSocket(url, options);
  const message = once(socket, 'message');
  await once(socket, 'open');
  const [payload] = await message;
  socket.close();
  await once(socket, 'close');
  return JSON.parse(payload.toString());
}

async function createWatcherRoots(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const claudeRoot = path.join(root, 'claude');
  const codexRoot = path.join(root, 'codex');
  await Promise.all([
    mkdir(claudeRoot, { recursive: true }),
    mkdir(codexRoot, { recursive: true }),
  ]);
  return { root, claudeRoot, codexRoot };
}

test('startup token protects HTTP assets and WebSocket snapshots', async (t) => {
  const roots = await createWatcherRoots('agentarium-space-test-');
  const handle = await startServer({
    port: 0,
    claudeRoot: roots.claudeRoot,
    codexRoot: roots.codexRoot,
  });
  t.after(async () => {
    await handle.close();
    await rm(roots.root, { recursive: true, force: true });
  });

  const protectedUrl = new URL(handle.url);
  const token = protectedUrl.pathname.split('/')[1];
  const websocketUrl = new URL('ws', protectedUrl);
  websocketUrl.protocol = 'ws:';

  assert.match(token, /^[A-Za-z0-9_-]{43}$/);

  await t.test('serves only the exact token path', async () => {
    const page = await fetch(protectedUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Agentarium Space<\/title>/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');

    const stylesheet = await fetch(new URL('office.css', protectedUrl));
    assert.equal(stylesheet.status, 200);

    const rootUrl = new URL('/', protectedUrl);
    assert.equal((await fetch(rootUrl)).status, 403);

    rootUrl.searchParams.set('token', token);
    assert.equal((await fetch(rootUrl)).status, 403);

    const wrongTokenUrl = new URL(`/${token}suffix/`, protectedUrl);
    assert.equal((await fetch(wrongTokenUrl)).status, 403);

    const withoutSlash = new URL(protectedUrl);
    withoutSlash.pathname = withoutSlash.pathname.slice(0, -1);
    const redirect = await fetch(withoutSlash, { redirect: 'manual' });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get('location'), protectedUrl.pathname);

    const traversalPath = `/${token}/..%2FREADME.md`;
    assert.equal(await requestStatus(protectedUrl, {}, traversalPath), 403);
    assert.equal(await requestStatus(protectedUrl, { Host: 'example.com' }), 403);
  });

  await t.test('requires the token before a WebSocket upgrade', async () => {
    const missingTokenUrl = new URL('/ws', websocketUrl);
    assert.equal(await rejectedWebSocketStatus(missingTokenUrl), 403);

    const queryTokenUrl = new URL('/ws', websocketUrl);
    queryTokenUrl.searchParams.set('token', token);
    assert.equal(await rejectedWebSocketStatus(queryTokenUrl), 403);

    const wrongTokenUrl = new URL(`/${token}suffix/ws`, websocketUrl);
    assert.equal(await rejectedWebSocketStatus(wrongTokenUrl), 403);
  });

  await t.test('keeps Origin validation after token authentication', async () => {
    assert.equal(await rejectedWebSocketStatus(websocketUrl, {
      origin: 'https://example.com',
    }), 403);

    const browserSnapshot = await receiveSnapshot(websocketUrl, {
      origin: protectedUrl.origin,
    });
    assert.equal(browserSnapshot.type, 'snapshot');
    assert.deepEqual(browserSnapshot.sessions, []);

    const nativeSnapshot = await receiveSnapshot(websocketUrl);
    assert.equal(nativeSnapshot.type, 'snapshot');
    assert.deepEqual(nativeSnapshot.sessions, []);
  });

  await t.test('invalidates the old token after restart', async (restartTest) => {
    const nextRoots = await createWatcherRoots('agentarium-space-restart-');
    const nextHandle = await startServer({
      port: 0,
      claudeRoot: nextRoots.claudeRoot,
      codexRoot: nextRoots.codexRoot,
    });
    restartTest.after(async () => {
      await nextHandle.close();
      await rm(nextRoots.root, { recursive: true, force: true });
    });

    const nextUrl = new URL(nextHandle.url);
    assert.notEqual(nextUrl.pathname, protectedUrl.pathname);
    const staleUrl = new URL(protectedUrl.pathname, nextUrl.origin);
    assert.equal((await fetch(staleUrl)).status, 403);
  });
});
