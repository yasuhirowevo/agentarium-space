import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDemoFixture } from '../scripts/demo-fixture.mjs';
import { createClaudeWatcher } from '../src/watchers/claude.js';
import { createCodexWatcher } from '../src/watchers/codex.js';

test('demo uses isolated fictional sessions through the real watchers', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agentarium-demo-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = Date.now();
  const demo = await createDemoFixture(root, { now });
  assert.deepEqual((await readdir(root)).sort(), ['claude', 'codex']);
  const claude = createClaudeWatcher({ root: demo.claudeRoot });
  const codex = createCodexWatcher({ root: demo.codexRoot });
  t.after(async () => { await claude.close(); await codex.close(); });
  const scan = async (at) => [...await claude.scan(at), ...await codex.scan(at)];
  const audit = (sessions) => {
    assert.equal(sessions.length, 5);
    assert.deepEqual(sessions.map((s) => s.id).sort(), [...demo.expectedIds].sort());
    assert.deepEqual([...new Set(sessions.map((s) => s.cwd))].sort(), [...demo.projectPaths].sort());
    assert.equal(sessions.filter((s) => s.parentId === demo.ids.weather).length, 2);
    for (const session of sessions) {
      assert.ok(session.key.startsWith(root.replaceAll('\\', '/')));
      assert.ok(session.outputTokensTotal > 0);
      assert.ok(session.title.length > 0);
    }
  };
  const initial = await scan(now);
  audit(initial);
  const notes = initial.find((s) => s.id === demo.ids.notes);
  assert.equal(notes.status, 'tool');
  assert.equal(notes.subAgents[0].status, 'running');
  assert.equal(initial.find((s) => s.id === demo.ids.guide).status, 'waiting');
  assert.equal(initial.find((s) => s.id === demo.ids.weather).status, 'thinking');
  assert.equal(initial.find((s) => s.id === demo.ids.weather).codexDetails.delegations.length, 2);
  await demo.advance(12000);
  const middle = await scan(now + 12000);
  audit(middle);
  assert.equal(middle.find((s) => s.id === demo.ids.weather).status, 'tool');
  assert.equal(middle.find((s) => s.id === demo.ids.cards).codexDetails.fileChanges.length, 2);
  await demo.advance(24000);
  const final = await scan(now + 24000);
  audit(final);
  const weather = final.find((s) => s.id === demo.ids.weather);
  assert.equal(weather.status, 'waiting');
  assert.equal(weather.codexDetails.commands[0].outcome, 'success');
  assert.ok(weather.codexDetails.plan.steps.every((step) => step.status === 'completed'));
  await demo.advance(24000);
  assert.deepEqual(await scan(now + 24000), final, 'advancing twice must not duplicate events');
});
