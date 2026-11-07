import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Script } from 'node:vm';
import * as contextMetrics from '../ui/context-metrics.js';
import * as calloutPolicy from '../ui/callout-policy.js';
import { activityMotionFor } from '../ui/activity-motion.js';

const source = readFileSync(new URL('../ui/office.js', import.meta.url), 'utf8');
const script = new Script(source
  .replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];\r?\n/gm, '')
  .replace(/new App\(\);\s*$/, '({ Store, Sim, Renderer });'));

function scene(count = 1, overrides = {}) {
  const { Store, Sim, Renderer } = script.runInNewContext({
    document: { querySelector: () => null, hidden: false },
    ...contextMetrics, ...calloutPolicy, activityMotionFor,
  });
  const store = new Store();
  const sim = new Sim(store, true);
  const renderer = new Renderer({ getContext: () => null }, store, sim);
  renderer.width = 1200;
  renderer.height = 800;
  sim.resize(1200, 800);
  const now = Date.now();
  const sessions = Array.from({ length: count }, (_, index) => ({
    key: `codex:${index}`, id: `${index}`, source: 'codex', projectName: 'Synthetic',
    cwd: '/synthetic', title: `Agent ${index}`, status: 'thinking',
    lastActivity: now, recentEvents: [], subAgents: [],
    lastMessage: 'Short excerpt', lastMessageText: 'あ'.repeat(320),
    lastMessageAt: now - index, lastMessageKind: 'commentary', ...overrides,
  }));
  store.applySnapshot(sessions);
  sim.syncSnapshot();
  sim.update(1 / 30, 1 / 30);
  // These scenes position orbs explicitly; sector-label geometry is tested separately.
  sim.pools.clear();
  const entities = [...store.entities.values()];
  entities.forEach((entity, index) => Object.assign(entity, {
    x: 260 + (index % 2) * 600, y: 220 + Math.floor(index / 2) * 300,
    opacity: 1, scale: 1, baseRadius: 18,
  }));
  const ctx = {
    font: '', texts: [], measureText: (text) => ({ width: Array.from(text).length * 8 }),
    save() {}, restore() {}, beginPath() {}, arc() {}, fill() {}, moveTo() {}, lineTo() {}, stroke() {},
    fillText(text) { this.texts.push(text); },
  };
  return { store, sim, renderer, entities, sessions, ctx };
}

test('four simultaneous long messages fit without covering orbs, names or each other', () => {
  const { renderer, ctx } = scene(4);
  const obstacles = renderer.calloutObstacles();
  renderer.prepareCallouts(ctx);
  assert.equal(renderer.preparedCallouts.length, 4);
  for (const { content, geometry } of renderer.preparedCallouts) {
    assert.equal(content.lines.length, 4);
    assert.ok(content.lines.join('').length > 60);
    assert.ok(content.lines.at(-1).endsWith('…'));
    assert.ok(obstacles.every((rect) => !renderer.rectsOverlap(rect, geometry.collisionRect)));
    obstacles.push(geometry.collisionRect);
  }
  renderer.drawCallouts(ctx);
  assert.equal(ctx.texts.length, 20, 'four readable bodies and four speech headings');
});

test('selection expands to six lines and replaces, rather than duplicates, its spotlight', () => {
  const current = scene();
  current.sim.setFamilyFocus(null, current.entities[0].key);
  current.sim.update(1 / 30, 2 / 30);
  current.renderer.prepareCallouts(current.ctx);
  assert.equal(current.renderer.preparedCallouts.length, 1);
  assert.equal(current.renderer.preparedCallouts[0].content.lines.length, 6);
  assert.equal(current.renderer.isMessageCalloutVisible(current.entities[0].key), true);
});

test('legacy snapshots use the short excerpt; current snapshots use the longer text', () => {
  const current = scene(1, { lastMessageText: undefined });
  current.renderer.prepareCallouts(current.ctx);
  assert.equal(current.renderer.preparedCallouts[0].content.lines.join(''), 'Short excerpt');
});

