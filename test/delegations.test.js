import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  codexDelegationCommand,
  createDelegationReader,
  delegationLinkIdFromCommand,
  delegationRoot,
  parseDelegationRecord,
  resolveDelegations,
} from '../src/delegations.js';

const LINK_ID = 'agl_0123456789abcdefghijklmn';
const CHILD_ID = '11111111-1111-4111-8111-111111111111';

function runningRecord(now = Date.now()) {
  return {
    version: 1,
    linkId: LINK_ID,
    childSource: 'codex',
    childSessionId: CHILD_ID,
    status: 'running',
    startedAt: now - 1_000,
    updatedAt: now - 500,
    expiresAt: now + 60_000,
  };
}

test('validates the delegation sidecar schema and shared root', () => {
  const now = Date.now();
  assert.deepEqual(parseDelegationRecord(runningRecord(now), now), runningRecord(now));
  assert.equal(parseDelegationRecord({ ...runningRecord(now), expiresAt: undefined }, now), null);
  assert.equal(parseDelegationRecord({ ...runningRecord(now), childSource: 'other' }, now), null);
  assert.equal(parseDelegationRecord({
    ...runningRecord(now),
    status: 'complete',
    expiresAt: undefined,
    endedAt: now - 100,
    updatedAt: now,
  }, now)?.status, 'complete');
  assert.equal(parseDelegationRecord({
    ...runningRecord(now),
    status: 'failed',
    expiresAt: undefined,
  }, now), null);

  assert.equal(
    delegationRoot({}, '/users/tester'),
    path.join('/users/tester', '.agentarium-space', 'delegations-v1'),
  );
  assert.equal(delegationRoot({ AGENTARIUM_DELEGATION_DIR: 'relative' }, '/users/tester'),
    path.join('/users/tester', '.agentarium-space', 'delegations-v1'));
  assert.equal(delegationRoot({ AGENTARIUM_DELEGATION_DIR: '/state/delegations' }, '/users/tester'),
    path.resolve('/state/delegations'));
});

test('extracts only allowlisted wrapper markers from Claude and Codex tool calls', () => {
  const codexCommand = `bash /Users/test/.claude/skills/codex/scripts/run-codex.sh /repo /tmp/prompt --agentarium-link ${LINK_ID}`;
  const claudeCommand = `bash C:/Users/test/.agents/skills/claude/scripts/run-claude-write.sh C:/repo C:/tmp/prompt --agentarium-link ${LINK_ID}`;
  assert.equal(delegationLinkIdFromCommand(codexCommand, 'codex'), LINK_ID);
  assert.equal(delegationLinkIdFromCommand(claudeCommand, 'claude'), LINK_ID);
  assert.equal(delegationLinkIdFromCommand(
    `bash /tmp/run-claude.sh /repo /tmp/prompt --agentarium-link ${LINK_ID}`,
    'claude',
  ), null);
  assert.equal(delegationLinkIdFromCommand(`${claudeCommand} --agentarium-link ${LINK_ID}x`, 'claude'), null);

  assert.equal(codexDelegationCommand(JSON.stringify({ cmd: claudeCommand }), null), claudeCommand);
  const raw = `const result = await tools.exec_command({cmd:${JSON.stringify(claudeCommand)},yield_time_ms:10000});`;
  assert.equal(codexDelegationCommand(null, raw), claudeCommand);
});

test('resolves duplicate session ids by activity evidence and aggregates endpoint pairs', () => {
  const now = Date.now();
  const parent = {
    id: 'parent', key: '/logs/parent.jsonl', source: 'claude', lastActivity: now - 100,
  };
  const child = {
    id: CHILD_ID,
    key: '/logs/current.jsonl',
    source: 'codex',
    lastActivity: now - 200,
    parentId: 'native-codex-parent',
  };
  const staleDuplicate = {
    id: CHILD_ID, key: '/logs/stale.jsonl', source: 'codex', lastActivity: now - 120_000,
  };
  const record = runningRecord(now);
  const start = {
    linkId: LINK_ID,
    parentKey: parent.key,
    parentSource: 'claude',
    startedAt: record.startedAt,
  };
  const links = resolveDelegations([record], [start], [parent, child, staleDuplicate], now);
  assert.equal(links.length, 1);
  assert.equal(links[0].childKey, child.key);
  assert.equal(child.parentId, 'native-codex-parent');

  const ambiguous = { ...staleDuplicate, lastActivity: now - 300 };
  assert.deepEqual(resolveDelegations([record], [start], [parent, child, ambiguous], now), []);

  const nextRecord = { ...record, linkId: 'agl_abcdefghijklmnopqrstuvwx', updatedAt: now - 100 };
  const nextStart = { ...start, linkId: nextRecord.linkId };
  const aggregated = resolveDelegations([record, nextRecord], [start, nextStart], [parent, child], now);
  assert.equal(aggregated.length, 1);
  assert.equal(aggregated[0].count, 2);
});

test('reader ignores malformed and symlinked sidecars', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentarium-delegations-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'valid.json'), JSON.stringify(runningRecord()));
  await writeFile(path.join(root, 'invalid.json'), '{broken');
  await symlink(path.join(root, 'valid.json'), path.join(root, 'link.json'));
  const reader = createDelegationReader({ root });
  const records = await reader.scan();
  assert.equal(records.length, 1);
  assert.equal(records[0].linkId, LINK_ID);
  await reader.close();
});

test('reader fails open on ready timeout and closes a partially started watcher', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentarium-reader-timeout-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let closeCount = 0;
  const watchFactory = () => {
    const watcher = new EventEmitter();
    watcher.close = async () => { closeCount += 1; };
    return watcher;
  };
  const reader = createDelegationReader({ root, watchFactory, startupTimeoutMs: 10 });
  await reader.start();
  assert.equal(reader.getState(), 'disabled');
  assert.equal(closeCount, 1);
  await reader.close();
  assert.equal(reader.getState(), 'closed');
});

test('reader close cancels an in-flight start without late resurrection', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentarium-reader-close-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let closeCount = 0;
  const watchFactory = () => {
    const watcher = new EventEmitter();
    watcher.close = async () => { closeCount += 1; };
    return watcher;
  };
  const reader = createDelegationReader({ root, watchFactory, startupTimeoutMs: 100 });
  const starting = reader.start();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await reader.close();
  await starting;
  assert.equal(reader.getState(), 'closed');
  assert.ok(closeCount >= 1);
});

test('reader rescans sidecars created while the watcher is starting', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentarium-reader-gap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'late.json');
  let closeCount = 0;
  const watchFactory = () => {
    const watcher = new EventEmitter();
    watcher.close = async () => { closeCount += 1; };
    void writeFile(filePath, JSON.stringify(runningRecord())).then(() => watcher.emit('ready'));
    return watcher;
  };
  const reader = createDelegationReader({ root, watchFactory, startupTimeoutMs: 100 });
  await reader.start();
  assert.equal(reader.getState(), 'running');
  assert.equal(reader.getRecords().length, 1);
  assert.equal(reader.getRecords()[0].linkId, LINK_ID);
  await reader.close();
  assert.equal(closeCount, 1);
});
