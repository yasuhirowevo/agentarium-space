import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition was not met before timeout');
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
    assert.deepEqual(browserSnapshot.delegations, []);

    const nativeSnapshot = await receiveSnapshot(websocketUrl);
    assert.equal(nativeSnapshot.type, 'snapshot');
    assert.deepEqual(nativeSnapshot.sessions, []);
    assert.deepEqual(nativeSnapshot.delegations, []);
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

test('publishes an explicit Claude to Codex delegation without changing native parentId', async (t) => {
  const roots = await createWatcherRoots('agentarium-space-delegation-');
  const delegationRoot = path.join(roots.root, 'delegations');
  const claudeProject = path.join(roots.claudeRoot, 'project');
  const now = Date.now();
  const startedAt = now - 1_000;
  const parentId = '22222222-2222-4222-8222-222222222222';
  const childId = '11111111-1111-4111-8111-111111111111';
  const linkId = 'agl_0123456789abcdefghijklmn';
  const date = new Date(now);
  const codexDirectory = path.join(
    roots.codexRoot,
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  );
  await Promise.all([
    mkdir(claudeProject, { recursive: true }),
    mkdir(codexDirectory, { recursive: true }),
    mkdir(delegationRoot, { recursive: true }),
  ]);

  const parentRecord = {
    type: 'assistant',
    timestamp: new Date(startedAt).toISOString(),
    sessionId: parentId,
    cwd: '/workspace/project',
    message: {
      content: [{
        type: 'tool_use',
        id: 'tool-1',
        name: 'Bash',
        input: {
          command: `bash /Users/test/.claude/skills/codex/scripts/run-codex.sh /workspace/project /tmp/prompt --agentarium-link ${linkId}`,
        },
      }],
    },
  };
  await writeFile(
    path.join(claudeProject, `${parentId}.jsonl`),
    `${JSON.stringify(parentRecord)}\n`,
  );

  const childRecords = [{
    timestamp: new Date(startedAt + 100).toISOString(),
    type: 'session_meta',
    payload: { id: childId, cwd: '/workspace/project' },
  }, {
    timestamp: new Date(startedAt + 200).toISOString(),
    type: 'event_msg',
    payload: { type: 'task_started' },
  }];
  await writeFile(
    path.join(codexDirectory, `rollout-2026-08-02T00-00-00-${childId}.jsonl`),
    `${childRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
  );
  await writeFile(path.join(delegationRoot, `${linkId}.json`), JSON.stringify({
    version: 1,
    linkId,
    childSource: 'codex',
    childSessionId: childId,
    status: 'running',
    startedAt,
    updatedAt: startedAt + 150,
    expiresAt: now + 60_000,
  }));

  const handle = await startServer({
    port: 0,
    claudeRoot: roots.claudeRoot,
    codexRoot: roots.codexRoot,
    delegationRoot,
  });
  t.after(async () => {
    await handle.close();
    await rm(roots.root, { recursive: true, force: true });
  });

  const snapshot = await waitFor(() => {
    const candidate = handle.getSnapshot();
    return candidate.delegations.length ? candidate : null;
  });
  assert.equal(snapshot.delegations.length, 1);
  assert.equal(snapshot.delegations[0].parentSource, 'claude');
  assert.equal(snapshot.delegations[0].childSource, 'codex');
  assert.equal(snapshot.sessions.find((session) => session.id === childId).parentId, null);
});