test('sub-agent speech remains while completed work loses only its supplementary line', () => {
  const now = Date.now();
  const current = scene(1, { parentId: 'parent', codexDetails: {
    turn: { id: 'turn', status: 'active' },
    plan: { turnId: 'turn', updatedAt: now, steps: [{ status: 'in_progress', step: 'Inspect parser' }] },
  } });
  current.renderer.prepareCallouts(current.ctx);
  const first = current.renderer.preparedCallouts[0].content;
  assert.equal(first.lines.length, 5);
  assert.equal(first.messageLines, 4);
  assert.match(first.lines[4], /Inspect parser/);
  current.sim.update(19, 20);
  current.renderer.prepareCallouts(current.ctx);
  assert.equal(current.renderer.preparedCallouts.length, 1);
  assert.equal(current.renderer.preparedCallouts[0].content.hasMessage, true);
  assert.equal(current.renderer.isMessageCalloutVisible(current.entities[0].key), true);
  current.store.applySnapshot([{ ...current.sessions[0], status: 'waiting',
    codexDetails: { ...current.sessions[0].codexDetails, turn: { id: 'turn', status: 'completed' } } }]);
  current.sim.syncSnapshot();
  current.sim.update(1 / 30, 21);
  current.renderer.prepareCallouts(current.ctx);
  assert.equal(current.renderer.preparedCallouts.length, 1);
  assert.equal(current.renderer.preparedCallouts[0].content.lines.length, 4);
});

test('dense and edge scenes suppress impossible labels instead of forcing overlap', () => {
  const current = scene(4);
  for (const entity of current.entities) Object.assign(entity, { x: 80, y: 80 });
  current.renderer.width = 180;
  current.renderer.height = 160;
  current.renderer.prepareCallouts(current.ctx);
  assert.equal(current.renderer.preparedCallouts.length, 0);
  assert.equal(current.renderer.messageCalloutKeys.size, 0, 'short nameplate text remains available');
  current.renderer.width = 800;
  current.renderer.height = 500;
  // Allow the larger scene to separate the source orbs as the real simulation does.
  current.entities.forEach((entity, index) => Object.assign(entity, {
    x: 180 + (index % 2) * 400, y: 140 + Math.floor(index / 2) * 220,
  }));
  current.renderer.prepareCallouts(current.ctx);
  assert.ok(current.renderer.preparedCallouts.length > 0);
  const obstacles = current.renderer.calloutObstacles();
  for (const { geometry } of current.renderer.preparedCallouts) {
    const rect = geometry.collisionRect;
    assert.ok(rect.x >= 10 && rect.y >= 10 && rect.x + rect.width <= 790 && rect.y + rect.height <= 490);
    assert.ok(obstacles.every((other) => !current.renderer.rectsOverlap(other, rect)));
    obstacles.push(rect);
  }
});

test('a visible callout keeps its direction during movement and does not jump on collision', () => {
  const { renderer, ctx, entities, sim } = scene();
  renderer.prepareCallouts(ctx);
  const first = renderer.preparedCallouts[0].geometry;
  entities[0].x += 2;
  renderer.prepareCallouts(ctx);
  const moved = renderer.preparedCallouts[0].geometry;
  assert.equal(moved.slotName, first.slotName);
  assert.equal(moved.distance, first.distance);
  assert.equal(moved.labelX - first.labelX, 2);
  const originalObstacles = renderer.calloutObstacles.bind(renderer);
  renderer.calloutObstacles = () => [...originalObstacles(), moved.collisionRect];
  renderer.prepareCallouts(ctx);
  assert.equal(renderer.preparedCallouts.length, 0);
  sim.time += 0.5;
  renderer.prepareCallouts(ctx);
  assert.equal(renderer.preparedCallouts.length, 0, 'no immediate flip to a different direction');
  sim.time += 1;
  renderer.prepareCallouts(ctx);
  assert.equal(renderer.preparedCallouts.length, 1, 'invisible labels may find a new free direction');
  assert.notEqual(renderer.preparedCallouts[0].geometry.slotName, first.slotName);
});

