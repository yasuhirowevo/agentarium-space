import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Script } from 'node:vm';
import * as contextMetrics from '../ui/context-metrics.js';
import * as calloutPolicy from '../ui/callout-policy.js';
import { activityMotionFor } from '../ui/activity-motion.js';
import { assignmentLabel } from '../ui/codex-details.js';

const source = readFileSync(new URL('../ui/office.js', import.meta.url), 'utf8');
const script = new Script(source
  .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\r?\n/gm, '')
  .replace(/new App\(\);\s*$/, '({ Store, Sim, Renderer, DetailPanel });'));

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.textContent = '';
  }

  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener() {}
  get firstElementChild() { return this.children[0]; }
}

function session(id, overrides = {}) {
  return {
    key: `codex:${id}`, id, source: 'codex', projectName: 'Synthetic', cwd: '/synthetic',
    title: id, status: 'thinking', lastActivity: Date.now(), recentEvents: [], subAgents: [],
    ...overrides,
  };
}

function scene(sessions, reducedMotion = true) {
  const elements = new Map();
  const document = {
    hidden: false,
    querySelector(selector) {
      if (!elements.has(selector)) {
        const element = new Element();
        element.append(new Element());
        elements.set(selector, element);
      }
      return elements.get(selector);
    },
    createElement: (tagName) => new Element(tagName),
    createDocumentFragment: () => new Element('fragment'),
  };
  const { Store, Sim, Renderer, DetailPanel } = script.runInNewContext({
    document, ...contextMetrics, ...calloutPolicy, activityMotionFor, assignmentLabel,
  });
  const store = new Store();
  const sim = new Sim(store, reducedMotion);
  const renderer = new Renderer({ getContext: () => null }, store, sim);
  const panel = Object.create(DetailPanel.prototype);
  panel.store = store;
  panel.getRecentEventCount = () => 0;
  renderer.width = 1000;
  renderer.height = 700;
  sim.resize(1000, 700);
  const snapshot = (next) => {
    store.applySnapshot(next);
    sim.syncSnapshot();
  };
  snapshot(sessions);
  return { store, sim, renderer, panel, elements, snapshot, document };
}

function advance(sim, seconds, eachFrame = () => {}) {
  for (let frame = 0; frame < Math.ceil(seconds * 30); frame += 1) {
    sim.update(1 / 30, sim.time + 1 / 30);
    eachFrame();
  }
}

function drawingContext() {
  return {
    texts: [], lines: [], ellipses: [], font: '',
    save() {}, restore() {}, beginPath() {}, moveTo() {}, stroke() {},
    lineTo(x, y) { this.lines.push({ x, y }); },
    ellipse(x, y, radiusX, radiusY) { this.ellipses.push({ x, y, radiusX, radiusY }); },
    measureText: (text) => ({ width: Array.from(text).length * 4 }),
    fillText(text, x, y) { this.texts.push({ text, x, y, font: this.font }); },
  };
}

test('all observed child identities stay separate from main callout sessions', () => {
  for (const child of [session('unknown-parent', { parentId: 'missing' }),
    session('source-only', { isSubAgent: true }),
    session('legacy', { model: 'codex-auto-review' })]) {
    assert.equal(calloutPolicy.isChildSession(child), true);
    assert.equal(calloutPolicy.isMainCalloutSession(child), false);
    assert.deepEqual(calloutPolicy.mainCalloutsFor(child, []), []);
  }
  for (const main of [session('normal'), session('auto-review', { isSubAgent: false, model: 'fixture-model' })]) {
    assert.equal(calloutPolicy.isChildSession(main), false);
    assert.equal(calloutPolicy.isMainCalloutSession(main), true);
  }
  assert.equal(calloutPolicy.isChildSession(null), false);
  assert.equal(calloutPolicy.isMainCalloutSession(null), false);
});

