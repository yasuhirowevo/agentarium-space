import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Script } from 'node:vm';
import * as contextMetrics from '../ui/context-metrics.js';
import * as calloutPolicy from '../ui/callout-policy.js';
import { activityMotionFor } from '../ui/activity-motion.js';

// Exercise the browser classes without starting App or adding production test hooks.
const source = readFileSync(new URL('../ui/office.js', import.meta.url), 'utf8');
assert.match(source, /new App\(\);\s*$/);
const script = new Script(source
  .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\r?\n/gm, '')
  .replace(/new App\(\);\s*$/, '({ Store, Sim, Renderer });'));

function session(overrides = {}) {
  return {
    key: 'codex:synthetic', id: 'synthetic', source: 'codex',
    projectName: 'Synthetic project', cwd: '/synthetic',
    title: 'Synthetic session', status: 'tool', activity: 'Read',
    lastActivity: 1, recentEvents: [], subAgents: [], ...overrides,
  };
}

function scene(sessions) {
  const { Store, Sim, Renderer } = script.runInNewContext({
    document: { querySelector: () => null, hidden: false },
    ...contextMetrics, ...calloutPolicy, activityMotionFor,
  });
  const store = new Store();
  const sim = new Sim(store);
  const renderer = new Renderer({ getContext: () => null }, store, sim);
  sim.resize(1000, 700);
  const snapshot = (next) => {
    store.applySnapshot(next);
    sim.syncSnapshot();
  };
  snapshot(sessions);
  return { store, sim, renderer, snapshot };
}

function advance(sim, seconds, eachFrame = () => {}) {
  const frames = Math.ceil(seconds * 30);
  for (let frame = 0; frame < frames; frame += 1) {
    sim.update(1 / 30, sim.time + 1 / 30);
    eachFrame();
  }
}

function drawingContext() {
  return {
    arcs: [], strokes: [], globalAlpha: 1,
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, fill() {},
    arc(x, y, radius) { this.arcs.push({ x, y, radius, alpha: this.globalAlpha }); },
    stroke() { this.strokes.push({ style: this.strokeStyle, alpha: this.globalAlpha }); },
    createLinearGradient() { return { addColorStop() {} }; },
  };
}

function trails(scene) {
  const ctx = drawingContext();
  scene.renderer.drawTrails(ctx);
  return ctx;
}

test('reading and writing replace recurring ripples but preserve activity ripples and event pops', () => {
  for (const activity of ['Read', 'apply_patch']) {
    const raw = session({ activity });
    const current = scene([raw]);
    advance(current.sim, 8, () => assert.equal(current.sim.ripples.length, 0));
    current.snapshot([{ ...raw, lastActivity: 2, recentEvents: ['12:00 Synthetic tool event'] }]);
    current.sim.update(1 / 30, current.sim.time + 1 / 30);
    assert.equal(current.sim.ripples.length, 1);
    assert.equal(current.sim.ripples[0].strength, 0.9);
    assert.equal(current.store.eventPops.length, 1);
    assert.equal(current.store.eventPops[0].label, 'Synthetic tool event');
    advance(current.sim, 2);
    advance(current.sim, 6, () => assert.equal(current.sim.ripples.length, 0));
  }
  for (const activity of ['exec_command', 'functions.exec', 'UnknownTool', null]) {
    const current = scene([session({ activity })]);
    let previousRipple;
    let emitted = 0;
    advance(current.sim, 8, () => {
      const latest = current.sim.ripples.at(-1);
      if (latest && latest !== previousRipple) {
        emitted += 1;
        previousRipple = latest;
      }
    });
    assert.ok(emitted >= 3, `${activity} retains recurring tool ripples`);
  }
});

test('motion crossfades between activities and stops after waiting, idle, or departure', () => {
  const raw = session();
  const current = scene([raw]);
  advance(current.sim, 3);
  const entity = current.store.entities.get(raw.key);
  assert.ok(entity.motionWeights.reading > 0.99);
  current.snapshot([{ ...raw, activity: 'Write' }]);
  current.sim.update(1 / 30, current.sim.time + 1 / 30);
  assert.ok(entity.motionWeights.reading > 0 && entity.motionWeights.reading < 1);
  assert.ok(entity.motionWeights.writing > 0 && entity.motionWeights.writing < 1);
  assert.equal(trails(current).arcs.length, 6, 'both effects are present during the crossfade');
  advance(current.sim, 3);
  assert.ok(entity.motionWeights.reading < 0.01);
  assert.ok(entity.motionWeights.writing > 0.99);
  assert.equal(trails(current).arcs.length, 3);

  for (const status of ['thinking', 'waiting', 'idle']) {
    current.snapshot([{ ...raw, activity: 'Write', status }]);
    advance(current.sim, 3);
    assert.equal(trails(current).arcs.length, status === 'thinking' ? 3 : 0);
    assert.equal(current.sim.ripples.length, 0);
  }
  current.snapshot([raw]);
  advance(current.sim, 3);
  current.snapshot([]);
  current.sim.update(1 / 30, current.sim.time + 1 / 30);
  assert.ok(entity.motionWeights.reading > 0 && entity.motionWeights.reading < 1);
  advance(current.sim, 3);
  assert.equal(trails(current).arcs.length, 0);
  assert.equal(current.store.entities.size, 0);
});