test('non-reduced motion retains gentle arrival and departure of work annotations', () => {
  const current = scene(1, { lastMessage: null, lastMessageText: null, lastMessageAt: null });
  current.sim.setReducedMotion(false);
  current.store.applySnapshot([{ ...current.sessions[0], codexDetails: {
    turn: { id: 'turn', status: 'active' },
    plan: { turnId: 'turn', steps: [{ status: 'in_progress', step: 'Read code' }] },
  } }]);
  current.sim.syncSnapshot();
  current.sim.update(1 / 30, 1);
  const callout = current.sim.workCallouts.get(current.entities[0].key);
  assert.ok(callout.alpha > 0 && callout.alpha < 1);
  const alpha = callout.alpha;
  current.store.applySnapshot([{ ...current.sessions[0], status: 'waiting' }]);
  current.sim.syncSnapshot();
  current.sim.update(1 / 30, 2);
  assert.ok(callout.alpha > 0 && callout.alpha < alpha);
});

test('sub-agent speech and ongoing work stay visible continuously through focus changes', () => {
  const current = scene(1, { parentId: 'parent', codexDetails: {
    turn: { id: 'turn', status: 'active' },
    plan: { turnId: 'turn', steps: [{ status: 'in_progress', step: 'Inspect parser' }] },
  } });
  current.sim.setReducedMotion(false);
  for (let frame = 1; frame <= 630; frame += 1) {
    current.sim.update(1 / 30, frame / 30);
    current.renderer.prepareCallouts(current.ctx);
    assert.equal(current.renderer.preparedCallouts.length, 1);
    assert.ok(current.renderer.preparedCallouts[0].callout.alpha > 0.99,
      `persistent annotation must not fade at frame ${frame}`);
    assert.match(current.renderer.preparedCallouts[0].content.lines.at(-1), /Inspect parser/);
  }
  current.sim.setFamilyFocus(null, current.entities[0].key);
  for (let frame = 0; frame < 60; frame += 1) {
    current.sim.update(1 / 30, 22 + frame / 30);
    current.renderer.prepareCallouts(current.ctx);
    assert.ok(current.renderer.preparedCallouts[0].callout.alpha > 0.99);
    assert.ok(current.renderer.preparedCallouts[0].callout.reach > 0.99);
  }
  current.renderer.prepareCallouts(current.ctx);
  assert.equal(current.renderer.preparedCallouts[0].content.messageLines, 6);
  current.sim.setFamilyFocus(null, null);
  for (let frame = 0; frame < 60; frame += 1) {
    current.sim.update(1 / 30, 24 + frame / 30);
    current.renderer.prepareCallouts(current.ctx);
    assert.equal(current.renderer.preparedCallouts.length, 1);
    assert.ok(current.renderer.preparedCallouts[0].callout.alpha > 0.99);
    assert.equal(current.renderer.preparedCallouts[0].content.messageLines, 4);
  }
});

test('old final replies appear without interaction on launch and persist through long inactivity', () => {
  const current = scene(1, { status: 'waiting', lastMessageKind: 'final', lastMessageAt: Date.now() - 240_000 });
  current.renderer.prepareCallouts(current.ctx);
  assert.equal(current.renderer.preparedCallouts.length, 1);
  for (let second = 1; second <= 120; second += 1) {
    current.sim.update(1, second);
    current.renderer.prepareCallouts(current.ctx);
    assert.equal(current.renderer.preparedCallouts.length, 1, `visible at ${second}s without new events`);
    assert.equal(current.renderer.preparedCallouts[0].content.messageLines, 4);
  }
  current.store.applySnapshot([{ ...current.sessions[0], lastMessage: 'A new reply', lastMessageText: 'A new reply', lastMessageAt: Date.now() }]);
  current.sim.syncSnapshot();
  current.sim.update(1 / 30, 121);
  current.renderer.prepareCallouts(current.ctx);
  assert.equal(current.renderer.preparedCallouts[0].content.lines.join(''), 'A new reply');
  current.store.applySnapshot([]);
  current.sim.syncSnapshot();
  current.sim.update(1, 122);
  current.renderer.prepareCallouts(current.ctx);
  assert.equal(current.renderer.preparedCallouts.length, 0, 'annotations retire with their session');
});