test('parent appearance and disappearance change only attachment, keeping the child small', () => {
  for (const reducedMotion of [true, false]) {
    const childSession = session('child', { parentId: 'parent' });
    const parentSession = session('parent');
    const current = scene([childSession], reducedMotion);
    const child = current.store.entities.get(childSession.key);
    advance(current.sim, 6);
    assert.equal(child.targetScale, 0.6);
    assert.ok(Math.abs(child.scale - 0.6) < 0.001);
    assert.equal(child.isSatellite, false);
    assert.equal(child.orbitRadius, null);
    assert.ok(Number.isFinite(child.targetX) && Number.isFinite(child.targetY));
    const noParent = drawingContext();
    current.renderer.drawRelationships(noParent);
    current.renderer.drawOrbitRings(noParent);
    assert.equal(noParent.lines.length, 0);
    assert.equal(noParent.ellipses.length, 0);

    current.snapshot([parentSession, childSession]);
    advance(current.sim, 3, () => {
      assert.equal(child.targetScale, 0.6);
      assert.ok(child.scale < 0.601);
    });
    assert.equal(current.store.entities.get(childSession.key), child, 'identity and position state survive attachment');
    assert.equal(child.isSatellite, true);
    assert.ok(child.orbitRadius > 0);
    const parent = current.store.entities.get(parentSession.key);
    assert.equal(parent.targetScale, 1);
    assert.ok(parent.scale > 0.99);
    // Static rendering retains the observed link and belt without animated connection points.
    current.sim.setReducedMotion(true);
    const withParent = drawingContext();
    current.renderer.drawRelationships(withParent);
    current.renderer.drawOrbitRings(withParent);
    assert.equal(withParent.lines.length, 1);
    assert.equal(withParent.ellipses.length, 1);
    current.sim.setReducedMotion(reducedMotion);

    current.snapshot([childSession]);
    advance(current.sim, 3, () => {
      assert.equal(child.targetScale, 0.6);
      assert.ok(child.scale < 0.601);
    });
    assert.equal(current.store.entities.get(childSession.key), child);
    assert.equal(child.isSatellite, false);
    assert.equal(child.orbitRadius, null);
    assert.equal(child.beltSlot, null);
    const departedParent = drawingContext();
    current.renderer.drawRelationships(departedParent);
    current.renderer.drawOrbitRings(departedParent);
    assert.equal(departedParent.lines.length, 0);
    assert.equal(departedParent.ellipses.length, 0);
  }
});

test('rootless children keep small nameplates and matching callout collision geometry', () => {
  const sessions = [session('unknown', { parentId: 'missing', nickname: 'Scout' }),
    session('source', { isSubAgent: true }), session('legacy', { model: 'codex-auto-review' }),
    session('main')];
  const current = scene(sessions);
  advance(current.sim, 6);
  current.sim.pools.clear();
  // Focus this check on the actual nameplate path, separately from orb shading.
  current.renderer.drawOrb = () => {};
  const ctx = drawingContext();
  current.renderer.drawOrbs(ctx);
  const smallLabels = ctx.texts.filter((entry) => entry.font === '500 7px system-ui, sans-serif');
  assert.deepEqual(smallLabels.map((entry) => entry.text), ['◦ Scout', '◦ source', '◦ legacy']);
  assert.ok(ctx.texts.some((entry) => entry.text === 'main' && entry.font === '500 11px system-ui, sans-serif'));
  const obstacles = current.renderer.calloutObstacles();
  for (const raw of sessions.slice(0, 3)) {
    const entity = current.store.entities.get(raw.key);
    assert.equal(entity.targetScale, 0.6);
    assert.equal(entity.isSatellite, false);
    const label = smallLabels.find((entry) => entry.x === entity.x && entry.y === entity.y + entity.baseRadius * entity.scale * 1.9);
    assert.ok(label, 'rootless child nameplate remains below the orb');
    assert.ok(obstacles.some((rect) => rect.width === 86 && rect.height === 12
      && rect.x === label.x - 43 && rect.y === label.y - 6));
  }
  const main = current.store.entities.get('codex:main');
  assert.equal(main.targetScale, 1);
  assert.ok(obstacles.some((rect) => rect.x === main.x - 73 && rect.width === 146 && rect.height === 42));
});

test('the overview counts rootless children and labels their existing tree status text', () => {
  const sessions = [session('main', { subAgents: [{ id: 'spark', label: 'Spark', status: 'active' }] }),
    session('attached', { parentId: 'main' }), session('unknown', { parentId: 'missing' }),
    session('source', { isSubAgent: true }), session('legacy', { model: 'codex-auto-review' })];
  const current = scene(sessions);
  const normalized = [...current.store.sessionsByKey.values()];
  current.panel.renderOverviewStats();
  assert.equal(current.elements.get('#overview-subagent-count').textContent, '5');
  assert.equal(current.elements.get('#overview-session-count').textContent, '5');
  for (const raw of sessions) {
    const list = new Element('ul');
    const entry = current.store.sessionsByKey.get(raw.key);
    current.panel.appendOverviewSessionNode(list, entry, normalized, new Set());
    const row = list.children[0].children[0];
    assert.equal(row.tagName, 'button', 'child sessions remain selectable');
    const meta = row.children.find((element) => element.tagName === 'small');
    assert.equal(meta.textContent, ['unknown', 'source', 'legacy'].includes(entry.id)
      ? 'Sub-agent · Thinking' : 'Thinking');
  }
});