test('tool motes move in the stated direction, fit each orb, and stay bounded over time', () => {
  for (const activity of ['Read', 'Write']) {
    const current = scene([
      session({ key: 'codex:parent', id: 'parent', status: 'waiting' }),
      session({ activity, parentId: 'parent' }),
    ]);
    advance(current.sim, 3);
    const entity = current.store.entities.get('codex:synthetic');
    assert.equal(entity.isSatellite, true);
    assert.ok(entity.scale < 0.61, 'satellite uses its smaller visual scale');
    const first = drawingContext();
    current.renderer.drawToolMotes(first, entity);
    current.sim.time += 0.001;
    const second = drawingContext();
    current.renderer.drawToolMotes(second, entity);
    assert.equal(first.arcs.length, 3);
    assert.equal(first.strokes.length, activity === 'Write' ? 3 : 0);
    for (let index = 0; index < first.arcs.length; index += 1) {
      const before = Math.hypot(first.arcs[index].x - entity.x, first.arcs[index].y - entity.y);
      const after = Math.hypot(second.arcs[index].x - entity.x, second.arcs[index].y - entity.y);
      assert.ok(activity === 'Read' ? after < before : after > before);
      assert.ok(before <= entity.baseRadius * entity.scale * 2.4);
    }
    advance(current.sim, 60, () => {
      assert.equal(trails(current).arcs.length, 3);
      assert.equal(current.sim.particles.length, 0, 'tool motes do not accumulate retained particles');
    });
  }
});

test('satellite emphasis follows the child activity and fades without changing the parent', () => {
  const parent = session({ key: 'codex:parent', id: 'parent', status: 'waiting' });
  const child = session({ parentId: 'parent', status: 'thinking' });
  const current = scene([parent, child]);
  advance(current.sim, 3);
  const entity = current.store.entities.get(child.key);
  const active = drawingContext();
  current.renderer.drawRelationships(active);
  assert.ok(entity.connectionActivity > 0.99);
  assert.ok(active.arcs.length >= 2 && active.arcs.length <= 3);
  assert.equal(active.strokes.length, 1);
  assert.equal(current.store.sessionsByKey.get(parent.key).status, 'waiting');

  current.snapshot([parent, { ...child, status: 'waiting' }]);
  current.sim.update(1 / 30, current.sim.time + 1 / 30);
  assert.ok(entity.connectionActivity > 0 && entity.connectionActivity < 1);
  advance(current.sim, 3);
  const waiting = drawingContext();
  current.renderer.drawRelationships(waiting);
  assert.equal(waiting.arcs.length, 0);
  assert.equal(waiting.strokes.length, 1, 'the static relationship remains visible');
  current.snapshot([parent, { ...child, status: 'tool', activity: 'Read' }]);
  advance(current.sim, 3);
  assert.ok(entity.connectionActivity > 0.99);
  current.snapshot([parent]);
  current.sim.update(1 / 30, current.sim.time + 1 / 30);
  assert.ok(entity.connectionActivity < 1);
  advance(current.sim, 3);
  assert.equal(current.store.entities.has(child.key), false);
  assert.equal(current.store.sessionsByKey.get(parent.key).status, 'waiting');
});

test('Claude sparks emphasize only observed running work and preserve completion', () => {
  const raw = session({ source: 'claude', status: 'waiting', subAgents: [
    { id: 'running', status: 'running' }, { id: 'unknown', status: 'unknown' },
  ] });
  const current = scene([raw]);
  advance(current.sim, 3);
  const entity = current.store.entities.get(raw.key);
  const running = entity.sparks.get('running');
  const unknown = entity.sparks.get('unknown');
  assert.ok(running.activityGlow > 0.99);
  assert.equal(unknown.activityGlow, 0);
  assert.ok(running.history.length <= 12 && unknown.history.length <= 12);
  assert.equal(entity.session.status, 'waiting');
  current.snapshot([{ ...raw, subAgents: [
    { id: 'running', status: 'done' }, { id: 'unknown', status: 'unknown' },
  ] }]);
  current.sim.update(1 / 30, current.sim.time + 1 / 30);
  assert.ok(running.activityGlow > 0 && running.activityGlow < 1);
  assert.ok(current.sim.particles.length > 0, 'completion burst is preserved');
  advance(current.sim, 3);
  assert.equal(entity.sparks.has('running'), false);
  assert.equal(entity.sparks.has('unknown'), true);
  assert.equal(current.sim.particles.length, 0);
  current.snapshot([{ ...raw, subAgents: [{ id: 'running', status: 'done' }] }]);
  advance(current.sim, 3);
  assert.equal(entity.sparks.size, 0, 'completed sparks do not reappear from repeated snapshots');
});

test('reduced motion clears transient effects and suppresses motes and flowing relationship points', () => {
  const parent = session({ key: 'codex:parent', id: 'parent', status: 'thinking',
    subAgents: [{ id: 'spark', status: 'running' }] });
  const child = session({ parentId: 'parent', activity: 'Write' });
  const current = scene([parent, child]);
  advance(current.sim, 3);
  assert.ok(trails(current).arcs.length > 0);
  current.snapshot([parent, { ...child, lastActivity: 2, recentEvents: ['12:00 Synthetic event'] }]);
  current.sim.update(1 / 30, current.sim.time + 1 / 30);
  assert.ok(current.sim.ripples.length > 0);
  current.sim.setReducedMotion(true);
  assert.equal(current.sim.ripples.length, 0);
  assert.equal(current.store.eventPops.length, 0);
  current.snapshot([{ ...parent, subAgents: [{ id: 'spark', status: 'done' }] },
    { ...child, lastActivity: 3, recentEvents: ['12:00 Synthetic event', '12:01 Synthetic event'] }]);
  advance(current.sim, 3, () => {
    assert.equal(trails(current).arcs.length, 0);
    assert.equal(current.sim.ripples.length, 0);
    assert.equal(current.sim.particles.length, 0);
    assert.equal(current.store.eventPops.length, 0);
  });
  const ctx = drawingContext();
  current.renderer.drawRelationships(ctx);
  assert.equal(ctx.arcs.length, 0);
  assert.equal(ctx.strokes.length, 1, 'reduced motion retains the static relationship');
});