test('a tool with no recovered message is still annotated and clears when the tool stops', () => {
  const current = scene(1, { parentId: 'parent', status: 'tool', activity: 'Read', activityDetail: 'src/parser.js',
    lastMessage: null, lastMessageText: null, lastMessageAt: null });
  current.renderer.prepareCallouts(current.ctx);
  assert.equal(current.renderer.preparedCallouts.length, 1);
  assert.equal(current.renderer.preparedCallouts[0].content.lines.join(''), 'Read: src/parser.js');
  current.store.applySnapshot([{ ...current.sessions[0], status: 'waiting', activity: null, activityDetail: null }]);
  current.sim.syncSnapshot();
  current.sim.update(1, 1);
  current.renderer.prepareCallouts(current.ctx);
  assert.equal(current.renderer.preparedCallouts.length, 0);
});

test('undisplayed messages remain eligible when newer sessions leave', () => {
  const current = scene(5);
  current.renderer.height = 1300;
  current.sim.height = 1300;
  current.renderer.prepareCallouts(current.ctx);
  assert.equal(current.store.spotlightCallouts.size, 5, 'capacity is a drawing limit, not data deletion');
  assert.equal(current.renderer.preparedCallouts.length, 4);
  current.store.applySnapshot(current.sessions.slice(4));
  current.sim.syncSnapshot();
  current.sim.update(1, 2);
  Object.assign(current.entities[4], { x: 400, y: 300, opacity: 1 });
  current.renderer.prepareCallouts(current.ctx);
  assert.equal(current.renderer.preparedCallouts.length, 1);
  assert.equal(current.renderer.preparedCallouts[0].entity.key, 'codex:4');
});

function mainScene() {
  const now = Date.now();
  const current = scene(1, {
    model: 'example-model', gitBranch: 'feature/parser',
    contextUsedTokens: 60_000, contextWindowTokens: 200_000, outputTokensTotal: 8_000,
    codexDetails: {
      turn: { id: 'turn', status: 'active', startedAt: now - 90_000 }, effort: 'high',
      plan: { turnId: 'turn', steps: [{ status: 'completed', step: 'Read code' },
        { status: 'in_progress', step: 'Verify message parsing' }] },
      commands: [{ turnId: 'turn', label: 'pnpm test', outcome: 'success', exitCode: 0,
        durationMs: 2400, completedAt: now - 120_000 }],
      fileChanges: [{ kind: 'update', path: 'src/parser.js' }],
    },
  });
  Object.assign(current.entities[0], { x: 600, y: 400 });
  return current;
}

