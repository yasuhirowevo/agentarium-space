import assert from 'node:assert/strict';
import { appendFileSync, utimesSync } from 'node:fs';
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createClaudeWatcher } from '../src/watchers/claude.js';
import { createCodexWatcher } from '../src/watchers/codex.js';

const sources = [
  {
    name: 'Codex',
    create: createCodexWatcher,
    directory: ['2026', '09', '23'],
    newDirectory: ['2027', '01', '01'],
    records(id, text) {
      const timestamp = new Date().toISOString();
      return [
        { timestamp, type: 'session_meta', payload: { id, cwd: '/fixture/project' } },
        { timestamp, type: 'event_msg', payload: { type: 'agent_message', message: text } },
      ];
    },
  },
  {
    name: 'Claude',
    create: createClaudeWatcher,
    directory: ['project'],
    newDirectory: ['new-project'],
    records(id, text) {
      return [{
        timestamp: new Date().toISOString(),
        type: 'assistant',
        sessionId: id,
        cwd: '/fixture/project',
        message: { content: [{ type: 'text', text }] },
      }];
    },
  },
];

function encode(source, id, text) {
  return `${source.records(id, text).map((record) => JSON.stringify(record)).join('\n')}\n`;
}

async function fixture(t, source) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentarium-live-watch-'));
  const directory = path.join(root, ...source.directory);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'existing.jsonl');
  await writeFile(file, encode(source, 'existing', 'Initial message'));
  let updates = 0;
  const watcher = source.create({ root, onUpdate: () => { updates += 1; } });
  t.after(async () => {
    await watcher.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, directory, file, watcher, updates: () => updates };
}

async function waitForMessage(watcher, id, message) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (watcher.getSessions().some((session) => session.id === id && session.lastMessage === message)) return;
    await delay(20);
  }
  assert.fail(`Live watcher did not receive ${id}: ${message}`);
}

for (const source of sources) {
  test(`${source.name} live watcher reads appended records without rescanning`, async (t) => {
    const { file, watcher, updates } = await fixture(t, source);
    await watcher.start();
    assert.equal(updates(), 1);
    await appendFile(file, encode(source, 'existing', 'Appended message'));
    await waitForMessage(watcher, 'existing', 'Appended message');
    assert.equal(updates(), 2, 'duplicate native notifications must not replay a record');
    assert.equal(watcher.getSessions().length, 1);
  });

  test(`${source.name} live watcher discovers new sessions and directories`, async (t) => {
    const { root, directory, watcher, updates } = await fixture(t, source);
    await watcher.start();
    await writeFile(path.join(directory, 'new-file.jsonl'), encode(source, 'new-file', 'New session'));
    await waitForMessage(watcher, 'new-file', 'New session');
    const newDirectory = path.join(root, ...source.newDirectory);
    await mkdir(newDirectory, { recursive: true });
    await writeFile(path.join(newDirectory, 'new-directory.jsonl'), encode(source, 'new-directory', 'New directory'));
    await waitForMessage(watcher, 'new-directory', 'New directory');
    assert.equal(updates(), 3);
    assert.equal(watcher.getSessions().length, 3);
  });

  test(`${source.name} live watcher reads Windows appends with unchanged mtime`, {
    skip: process.platform !== 'win32' ? 'Windows native notification regression' : false,
  }, async (t) => {
    const { file, watcher, updates } = await fixture(t, source);
    const modified = new Date(Date.now() - 20_000);
    const accessed = new Date(Date.now() - 10_000);
    utimesSync(file, accessed, modified);
    await watcher.start();
    // Restore timestamps before yielding so the native notification sees size
    // growth with unchanged mtime and atime > mtime, as open Windows logs do.
    appendFileSync(file, encode(source, 'existing', 'Appended with unchanged mtime'));
    utimesSync(file, accessed, modified);
    await waitForMessage(watcher, 'existing', 'Appended with unchanged mtime');
    assert.equal(updates(), 2);
    assert.equal(watcher.getSessions().length, 1);
  });
}