test('speechless focused mains show metadata beyond the four automatic agents', () => {
  for (const focus of ['hover', 'selection']) {
    const current = scene(5);
    const target = { ...current.sessions[4], lastMessage: null, lastMessageText: null,
      model: 'fixture-model', gitBranch: 'fixture-branch' };
    current.renderer.height = 1300;
    current.sim.height = 1300;
    current.store.applySnapshot([...current.sessions.slice(0, 4), target]);
    current.sim.syncSnapshot();
    current.sim.update(1, 1);
    const position = () => {
      current.sim.pools.clear();
      current.entities.forEach((entity, index) => Object.assign(entity, {
        x: 260 + (index % 2) * 600, y: 220 + Math.floor(index / 2) * 400,
        opacity: 1, scale: 1, baseRadius: 18,
      }));
    };
    position();
    current.renderer.prepareCallouts(current.ctx);
    assert.equal(current.renderer.preparedCallouts.length, 4);
    assert.ok(current.renderer.preparedCallouts.every(({ entity }) => entity.key !== target.key));

    current.sim.setFamilyFocus(focus === 'hover' ? target.key : null,
      focus === 'selection' ? target.key : null);
    current.sim.update(1 / 30, 2);
    position();
    current.renderer.prepareCallouts(current.ctx);
    const focused = current.renderer.preparedCallouts.filter(({ entity }) => entity.key === target.key);
    assert.equal(focused.length, 1);
    assert.equal(focused[0].content.title, 'Session');
    assert.match(focused[0].content.lines.join(''), /fixture-model/);
    assert.match(focused[0].content.lines.join(''), /fixture-branch/);
    assert.equal(current.renderer.preparedCallouts.filter(({ entity }) => entity.key !== target.key).length, 4);

    current.sim.setFamilyFocus(null, null);
    current.sim.update(1, 3);
    position();
    current.renderer.prepareCallouts(current.ctx);
    assert.equal(current.renderer.preparedCallouts.length, 4);
    assert.ok(current.renderer.preparedCallouts.every(({ entity }) => entity.key !== target.key));
  }
});

test('a main agent shows four distinct readable leaders without requiring focus', () => {
  const { renderer, ctx } = mainScene();
  renderer.prepareCallouts(ctx);
  assert.equal(renderer.preparedCallouts.length, 4);
  assert.deepEqual(Array.from(renderer.preparedCallouts, ({ content }) => content.title).sort(),
    ['Latest update', 'Result', 'Session', 'Turn status']);
  for (const { content, geometry } of renderer.preparedCallouts) {
    assert.equal(content.font, '11px system-ui, sans-serif');
    assert.equal(content.textOpacity, 0.72);
    for (const other of renderer.preparedCallouts) {
      if (other.geometry === geometry) continue;
      assert.equal(renderer.rectsOverlap(geometry.collisionRect, other.geometry.collisionRect), false);
      assert.equal(renderer.leaderCrossesRect(geometry, other.geometry.collisionRect), false);
    }
  }
  assert.match(renderer.preparedCallouts.find(({ content }) => content.title === 'Result').content.lines.join(' '), /pnpm test/);
});

test('main focus expands speech while keeping independent information without duplicate metadata', () => {
  const current = mainScene();
  current.renderer.prepareCallouts(current.ctx);
  current.sim.setFamilyFocus(null, current.entities[0].key);
  current.sim.update(1 / 30, 1);
  Object.assign(current.entities[0], { x: 600, y: 400 });
  current.renderer.prepareCallouts(current.ctx);
  assert.equal(current.renderer.preparedCallouts.length, 4);
  assert.equal(current.renderer.preparedCallouts.filter(({ content }) => content.title === 'Session').length, 1);
  assert.equal(current.renderer.preparedCallouts.find(({ content }) => content.hasMessage).content.messageLines, 6);
  assert.equal([...current.sim.expandedCallouts.values()].some(({ kind }) => kind === 'branch' || kind === 'meta'), false);
});

test('main information and a nearby sub-agent speech can coexist', () => {
  const current = mainScene();
  const child = { ...current.sessions[0], key: 'codex:child', id: 'child', parentId: '0',
    lastMessageText: 'Reviewing the parser changes.', lastMessageAt: Date.now() };
  current.store.applySnapshot([...current.sessions, child]);
  current.sim.syncSnapshot();
  current.sim.update(1 / 30, 1);
  Object.assign(current.entities[0], { x: 600, y: 400 });
  Object.assign(current.store.entities.get(child.key), { x: 564, y: 385, opacity: 1, scale: 0.6,
    baseRadius: 18, isSatellite: true, beltSlot: 0 });
  current.sim.pools.clear();
  current.renderer.prepareCallouts(current.ctx);
  assert.equal(current.renderer.preparedCallouts.filter(({ entity }) => entity.key === 'codex:0').length, 4,
    JSON.stringify(current.renderer.preparedCallouts.map(({ content, geometry }) => [content.title, geometry.slotName, geometry.distance])));
  assert.equal(current.renderer.preparedCallouts.filter(({ entity }) => entity.key === child.key).length, 1);
});

test('main information is available without speech and retires with its session', () => {
  const current = mainScene();
  const session = { ...current.sessions[0], lastMessage: null, lastMessageText: null };
  current.store.applySnapshot([session]);
  current.sim.syncSnapshot();
  current.sim.update(1, 1);
  Object.assign(current.entities[0], { x: 600, y: 400 });
  current.sim.pools.clear();
  current.renderer.prepareCallouts(current.ctx);
  assert.equal(current.renderer.preparedCallouts.length, 3);
  current.store.applySnapshot([]);
  current.sim.syncSnapshot();
  current.sim.update(1, 2);
  current.renderer.prepareCallouts(current.ctx);
  assert.equal(current.renderer.preparedCallouts.length, 0);
});

test('sector headings and existing text are not crossed by annotation leaders', () => {
  const current = mainScene();
  current.sim.pools.set('sector', { x: 600, y: 400, radius: 220, opacity: 1 });
  current.renderer.prepareCallouts(current.ctx);
  const obstacles = current.renderer.calloutObstacles();
  assert.ok(current.renderer.preparedCallouts.length >= 2);
  for (const { geometry, entity } of current.renderer.preparedCallouts) {
    assert.ok(obstacles.every((rect) => !current.renderer.rectsOverlap(rect, geometry.collisionRect)));
    assert.ok(obstacles.filter((rect) => rect.orbKey !== entity.key)
      .every((rect) => !current.renderer.leaderCrossesRect(geometry, rect)));
  }
});

test('a main leader routes around a nearby satellite as well as its text', () => {
  const current = scene(2, { lastMessage: null, lastMessageText: null });
  const [parent, child] = current.entities;
  Object.assign(parent, { x: 400, y: 350, baseRadius: 18 });
  Object.assign(child, { x: 435, y: 325, baseRadius: 10, isSatellite: true, beltSlot: 0 });
  const content = { lines: ['Current turn', 'Read source', 'Plan 1/3 completed', 'Review changes'],
    title: 'Turn status', font: '11px system-ui, sans-serif', textOpacity: 0.72, preferredSlots: ['NE', 'NW', 'SE', 'SW'] };
  const obstacles = current.renderer.calloutObstacles();
  const geometry = current.renderer.placeCallout(current.ctx, parent, content, obstacles, 'work');
  assert.ok(geometry, 'a clear alternative direction is available');
  assert.equal(current.renderer.leaderCrossesRect(geometry,
    obstacles.find((rect) => rect.orbKey === child.key)), false);
});

test('a short main readout can show when the full speech has no room', () => {
  const current = mainScene();
  const originalPlace = current.renderer.placeCallout.bind(current.renderer);
  current.renderer.placeCallout = (ctx, entity, content, ...rest) => content.hasMessage
    ? null : originalPlace(ctx, entity, content, ...rest);
  current.renderer.prepareCallouts(current.ctx);
  assert.equal(current.renderer.preparedCallouts.length, 3);
  assert.ok(current.renderer.preparedCallouts.every(({ content }) => !content.hasMessage));
  current.sim.setFamilyFocus(null, current.entities[0].key);
  current.sim.update(1 / 30, 1);
  Object.assign(current.entities[0], { x: 600, y: 400 });
  current.renderer.prepareCallouts(current.ctx);
  assert.equal(current.renderer.preparedCallouts.length, 3, 'selection preserves the available information');
});
