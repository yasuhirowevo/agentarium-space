import {
  normalizeMessageKind,
  shouldBootstrapSpotlight,
  SPOTLIGHT_CALLOUT_LIMIT,
  spotlightDurationFor,
} from './callout-policy.js';

const STATUS_LABELS = {
  thinking: '考え中',
  tool: 'ツール実行中',
  waiting: '待機中',
  idle: 'アイドル',
};

const SOURCE_LABELS = {
  claude: 'Claude Code',
  codex: 'Codex',
};

const STATUS_BRIGHTNESS = {
  thinking: 0.82,
  tool: 1,
  waiting: 0.58,
  idle: 0.3,
};

const SOURCE_COLORS = {
  claude: { core: '#ffc9a3', glow: '#ff8a5c', rgb: '255, 138, 92' },
  codex: { core: '#a7e3ff', glow: '#4fa3e3', rgb: '79, 163, 227' },
};

const TAU = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const POOL_SEPARATION_MARGIN = 24;
const POOL_SEPARATION_ITERATIONS = 32;
const POOL_SEPARATION_ROUNDS = 4;
const POOL_MARGIN_SHRINK_STEP = 4;
const ORB_SEPARATION_X = 128;
const ORB_SEPARATION_Y = 72;
const ORB_CHILD_SEPARATION_MIN_X = 56;
const ORB_CHILD_SEPARATION_MAX_X = 96;
const ORB_CHILD_SEPARATION_MIN_Y = 40;
const ORB_CHILD_SEPARATION_MAX_Y = 64;
const ORB_SEPARATION_ITERATIONS = 12;
const SATELLITES_PER_BELT = 8;
const SATELLITE_BELT_SPACING = 56;
const SATELLITE_BELT_GAP = 20;
const EVENT_POP_LIMIT = 8;
const EVENT_POP_DURATION = 1.4;
const CALLOUT_DIAGONAL_LENGTH = 28;
const CALLOUT_LABEL_MAX_WIDTH = 150;
const CALLOUT_LABEL_LINE_HEIGHT = 12;
const CALLOUT_MARGIN = 10;
const CALLOUT_STAGGER = 0.1;
const CALLOUT_SLOTS = {
  NE: -36 * Math.PI / 180,
  NW: -144 * Math.PI / 180,
  SE: 36 * Math.PI / 180,
  SW: 144 * Math.PI / 180,
};
const STATUS_HISTORY_MS = 30 * 60 * 1000;
const POOL_EVENT_WINDOW_MS = 60 * 1000;
const EVENT_WINDOW_MS = 15 * 60 * 1000;
const LONG_RUN_MS = 10 * 60 * 1000;
const GLOBAL_EVENT_LIMIT = 20;
const WAITING_EFFECT_LIMIT = 8;
const WAITING_RIPPLE_DURATION = 2.8;
const WAITING_EXHALE_DURATION = 2.2;

const canvas = document.querySelector('#bay-canvas');
const canvasRegion = document.querySelector('#canvas-region');
const hudClock = document.querySelector('#hud-clock');
const syncElapsed = document.querySelector('#sync-elapsed');
const hudSync = document.querySelector('#hud-sync');
const hudTotalOutput = document.querySelector('#hud-total-output');
const eventSparkline = document.querySelector('#event-sparkline');
const statusCountElements = Object.fromEntries(
  Object.keys(STATUS_LABELS).map((status) => [status, document.querySelector(`#status-count-${status}`)]),
);
const connection = document.querySelector('#connection');
const connectionLabel = document.querySelector('#connection-label');
const sessionList = document.querySelector('#session-list');
const panel = document.querySelector('#detail-panel');
const panelEyebrow = document.querySelector('#panel-eyebrow');
const focusBack = document.querySelector('#focus-back');
const detailTitle = document.querySelector('#detail-title');
const overviewView = document.querySelector('#overview-view');
const overviewTreeView = document.querySelector('#overview-tree-view');
const sessionTreeView = document.querySelector('#session-tree-view');
const overviewStreamView = document.querySelector('#overview-stream-view');
const sessionStreamView = document.querySelector('#session-stream-view');
const overviewAgents = document.querySelector('#overview-agents');
const overviewEvents = document.querySelector('#overview-events');
const overviewSectorCount = document.querySelector('#overview-sector-count');
const overviewSessionCount = document.querySelector('#overview-session-count');
const overviewSubagentCount = document.querySelector('#overview-subagent-count');
const overviewEventCount = document.querySelector('#overview-event-count');
const overviewStatusCountElements = Object.fromEntries(
  Object.keys(STATUS_LABELS).map((status) => [status, document.querySelector(`#overview-status-count-${status}`)]),
);
const overviewStatusBarElements = Object.fromEntries(
  Object.keys(STATUS_LABELS).map((status) => [status, document.querySelector(`#overview-status-bar-${status}`)]),
);
const overviewModelCounts = document.querySelector('#overview-model-counts');
const overviewWriteCount = document.querySelector('#overview-write-count');
const overviewBusiestSector = document.querySelector('#overview-busiest-sector');
const overviewTotalOutput = document.querySelector('#overview-total-output');
const overviewToolCalls = document.querySelector('#overview-tool-calls');
const sessionView = document.querySelector('#session-view');
const detailSource = document.querySelector('#detail-source');
const detailStatus = document.querySelector('#detail-status');
const detailLongRun = document.querySelector('#detail-long-run');
const detailCwd = document.querySelector('#detail-cwd');
const detailBranch = document.querySelector('#detail-branch');
const detailLastSignal = document.querySelector('#detail-last-signal');
const detailModel = document.querySelector('#detail-model');
const detailAccess = document.querySelector('#detail-access');
const detailApproval = document.querySelector('#detail-approval');
const detailOrigin = document.querySelector('#detail-origin');
const detailUptime = document.querySelector('#detail-uptime');
const detailOutputTokens = document.querySelector('#detail-output-tokens');
const detailTopTools = document.querySelector('#detail-top-tools');
const detailTimeline = document.querySelector('#detail-timeline');
const detailAgents = document.querySelector('#detail-agents');
const detailEvents = document.querySelector('#detail-events');

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function satelliteBeltLayout(parent, satelliteIndex, satelliteCount) {
  const beltIndex = Math.floor(satelliteIndex / SATELLITES_PER_BELT);
  const beltSlot = satelliteIndex % SATELLITES_PER_BELT;
  const beltCount = Math.min(
    SATELLITES_PER_BELT,
    Math.max(1, satelliteCount - beltIndex * SATELLITES_PER_BELT),
  );
  return {
    beltSlot,
    beltCount,
    orbitRadius: Math.max(
      parent.baseRadius * 2.35,
      beltCount * SATELLITE_BELT_SPACING / TAU,
    ) + beltIndex * SATELLITE_BELT_GAP,
  };
}

function expLerp(current, target, deltaTime, timeConstant = 0.6) {
  const amount = 1 - Math.exp(-deltaTime / timeConstant);
  return current + (target - current) * amount;
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededUnit(value, salt = 0) {
  let seed = (hashString(value) + Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  seed ^= seed >>> 16;
  seed = Math.imul(seed, 0x7feb352d);
  seed ^= seed >>> 15;
  seed = Math.imul(seed, 0x846ca68b);
  seed ^= seed >>> 16;
  return (seed >>> 0) / 4294967296;
}

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function formatRelativeTime(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp)) return '—';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 5) return 'now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatClock(timestamp) {
  if (!Number.isFinite(timestamp)) return '--:--';
  const date = new Date(timestamp);
  return [date.getHours(), date.getMinutes()]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

function formatCompactNumber(value) {
  if (!Number.isFinite(value) || value < 0) return '';
  const scaled = (amount, suffix) => {
    const digits = amount < 10 ? 1 : 0;
    return `${amount.toFixed(digits).replace(/\.0$/, '')}${suffix}`;
  };
  if (value >= 1_000_000) return scaled(value / 1_000_000, 'M');
  if (value >= 1_000) return scaled(value / 1_000, 'k');
  return String(Math.round(value));
}

function outputTokensLabel(session) {
  const tokens = formatCompactNumber(session?.outputTokensTotal);
  return tokens ? `OUT ${tokens}` : '';
}

function formatUptime(startedAt, now = Date.now()) {
  if (!Number.isFinite(startedAt)) return '—';
  const minutes = Math.max(0, Math.floor((now - startedAt) / 60_000));
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return hours > 0 ? `${hours}h${String(remainingMinutes).padStart(2, '0')}m` : `${minutes}m`;
}

function topToolsLabel(session) {
  if (!Array.isArray(session?.toolCounts)) return '—';
  const values = session.toolCounts
    .filter((tool) => typeof tool?.name === 'string' && Number.isFinite(tool.count) && tool.count > 0)
    .slice(0, 3)
    .map((tool) => `${tool.name}×${tool.count}`);
  return values.join(' ') || '—';
}

function eventTimestamp(value, now = Date.now()) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{2}):(\d{2})\s+/);
  if (!match) return null;
  const date = new Date(now);
  date.setHours(Number(match[1]), Number(match[2]), 0, 0);
  if (date.getTime() > now + 60_000) date.setDate(date.getDate() - 1);
  return date.getTime();
}

function isLongRunning(session, now = Date.now()) {
  return session?.status === 'tool'
    && Number.isFinite(session.toolStartedAt)
    && now - session.toolStartedAt >= LONG_RUN_MS;
}

function projectKey(session) {
  return `${session.projectName || '名称未取得'}\u0000${session.cwd || 'unknown'}`;
}

function contextUsage(session) {
  if (!Number.isFinite(session?.contextUsedTokens)
    || !Number.isFinite(session?.contextWindowTokens)
    || session.contextUsedTokens < 0
    || session.contextWindowTokens <= 0) return null;
  if (session.contextUsedTokens > session.contextWindowTokens) return null;
  return clamp(session.contextUsedTokens / session.contextWindowTokens, 0, 1);
}

function contextLabel(session) {
  if (!Number.isFinite(session?.contextUsedTokens)
    || !Number.isFinite(session?.contextWindowTokens)
    || session.contextUsedTokens < 0
    || session.contextWindowTokens <= 0) return '';
  if (session.contextUsedTokens > session.contextWindowTokens) {
    return `CTX ${Math.round(session.contextUsedTokens / 1000)}k`;
  }
  return `CTX ${Math.round(session.contextUsedTokens / session.contextWindowTokens * 100)}%`;
}

function normalizedSession(session) {
  return {
    ...session,
    projectName: session.projectName || '名称未取得のプロジェクト',
    title: session.title || '名称未取得のセッション',
    status: STATUS_LABELS[session.status] ? session.status : 'idle',
    source: SOURCE_LABELS[session.source] ? session.source : 'codex',
    activity: typeof session.activity === 'string' ? session.activity : null,
    activityDetail: typeof session.activityDetail === 'string' ? session.activityDetail : null,
    lastMessage: typeof session.lastMessage === 'string' ? session.lastMessage : null,
    lastMessageAt: Number.isFinite(session.lastMessageAt) ? session.lastMessageAt : null,
    lastMessageKind: normalizeMessageKind(session.lastMessageKind),
    contextUsedTokens: Number.isFinite(session.contextUsedTokens) && session.contextUsedTokens >= 0
      ? session.contextUsedTokens
      : null,
    contextWindowTokens: Number.isFinite(session.contextWindowTokens) && session.contextWindowTokens > 0
      ? session.contextWindowTokens
      : null,
    model: typeof session.model === 'string' && session.model ? session.model : null,
    writeAccess: session.writeAccess === 'write' || session.writeAccess === 'read'
      ? session.writeAccess
      : null,
    approvalPolicy: typeof session.approvalPolicy === 'string' && session.approvalPolicy
      ? session.approvalPolicy
      : null,
    originator: typeof session.originator === 'string' && session.originator ? session.originator : null,
    nickname: typeof session.nickname === 'string' && session.nickname ? session.nickname : null,
    outputTokensTotal: Number.isFinite(session.outputTokensTotal) && session.outputTokensTotal >= 0
      ? session.outputTokensTotal
      : null,
    startedAt: Number.isFinite(session.startedAt) ? session.startedAt : null,
    toolCounts: Array.isArray(session.toolCounts)
      ? session.toolCounts
        .filter((tool) => typeof tool?.name === 'string'
          && Number.isFinite(tool.count)
          && tool.count > 0)
        .slice(0, 3)
      : [],
    toolCallsTotal: Number.isFinite(session.toolCallsTotal) && session.toolCallsTotal >= 0
      ? session.toolCallsTotal
      : 0,
    subAgents: Array.isArray(session.subAgents) ? session.subAgents : [],
    recentEvents: Array.isArray(session.recentEvents) ? session.recentEvents : [],
  };
}

function disambiguateSessionTitles(sessions) {
  const countsByProjectAndTitle = new Map();
  for (const session of sessions) {
    const key = `${projectKey(session)}\u0000${session.title}`;
    countsByProjectAndTitle.set(key, (countsByProjectAndTitle.get(key) || 0) + 1);
  }
  return sessions.map((session) => {
    const key = `${projectKey(session)}\u0000${session.title}`;
    if (countsByProjectAndTitle.get(key) < 2) return session;
    const id = typeof session.id === 'string' && session.id ? session.id : session.key;
    const idSuffix = id.slice(-4);
    return { ...session, title: `${session.title}·${idSuffix}` };
  });
}

class WSClient {
  constructor({ onSnapshot, onConnection }) {
    this.onSnapshot = onSnapshot;
    this.onConnection = onConnection;
    this.socket = null;
    this.reconnectTimer = null;
    this.stopped = false;
  }

  connect() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    this.onConnection(false);
    const socketUrl = new URL('ws', location.href);
    socketUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socketUrl.search = '';
    socketUrl.hash = '';
    const nextSocket = new WebSocket(socketUrl.href);
    this.socket = nextSocket;

    nextSocket.addEventListener('open', () => {
      if (this.socket === nextSocket) this.onConnection(true);
    });

    nextSocket.addEventListener('message', (event) => {
      if (this.socket !== nextSocket) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'snapshot' && Array.isArray(message.sessions)) {
          this.onSnapshot(message.sessions);
        }
      } catch {
        // Ignore malformed or future protocol messages without breaking the live view.
      }
    });

    nextSocket.addEventListener('error', () => {
      if (this.socket !== nextSocket) return;
      this.onConnection(false);
      nextSocket.close();
    });

    nextSocket.addEventListener('close', () => {
      if (this.socket !== nextSocket) return;
      this.socket = null;
      this.onConnection(false);
      if (!this.stopped) this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    });
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = null;
  }
}

class Store {
  constructor() {
    this.entities = new Map();
    this.sessionsByKey = new Map();
    this.eventPops = [];
    this.spotlightCallouts = new Map();
    this.calloutSequence = 0;
    this.statusHistory = new Map();
    this.poolEventSamples = new Map();
    this.toolRuns = new Map();
    this.reducedMotion = false;
    this.hasSnapshot = false;
  }

  setReducedMotion(value) {
    this.reducedMotion = value;
    if (value) {
      this.eventPops = [];
      for (const entity of this.entities.values()) {
        entity.pendingWaitingRipple = false;
        entity.waitingExhaleAge = null;
      }
    }
  }

  applySnapshot(rawSessions) {
    const observedAt = Date.now();
    const normalizedSessions = rawSessions
      .filter((session) => session && typeof session.key === 'string' && session.key.length > 0)
      .map(normalizedSession);
    const sessions = disambiguateSessionTitles(normalizedSessions);
    const nextByKey = new Map();
    let waitingEffectCount = 0;

    for (const session of sessions) {
      this.recordPoolEvents(session, this.sessionsByKey.get(session.key), observedAt);
      this.trackToolRun(session, observedAt);
      this.recordStatus(session, observedAt);
      nextByKey.set(session.key, session);
      let entity = this.entities.get(session.key);
      const isNew = !entity;
      if (isNew) {
        entity = this.createEntity(session);
        this.entities.set(session.key, entity);
        this.emitSpotlightCallout(null, session, observedAt);
      } else {
        if (session.status !== 'waiting') {
          entity.pendingWaitingRipple = false;
          entity.waitingExhaleAge = null;
        }
        const enteredWaiting = !entity.leaving
          && entity.session.status !== 'waiting'
          && session.status === 'waiting';
        if (!this.reducedMotion
          && enteredWaiting
          && waitingEffectCount < WAITING_EFFECT_LIMIT
        ) {
          entity.pendingWaitingRipple = true;
          entity.waitingExhaleAge = 0;
          waitingEffectCount += 1;
        }
        if (entity.session.lastActivity !== session.lastActivity) entity.pendingActivityRipple = true;
        this.emitEventPop(entity, entity.session.recentEvents, session.recentEvents);
        this.emitSpotlightCallout(entity.session, session, observedAt);
      }

      entity.session = session;
      entity.poolKey = projectKey(session);
      entity.leaving = false;
      entity.targetOpacity = 1;
      this.syncSparks(entity, session.subAgents);
    }

    for (const [key, entity] of this.entities) {
      if (nextByKey.has(entity.key)) continue;
      if (document.hidden) {
        this.entities.delete(key);
      } else {
        entity.leaving = true;
        entity.targetOpacity = 0;
        entity.pendingWaitingRipple = false;
        entity.waitingExhaleAge = null;
      }
    }
    for (const key of this.statusHistory.keys()) {
      if (!nextByKey.has(key)) this.statusHistory.delete(key);
    }
    for (const key of this.toolRuns.keys()) {
      if (!nextByKey.has(key)) this.toolRuns.delete(key);
    }
    this.prunePoolEvents(observedAt);

    this.sessionsByKey = nextByKey;
    this.hasSnapshot = true;
    return sessions;
  }

  recordPoolEvents(session, previousSession, observedAt) {
    const events = !this.hasSnapshot
      ? session.recentEvents
      : previousSession
        ? this.newEvents(previousSession.recentEvents, session.recentEvents)
        : session.recentEvents.slice(-1);
    if (!events.length) return;
    const key = projectKey(session);
    const samples = this.poolEventSamples.get(key) || [];
    for (const event of events) {
      const timestamp = this.hasSnapshot ? observedAt : eventTimestamp(event, observedAt);
      if (timestamp !== null
        && timestamp >= observedAt - POOL_EVENT_WINDOW_MS
        && timestamp <= observedAt + 60_000) samples.push(timestamp);
    }
    if (samples.length) this.poolEventSamples.set(key, samples);
  }

  prunePoolEvents(now = Date.now()) {
    const cutoff = now - POOL_EVENT_WINDOW_MS;
    for (const [key, samples] of this.poolEventSamples) {
      const recent = samples.filter((timestamp) => timestamp >= cutoff && timestamp <= now + 60_000);
      if (recent.length) this.poolEventSamples.set(key, recent);
      else this.poolEventSamples.delete(key);
    }
  }

  poolEventsPerMinute(key, now = Date.now()) {
    const cutoff = now - POOL_EVENT_WINDOW_MS;
    return (this.poolEventSamples.get(key) || [])
      .filter((timestamp) => timestamp >= cutoff && timestamp <= now + 60_000)
      .length;
  }

  trackToolRun(session, observedAt) {
    if (session.status !== 'tool') {
      this.toolRuns.delete(session.key);
      session.toolStartedAt = null;
      return;
    }
    const identity = `${session.activity || 'tool'}\u0000${session.activityDetail || ''}`;
    const previous = this.toolRuns.get(session.key);
    const signalTime = Number.isFinite(session.lastActivity)
      ? Math.min(session.lastActivity, observedAt)
      : observedAt;
    const startedAt = previous?.identity === identity
      ? Math.min(previous.startedAt, signalTime)
      : signalTime;
    this.toolRuns.set(session.key, { identity, startedAt });
    session.toolStartedAt = startedAt;
  }

  recordStatus(session, observedAt) {
    const history = this.statusHistory.get(session.key) || [];
    if (!history.length || history.at(-1).status !== session.status) {
      history.push({ t: observedAt, status: session.status });
    }
    const cutoff = observedAt - STATUS_HISTORY_MS;
    const firstInside = history.findIndex((entry) => entry.t >= cutoff);
    if (firstInside > 1) history.splice(0, firstInside - 1);
    else if (firstInside === -1 && history.length > 1) history.splice(0, history.length - 1);
    if (history.length > 256) history.splice(0, history.length - 256);
    this.statusHistory.set(session.key, history);
  }

  emitSpotlightCallout(previousSession, nextSession, observedAt) {
    if (!nextSession.lastMessage || nextSession.lastMessageAt === null) return;
    if (previousSession) {
      const previousAt = previousSession.lastMessageAt;
      if (previousAt !== null && nextSession.lastMessageAt <= previousAt) return;
      if (previousAt === null && previousSession.lastMessage === nextSession.lastMessage) return;
    } else if (!shouldBootstrapSpotlight(nextSession, observedAt)) {
      return;
    }

    const previous = this.spotlightCallouts.get(nextSession.key);
    this.spotlightCallouts.delete(nextSession.key);
    this.spotlightCallouts.set(nextSession.key, {
      entityKey: nextSession.key,
      message: nextSession.lastMessage,
      age: 0,
      duration: spotlightDurationFor(nextSession.lastMessageKind),
      alpha: previous?.alpha || 0,
      reach: previous?.reach || 0,
      active: true,
      messageAt: nextSession.lastMessageAt,
      sequence: this.calloutSequence += 1,
    });
    const active = [...this.spotlightCallouts.values()]
      .filter((callout) => callout.active)
      .sort((left, right) => left.messageAt - right.messageAt
        || left.sequence - right.sequence);
    while (active.length > SPOTLIGHT_CALLOUT_LIMIT) {
      active.shift().active = false;
    }
  }

  newEvents(previousEvents, nextEvents) {
    let overlap = Math.min(previousEvents.length, nextEvents.length);
    while (overlap > 0) {
      const previousTail = previousEvents.slice(-overlap);
      const nextHead = nextEvents.slice(0, overlap);
      if (previousTail.every((event, index) => event === nextHead[index])) break;
      overlap -= 1;
    }
    return nextEvents.slice(overlap);
  }

  emitEventPop(entity, previousEvents, nextEvents) {
    if (this.reducedMotion || !Number.isFinite(entity.x) || !Number.isFinite(entity.y)) return;
    const previousEvent = previousEvents.at(-1);
    const nextEvent = nextEvents.at(-1);
    const tailAdvanced = nextEvents.length > previousEvents.length
      || (nextEvents.length === previousEvents.length && nextEvent !== previousEvent);
    if (!tailAdvanced || typeof nextEvent !== 'string') return;
    const label = nextEvent.replace(/^\d{2}:\d{2}\s+/, '').trim();
    if (!label) return;

    this.eventPops.push({
      entityKey: entity.key,
      label,
      x: entity.x,
      y: entity.y - entity.baseRadius * entity.scale * 1.45,
      age: 0,
      duration: EVENT_POP_DURATION,
    });
    if (this.eventPops.length > EVENT_POP_LIMIT) {
      this.eventPops.splice(0, this.eventPops.length - EVENT_POP_LIMIT);
    }
  }

  createEntity(session) {
    return {
      key: session.key,
      session,
      poolKey: projectKey(session),
      x: Number.NaN,
      y: Number.NaN,
      targetX: Number.NaN,
      targetY: Number.NaN,
      opacity: 0,
      targetOpacity: 1,
      scale: 0.42,
      targetScale: 1,
      brightness: 0,
      targetBrightness: STATUS_BRIGHTNESS[session.status],
      baseRadius: 15 + seededUnit(session.key, 2) * 4,
      phase: seededUnit(session.key, 3) * TAU,
      blinkInterval: 4 + seededUnit(session.key, 4) * 5,
      blinkOffset: seededUnit(session.key, 5) * 9,
      nextToolRipple: 0,
      pendingActivityRipple: false,
      pendingWaitingRipple: false,
      waitingExhaleAge: null,
      leaving: false,
      sparks: new Map(),
      completedSparks: new Set(),
      isSatellite: false,
      orbitRadius: null,
      beltSlot: null,
      familyEmphasis: 0,
    };
  }

  syncSparks(entity, subAgents) {
    const visibleIds = new Set();
    for (const subAgent of subAgents) {
      if (!subAgent || typeof subAgent.id !== 'string') continue;
      visibleIds.add(subAgent.id);
      let spark = entity.sparks.get(subAgent.id);
      if (!spark && !entity.completedSparks.has(subAgent.id)) {
        spark = {
          id: subAgent.id,
          label: subAgent.label || 'サブエージェント',
          status: subAgent.status,
          phase: seededUnit(`${entity.key}:${subAgent.id}`, 1) * TAU,
          x: entity.x,
          y: entity.y,
          opacity: 0,
          history: [],
          retiring: false,
          burst: false,
        };
        entity.sparks.set(subAgent.id, spark);
      }
      if (!spark) continue;
      spark.label = subAgent.label || spark.label;
      spark.status = subAgent.status;
      spark.retiring = false;
    }

    for (const spark of entity.sparks.values()) {
      if (!visibleIds.has(spark.id)) spark.retiring = true;
    }
    for (const id of entity.completedSparks) {
      if (!visibleIds.has(id) && !entity.sparks.has(id)) entity.completedSparks.delete(id);
    }
  }

  removeFadedEntities() {
    for (const [key, entity] of this.entities) {
      if (entity.leaving && entity.opacity < 0.01) this.entities.delete(key);
    }
  }
}

class Sim {
  constructor(store, reducedMotion = false) {
    this.store = store;
    this.reducedMotion = reducedMotion;
    this.store.setReducedMotion(reducedMotion);
    this.width = 1;
    this.height = 1;
    this.time = 0;
    this.pools = new Map();
    this.ripples = [];
    this.particles = [];
    this.expandedCallouts = new Map();
    this.hoveredKey = null;
    this.selectedKey = null;
  }

  setFamilyFocus(hoveredKey, selectedKey) {
    this.hoveredKey = hoveredKey;
    this.selectedKey = selectedKey;
  }

  setReducedMotion(value) {
    this.reducedMotion = value;
    this.store.setReducedMotion(value);
    if (value) {
      this.ripples = [];
      this.particles = [];
      for (const entity of this.store.entities.values()) {
        for (const spark of entity.sparks.values()) spark.history = [];
      }
    }
  }

  resize(width, height) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.recalculatePoolTargets();
  }

  syncSnapshot() {
    const groups = new Map();
    for (const session of this.store.sessionsByKey.values()) {
      const key = projectKey(session);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(session);
    }

    for (const [key, sessions] of groups) {
      let pool = this.pools.get(key);
      const branches = [...new Set(sessions.map((session) => session.gitBranch).filter(Boolean))]
        .sort(compareText);
      const sessionIds = new Set(sessions.map((session) => session.id));
      const effectiveCount = sessions.reduce(
        (count, session) => count + (session.parentId && sessionIds.has(session.parentId) ? 0.6 : 1),
        0,
      );
      if (!pool) {
        pool = {
          key,
          name: sessions[0].projectName,
          branches,
          count: sessions.length,
          effectiveCount,
          activeCount: 0,
          lastActivity: 0,
          x: this.width / 2,
          y: this.height / 2,
          targetX: this.width / 2,
          targetY: this.height / 2,
          radius: 60,
          targetRadius: 100,
          opacity: 0,
          targetOpacity: 1,
          brightness: 0,
          targetBrightness: 0.35,
        };
        this.pools.set(key, pool);
      }
      pool.name = sessions[0].projectName;
      pool.branches = branches;
      pool.count = sessions.length;
      pool.effectiveCount = effectiveCount;
      pool.activeCount = sessions.filter((session) => session.status === 'tool' || session.status === 'thinking').length;
      pool.lastActivity = sessions.reduce(
        (latest, session) => Math.max(latest, Number.isFinite(session.lastActivity) ? session.lastActivity : 0),
        0,
      );
      pool.targetOpacity = 1;
    }

    for (const [key, pool] of this.pools) {
      if (groups.has(pool.key)) continue;
      if (document.hidden) this.pools.delete(key);
      else pool.targetOpacity = 0;
    }
    this.recalculatePoolTargets();
  }

  recalculatePoolTargets() {
    const pools = [...this.pools.values()]
      .filter((pool) => pool.targetOpacity > 0)
      .sort((left, right) => compareText(left.key, right.key));
    const top = 24;
    const availableHeight = Math.max(160, this.height - top - 18);
    const centerX = this.width / 2;
    const centerY = top + availableHeight / 2;
    const extent = Math.max(0, Math.min(this.width, availableHeight) * 0.42);

    pools.forEach((pool, index) => {
      const maximumRadius = Math.max(68, Math.min(260, this.width * 0.34, availableHeight * 0.34));
      pool.targetRadius = Math.min(90 + Math.sqrt(pool.effectiveCount) * 58, maximumRadius);
      const progress = pools.length <= 1 ? 0 : Math.sqrt(index / (pools.length - 1));
      const distance = extent * progress;
      const angle = index * GOLDEN_ANGLE - Math.PI / 2;
      const horizontalScale = this.width > availableHeight ? 1.28 : 0.9;
      const verticalScale = this.width > availableHeight ? 0.76 : 1;
      pool.targetX = centerX + Math.cos(angle) * distance * horizontalScale;
      pool.targetY = centerY + Math.sin(angle) * distance * verticalScale;
    });

    const availableArea = Math.max(1, this.width - 32) * Math.max(1, this.height - top - 16);
    let separationMargin = POOL_SEPARATION_MARGIN;
    while (separationMargin > 0) {
      const requiredArea = pools.reduce(
        (area, pool) => area + Math.PI * (pool.targetRadius + separationMargin / 2) ** 2,
        0,
      );
      if (requiredArea <= availableArea) break;
      separationMargin = Math.max(0, separationMargin - POOL_MARGIN_SHRINK_STEP);
    }

    const iterationsPerRound = Math.ceil(POOL_SEPARATION_ITERATIONS / POOL_SEPARATION_ROUNDS);
    for (let round = 0; round < POOL_SEPARATION_ROUNDS; round += 1) {
      for (let iteration = 0; iteration < iterationsPerRound; iteration += 1) {
        for (let leftIndex = 0; leftIndex < pools.length; leftIndex += 1) {
          const left = pools[leftIndex];
          for (let rightIndex = leftIndex + 1; rightIndex < pools.length; rightIndex += 1) {
            const right = pools[rightIndex];
            const deltaX = right.targetX - left.targetX;
            const deltaY = right.targetY - left.targetY;
            const distance = Math.hypot(deltaX, deltaY);
            const minimumDistance = left.targetRadius + right.targetRadius + separationMargin;
            if (distance >= minimumDistance) continue;

            const offset = (minimumDistance - distance) / 2;
            const directionX = distance === 0 ? 1 : deltaX / distance;
            const directionY = distance === 0 ? 0 : deltaY / distance;
            left.targetX -= directionX * offset;
            left.targetY -= directionY * offset;
            right.targetX += directionX * offset;
            right.targetY += directionY * offset;
          }
        }
      }

      for (const pool of pools) {
        pool.targetX = clamp(pool.targetX, pool.targetRadius + 16, this.width - pool.targetRadius - 16);
        pool.targetY = clamp(pool.targetY, top + pool.targetRadius, this.height - pool.targetRadius - 16);
      }
    }
  }

  update(deltaTime, nowSeconds) {
    this.time = nowSeconds;
    this.updatePools(deltaTime);
    this.updateEntities(deltaTime);
    this.updateEffects(deltaTime);
    this.store.removeFadedEntities();
  }

  updatePools(deltaTime) {
    for (const [key, pool] of this.pools) {
      pool.x = expLerp(pool.x, pool.targetX, deltaTime);
      pool.y = expLerp(pool.y, pool.targetY, deltaTime);
      pool.radius = expLerp(pool.radius, pool.targetRadius, deltaTime);
      pool.opacity = expLerp(pool.opacity, pool.targetOpacity, deltaTime, 0.52);

      const sessions = [...this.store.sessionsByKey.values()].filter((session) => projectKey(session) === key);
      const strongest = sessions.reduce(
        (value, session) => Math.max(value, STATUS_BRIGHTNESS[session.status] || 0.3),
        0.24,
      );
      pool.targetBrightness = 0.22 + strongest * 0.25;
      pool.brightness = expLerp(pool.brightness, pool.targetBrightness, deltaTime);
      if (pool.targetOpacity === 0 && pool.opacity < 0.01) this.pools.delete(key);
    }
  }

  updateEntities(deltaTime) {
    const byParentId = new Map();
    for (const entity of this.store.entities.values()) {
      if (!entity.leaving && typeof entity.session.id === 'string') byParentId.set(entity.session.id, entity);
    }

    const regularByPool = new Map();
    const regularEntities = [];
    const satelliteEntities = [];
    const satellitesByParent = new Map();
    const satelliteBelts = new Map();
    const childBearingBeltRadii = new Map();
    for (const entity of this.store.entities.values()) {
      const parentEntity = entity.session.parentId ? byParentId.get(entity.session.parentId) : null;
      entity.isSatellite = Boolean(parentEntity && parentEntity !== entity);
      if (entity.isSatellite) {
        satelliteEntities.push(entity);
        if (!satellitesByParent.has(parentEntity)) satellitesByParent.set(parentEntity, []);
        satellitesByParent.get(parentEntity).push(entity);
      } else {
        regularEntities.push(entity);
        const hasActiveSpark = [...entity.sparks.values()]
          .some((spark) => spark.status !== 'done' && !spark.retiring);
        if (hasActiveSpark) childBearingBeltRadii.set(entity, 0);
      }
      if (entity.isSatellite || entity.leaving) continue;
      if (!regularByPool.has(entity.poolKey)) regularByPool.set(entity.poolKey, []);
      regularByPool.get(entity.poolKey).push(entity);
    }
    for (const entities of regularByPool.values()) entities.sort((left, right) => compareText(left.key, right.key));
    for (const [parent, satellites] of satellitesByParent) {
      satellites.sort((left, right) => compareText(left.key, right.key));
      let maxBeltRadius = 0;
      satellites.forEach((satellite, index) => {
        const belt = satelliteBeltLayout(parent, index, satellites.length);
        satelliteBelts.set(satellite, belt);
        maxBeltRadius = Math.max(maxBeltRadius, belt.orbitRadius);
      });
      if (satellites.some((satellite) => !satellite.leaving)) {
        childBearingBeltRadii.set(parent, maxBeltRadius);
      }
    }

    const focusedFamilies = new Set();
    for (const key of [this.hoveredKey, this.selectedKey]) {
      const focused = key ? this.store.entities.get(key) : null;
      if (!focused || focused.leaving) continue;
      const parent = focused.isSatellite ? byParentId.get(focused.session.parentId) : focused;
      if (parent && parent !== focused && parent.leaving) continue;
      if (parent) focusedFamilies.add(parent);
    }
    const focusedEntities = new Set();
    for (const parent of focusedFamilies) {
      focusedEntities.add(parent);
      for (const satellite of satellitesByParent.get(parent) || []) focusedEntities.add(satellite);
    }
    for (const entity of this.store.entities.values()) {
      entity.familyEmphasis = expLerp(
        entity.familyEmphasis,
        focusedEntities.has(entity) ? 1 : 0,
        deltaTime,
        0.25,
      );
    }

    const updateEntityTarget = (entity) => {
      const pool = this.pools.get(entity.poolKey);
      if (!pool) return;
      const parent = entity.isSatellite ? byParentId.get(entity.session.parentId) : null;
      const status = entity.session.status;
      const sourceBrightness = STATUS_BRIGHTNESS[status] || 0.3;
      entity.targetBrightness = entity.leaving ? 0 : sourceBrightness;
      entity.targetScale = entity.isSatellite ? 0.6 : entity.leaving ? 0.72 : 1;

      if (parent && parent !== entity && Number.isFinite(parent.x) && Number.isFinite(parent.y)) {
        const orbitTime = this.reducedMotion ? 0 : this.time * 0.24;
        const belt = satelliteBelts.get(entity) || satelliteBeltLayout(parent, 0, 1);
        const phaseJitter = (entity.phase / TAU - 0.5) * 0.24;
        const angle = orbitTime + (belt.beltSlot / belt.beltCount) * TAU + phaseJitter;
        const orbit = belt.orbitRadius;
        entity.orbitRadius = orbit;
        entity.beltSlot = belt.beltSlot;
        entity.targetX = parent.x + Math.cos(angle) * orbit;
        entity.targetY = parent.y + Math.sin(angle) * orbit * 0.58;
      } else {
        entity.orbitRadius = null;
        entity.beltSlot = null;
        const siblings = regularByPool.get(entity.poolKey) || [entity];
        const slot = Math.max(0, siblings.indexOf(entity));
        const slotDistance = Math.min(pool.radius * 0.56, Math.sqrt(slot + 1) * 23);
        const slotAngle = slot * GOLDEN_ANGLE + entity.phase * 0.32;
        let offsetX = Math.cos(slotAngle) * slotDistance;
        let offsetY = Math.sin(slotAngle) * slotDistance * 0.78;

        if (status === 'idle') {
          const edgeAngle = entity.phase;
          offsetX = Math.cos(edgeAngle) * pool.radius * 0.72;
          offsetY = Math.sin(edgeAngle) * pool.radius * 0.63 + 4;
        } else if (!this.reducedMotion) {
          const amplitude = status === 'waiting' ? 2.4 : Math.min(13, pool.radius * 0.1);
          const speed = status === 'tool' ? 0.32 : 0.23;
          const noiseX = Math.sin(this.time * speed + entity.phase)
            + 0.46 * Math.sin(this.time * speed * 0.63 + entity.phase * 2.7);
          const noiseY = Math.sin(this.time * speed * 0.81 + entity.phase * 1.6)
            + 0.42 * Math.sin(this.time * speed * 0.47 + entity.phase * 3.2);
          offsetX += noiseX * amplitude;
          offsetY += noiseY * amplitude * 0.72;
        }
        entity.targetX = pool.x + offsetX;
        entity.targetY = pool.y + offsetY + (entity.leaving ? 18 : 0);
      }

      if (!Number.isFinite(entity.x)) {
        const entryAngle = entity.phase;
        entity.x = pool.x + Math.cos(entryAngle) * pool.radius * 0.86;
        entity.y = pool.y + Math.sin(entryAngle) * pool.radius * 0.72;
      }
    };

    const advanceEntity = (entity) => {
      if (!Number.isFinite(entity.targetX) || !Number.isFinite(entity.targetY)) return;
      const status = entity.session.status;
      entity.x = expLerp(entity.x, entity.targetX, deltaTime, status === 'waiting' ? 0.82 : 0.6);
      entity.y = expLerp(entity.y, entity.targetY, deltaTime, status === 'waiting' ? 0.82 : 0.6);
      entity.opacity = expLerp(entity.opacity, entity.targetOpacity, deltaTime, 0.5);
      entity.scale = expLerp(entity.scale, entity.targetScale, deltaTime);
      entity.brightness = expLerp(entity.brightness, entity.targetBrightness, deltaTime, 0.48);

      this.updateEntityRipples(entity);
      this.updateWaitingExhale(entity, deltaTime);
      this.updateSparks(entity, deltaTime);
    };

    for (const entity of regularEntities) updateEntityTarget(entity);
    this.separateRegularTargets(regularByPool, childBearingBeltRadii);
    for (const entity of regularEntities) advanceEntity(entity);
    for (const entity of satelliteEntities) {
      updateEntityTarget(entity);
      advanceEntity(entity);
    }
  }

  separateRegularTargets(regularByPool, childBearingBeltRadii) {
    for (const entities of regularByPool.values()) {
      for (let iteration = 0; iteration < ORB_SEPARATION_ITERATIONS; iteration += 1) {
        let separatedAny = false;
        for (let leftIndex = 0; leftIndex < entities.length; leftIndex += 1) {
          const left = entities[leftIndex];
          for (let rightIndex = leftIndex + 1; rightIndex < entities.length; rightIndex += 1) {
            const right = entities[rightIndex];
            const leftMaxBeltRadius = childBearingBeltRadii.get(left);
            const rightMaxBeltRadius = childBearingBeltRadii.get(right);
            const leftSeparationX = leftMaxBeltRadius === undefined ? 0 : clamp(
              leftMaxBeltRadius * 0.9,
              ORB_CHILD_SEPARATION_MIN_X,
              ORB_CHILD_SEPARATION_MAX_X,
            );
            const rightSeparationX = rightMaxBeltRadius === undefined ? 0 : clamp(
              rightMaxBeltRadius * 0.9,
              ORB_CHILD_SEPARATION_MIN_X,
              ORB_CHILD_SEPARATION_MAX_X,
            );
            const leftSeparationY = leftMaxBeltRadius === undefined ? 0 : clamp(
              leftMaxBeltRadius * 0.6,
              ORB_CHILD_SEPARATION_MIN_Y,
              ORB_CHILD_SEPARATION_MAX_Y,
            );
            const rightSeparationY = rightMaxBeltRadius === undefined ? 0 : clamp(
              rightMaxBeltRadius * 0.6,
              ORB_CHILD_SEPARATION_MIN_Y,
              ORB_CHILD_SEPARATION_MAX_Y,
            );
            const separationX = ORB_SEPARATION_X
              + leftSeparationX + rightSeparationX;
            const separationY = ORB_SEPARATION_Y
              + leftSeparationY + rightSeparationY;
            const scaledX = (right.targetX - left.targetX) / separationX;
            const scaledY = (right.targetY - left.targetY) / separationY;
            const distance = Math.hypot(scaledX, scaledY);
            if (distance >= 1) continue;

            const directionX = distance === 0 ? 1 : scaledX / distance;
            const directionY = distance === 0 ? 0 : scaledY / distance;
            const offset = (1 - distance) / 2;
            left.targetX -= directionX * offset * separationX;
            left.targetY -= directionY * offset * separationY;
            right.targetX += directionX * offset * separationX;
            right.targetY += directionY * offset * separationY;
            separatedAny = true;
          }
        }
        if (!separatedAny) break;
      }
    }
  }

  updateEntityRipples(entity) {
    if (this.reducedMotion || entity.leaving) {
      entity.pendingActivityRipple = false;
      entity.pendingWaitingRipple = false;
      return;
    }
    if (entity.pendingActivityRipple) {
      this.emitRipple(entity, 0.9);
      entity.pendingActivityRipple = false;
    }
    if (entity.pendingWaitingRipple) {
      if (entity.session.status === 'waiting') {
        this.emitRipple(entity, 1, {
          duration: WAITING_RIPPLE_DURATION,
          expansion: 100,
          lineWidth: 1.4,
          alpha: 0.3,
          fadePower: 2,
        });
      }
      entity.pendingWaitingRipple = false;
    }
    if (entity.session.status !== 'tool') {
      entity.nextToolRipple = this.time + 2.5;
      return;
    }
    if (entity.nextToolRipple === 0) entity.nextToolRipple = this.time + seededUnit(entity.key, 8) * 1.2;
    if (this.time >= entity.nextToolRipple) {
      this.emitRipple(entity, 1);
      entity.nextToolRipple = this.time + 2.5;
    }
  }

  emitRipple(entity, strength, options = {}) {
    if (!Number.isFinite(entity.x) || !Number.isFinite(entity.y)) return;
    this.ripples.push({
      x: entity.x,
      y: entity.y,
      radius: entity.baseRadius * entity.scale,
      age: 0,
      duration: options.duration ?? 1.25,
      expansion: options.expansion ?? 38,
      lineWidth: options.lineWidth ?? 0.8,
      alpha: options.alpha ?? 0.38,
      fadePower: options.fadePower ?? 1,
      strength,
      source: entity.session.source,
    });
  }

  updateWaitingExhale(entity, deltaTime) {
    if (this.reducedMotion || entity.leaving || entity.session.status !== 'waiting') {
      entity.waitingExhaleAge = null;
      return;
    }
    if (!Number.isFinite(entity.waitingExhaleAge)) return;
    entity.waitingExhaleAge += deltaTime;
    if (entity.waitingExhaleAge >= WAITING_EXHALE_DURATION) entity.waitingExhaleAge = null;
  }

  updateSparks(entity, deltaTime) {
    for (const [id, spark] of entity.sparks) {
      const orbitTime = this.reducedMotion ? 0 : this.time * 0.58;
      const angle = orbitTime + spark.phase;
      const radius = entity.baseRadius * 1.72;
      spark.x = entity.x + Math.cos(angle) * radius;
      spark.y = entity.y + Math.sin(angle) * radius * 0.68;
      const targetOpacity = spark.retiring || spark.status === 'done' ? 0 : entity.opacity;
      spark.opacity = expLerp(spark.opacity, targetOpacity, deltaTime, 0.28);

      if (!this.reducedMotion && spark.status !== 'done' && !spark.retiring) {
        spark.history.push({ x: spark.x, y: spark.y });
        if (spark.history.length > 12) spark.history.shift();
      }

      if (spark.status === 'done' && !spark.burst) {
        spark.burst = true;
        entity.completedSparks.add(id);
        if (!this.reducedMotion) this.emitSparkBurst(spark);
      }
      if ((spark.retiring || spark.status === 'done') && spark.opacity < 0.02) {
        entity.sparks.delete(id);
        if (spark.retiring) entity.completedSparks.delete(id);
      }
    }
  }

  emitSparkBurst(spark) {
    for (let index = 0; index < 8; index += 1) {
      const angle = (index / 8) * TAU + spark.phase;
      const speed = 9 + seededUnit(spark.id, index) * 13;
      this.particles.push({
        x: spark.x,
        y: spark.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        age: 0,
        duration: 0.75,
      });
    }
  }

  updateEffects(deltaTime) {
    for (const ripple of this.ripples) ripple.age += deltaTime;
    this.ripples = this.ripples.filter((ripple) => ripple.age < ripple.duration);

    for (const particle of this.particles) {
      particle.age += deltaTime;
      particle.x += particle.vx * deltaTime;
      particle.y += particle.vy * deltaTime;
      particle.vx *= Math.exp(-deltaTime * 2.2);
      particle.vy *= Math.exp(-deltaTime * 2.2);
    }
    this.particles = this.particles.filter((particle) => particle.age < particle.duration);

    for (const eventPop of this.store.eventPops) eventPop.age += deltaTime;
    this.store.eventPops = this.store.eventPops.filter((eventPop) => eventPop.age < eventPop.duration);

    this.updateSpotlightCallouts(deltaTime);
    this.updateExpandedCallouts(deltaTime);
  }

  updateSpotlightCallouts(deltaTime) {
    for (const [key, callout] of this.store.spotlightCallouts) {
      callout.age += deltaTime;
      const entity = this.store.entities.get(callout.entityKey);
      if (!entity || entity.leaving || callout.age >= callout.duration) callout.active = false;
      const target = callout.active ? 1 : 0;
      callout.alpha = this.reducedMotion
        ? target
        : expLerp(callout.alpha, target, deltaTime, 0.32);
      callout.reach = this.reducedMotion
        ? target
        : expLerp(callout.reach, target, deltaTime, 0.26);
      if (!callout.active && callout.alpha < 0.01 && callout.reach < 0.01) {
        this.store.spotlightCallouts.delete(key);
      }
    }
  }

  updateExpandedCallouts(deltaTime) {
    for (const callout of this.expandedCallouts.values()) callout.nextTarget = false;

    let order = 0;
    const focusedKeys = [...new Set([this.hoveredKey, this.selectedKey].filter(Boolean))];
    for (const entityKey of focusedKeys) {
      const entity = this.store.entities.get(entityKey);
      if (!entity || entity.leaving) continue;
      const spotlight = this.store.spotlightCallouts.get(entityKey);
      const rowKinds = [];
      if (entity.session.lastMessage && !(spotlight?.alpha > 0.05)) rowKinds.push('message');
      if (entity.session.gitBranch) rowKinds.push('branch');
      if (entity.session.model || Number.isFinite(entity.session.startedAt)) rowKinds.push('meta');

      rowKinds.forEach((kind, rowIndex) => {
        const id = `${entityKey}\u0000${kind}`;
        let callout = this.expandedCallouts.get(id);
        if (!callout) {
          callout = {
            id,
            entityKey,
            kind,
            alpha: 0,
            reach: 0,
            target: false,
            delay: 0,
            order,
          };
          this.expandedCallouts.set(id, callout);
        }
        if (!callout.target) callout.delay = rowIndex * CALLOUT_STAGGER;
        callout.nextTarget = true;
        callout.order = order;
        order += 1;
      });
    }

    for (const [id, callout] of this.expandedCallouts) {
      callout.target = callout.nextTarget;
      delete callout.nextTarget;
      if (callout.target && !this.reducedMotion) {
        callout.delay = Math.max(0, callout.delay - deltaTime);
      }
      const target = callout.target && (this.reducedMotion || callout.delay === 0) ? 1 : 0;
      callout.alpha = this.reducedMotion
        ? target
        : expLerp(callout.alpha, target, deltaTime, 0.24);
      callout.reach = this.reducedMotion
        ? target
        : expLerp(callout.reach, target, deltaTime, 0.2);
      if (!callout.target && callout.alpha < 0.01 && callout.reach < 0.01) {
        this.expandedCallouts.delete(id);
      }
    }
  }
}

class Renderer {
  constructor(canvasElement, store, sim) {
    this.canvas = canvasElement;
    this.context = canvasElement.getContext('2d');
    this.store = store;
    this.sim = sim;
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.hoveredKey = null;
    this.backgroundSpecks = [];
    this.backgroundStars = [];
    this.shootingStar = null;
    this.shootingStarIndex = 0;
    this.nextShootingStarAt = null;
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const dpr = window.devicePixelRatio || 1;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(width * dpr));
    this.canvas.height = Math.max(1, Math.round(height * dpr));
    this.context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.backgroundSpecks = Array.from({ length: Math.round(clamp(width * height / 15000, 42, 110)) }, (_, index) => ({
      x: seededUnit('bay-speck-x', index) * width,
      y: seededUnit('bay-speck-y', index) * height,
      radius: 0.35 + seededUnit('bay-speck-r', index) * 0.8,
      alpha: 0.025 + seededUnit('bay-speck-a', index) * 0.06,
    }));
    this.backgroundStars = Array.from({ length: 6 }, (_, index) => ({
      x: (0.08 + seededUnit('bay-star-x', index) * 0.84) * width,
      y: (0.08 + seededUnit('bay-star-y', index) * 0.78) * height,
      radius: 0.8 + seededUnit('bay-star-radius', index) * 0.8,
      alpha: 0.24 + seededUnit('bay-star-alpha', index) * 0.2,
      rayLength: 3.5 + seededUnit('bay-star-ray', index) * 4,
      period: 4.5 + seededUnit('bay-star-period', index) * 4,
      phase: seededUnit('bay-star-phase', index) * TAU,
    }));
  }

  render() {
    const ctx = this.context;
    ctx.clearRect(0, 0, this.width, this.height);
    this.drawBackground(ctx);
    this.drawPools(ctx);
    this.drawOrbitRings(ctx);
    this.drawRelationships(ctx);
    this.drawTrails(ctx);
    this.drawOrbs(ctx);
    this.drawRipples(ctx);
    this.drawEventPops(ctx);
    this.drawCallouts(ctx);
  }

  drawBackground(ctx) {
    const gradient = ctx.createRadialGradient(
      this.width * 0.46,
      this.height * 0.38,
      0,
      this.width * 0.46,
      this.height * 0.38,
      Math.max(this.width, this.height) * 0.84,
    );
    gradient.addColorStop(0, '#0d1322');
    gradient.addColorStop(0.58, '#090e19');
    gradient.addColorStop(1, '#070b14');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width, this.height);

    this.drawCelestialGrid(ctx);
    this.drawOrbitalArcs(ctx);
    ctx.fillStyle = '#ffffff';
    for (const speck of this.backgroundSpecks) {
      ctx.globalAlpha = speck.alpha;
      ctx.beginPath();
      ctx.arc(speck.x, speck.y, speck.radius, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    this.drawBrightStars(ctx);
    this.drawShootingStar(ctx);
    this.drawScreenCorners(ctx);
  }

  drawCelestialGrid(ctx) {
    const horizontalPadding = this.width * 0.08;
    const verticalPadding = this.height * 0.08;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.02)';
    ctx.lineWidth = 0.7;
    for (let index = 1; index <= 6; index += 1) {
      const latitude = index / 7;
      const y = this.height * latitude;
      const curve = (latitude - 0.5) * this.height * 0.18;
      ctx.beginPath();
      ctx.moveTo(-horizontalPadding, y);
      ctx.quadraticCurveTo(this.width / 2, y + curve, this.width + horizontalPadding, y);
      ctx.stroke();
    }
    for (let index = 1; index <= 6; index += 1) {
      const longitude = index / 7;
      const x = this.width * longitude;
      const bend = (longitude - 0.5) * this.width * 0.18;
      ctx.beginPath();
      ctx.moveTo(x, -verticalPadding);
      ctx.bezierCurveTo(
        x - bend,
        this.height * 0.24,
        x - bend,
        this.height * 0.76,
        x,
        this.height + verticalPadding,
      );
      ctx.stroke();
    }
    ctx.restore();
  }

  drawOrbitalArcs(ctx) {
    const arcs = [
      [0.48, 0.34, 0.72, 0.32, -0.13, 0.06, 1.02],
      [0.46, 0.66, 0.68, 0.27, 0.2, 0.96, 1.92],
      [0.62, 0.52, 0.56, 0.7, 0.72, 1.14, 1.82],
    ];
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 0.8;
    for (const [centerX, centerY, radiusX, radiusY, rotation, start, end] of arcs) {
      ctx.beginPath();
      ctx.ellipse(
        this.width * centerX,
        this.height * centerY,
        Math.max(180, this.width * radiusX),
        Math.max(90, this.height * radiusY),
        rotation,
        Math.PI * start,
        Math.PI * end,
      );
      ctx.stroke();
    }
    ctx.restore();
  }

  drawBrightStars(ctx) {
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 0.6;
    for (const star of this.backgroundStars) {
      const twinkle = this.sim.reducedMotion
        ? 0.82
        : 0.68 + (Math.sin(this.sim.time * TAU / star.period + star.phase) + 1) * 0.16;
      ctx.globalAlpha = star.alpha * twinkle;
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.radius, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = star.alpha * twinkle * 0.38;
      ctx.beginPath();
      ctx.moveTo(star.x - star.rayLength, star.y);
      ctx.lineTo(star.x + star.rayLength, star.y);
      ctx.moveTo(star.x, star.y - star.rayLength);
      ctx.lineTo(star.x, star.y + star.rayLength);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawShootingStar(ctx) {
    if (this.sim.reducedMotion) {
      this.shootingStar = null;
      this.nextShootingStarAt = null;
      return;
    }

    const now = this.sim.time;
    if (this.nextShootingStarAt === null) {
      this.nextShootingStarAt = now
        + 30
        + seededUnit('shooting-star-delay', this.shootingStarIndex) * 60;
    }
    if (!this.shootingStar && now >= this.nextShootingStarAt) {
      this.shootingStar = {
        index: this.shootingStarIndex,
        startedAt: now,
        duration: 0.75 + seededUnit('shooting-star-duration', this.shootingStarIndex) * 0.35,
      };
      this.nextShootingStarAt = null;
    }
    if (!this.shootingStar) return;

    const { index, startedAt, duration } = this.shootingStar;
    const progress = (now - startedAt) / duration;
    if (progress >= 1) {
      this.shootingStar = null;
      this.shootingStarIndex += 1;
      this.nextShootingStarAt = now
        + 30
        + seededUnit('shooting-star-delay', this.shootingStarIndex) * 60;
      return;
    }

    const angle = 0.28 + seededUnit('shooting-star-angle', index) * 0.14;
    const directionX = Math.cos(angle);
    const directionY = Math.sin(angle);
    const distance = Math.max(160, Math.min(360, this.width * 0.34));
    const startX = -40 + seededUnit('shooting-star-x', index) * this.width * 0.55;
    const startY = this.height * (0.08 + seededUnit('shooting-star-y', index) * 0.34);
    const headX = startX + directionX * distance * progress;
    const headY = startY + directionY * distance * progress;
    const trailLength = 44 + seededUnit('shooting-star-trail', index) * 36;
    const tailX = headX - directionX * trailLength;
    const tailY = headY - directionY * trailLength;
    const gradient = ctx.createLinearGradient(tailX, tailY, headX, headY);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0.58)');

    ctx.save();
    ctx.globalAlpha = Math.sin(Math.PI * progress) * 0.46;
    ctx.strokeStyle = gradient;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tailX, tailY);
    ctx.lineTo(headX, headY);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(headX, headY, 1, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  drawScreenCorners(ctx) {
    const inset = 13;
    const size = 22;
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    for (const [x, y, dx, dy] of [
      [inset, inset, 1, 1],
      [this.width - inset, inset, -1, 1],
      [inset, this.height - inset, 1, -1],
      [this.width - inset, this.height - inset, -1, -1],
    ]) {
      ctx.beginPath();
      ctx.moveTo(x + dx * size, y);
      ctx.lineTo(x, y);
      ctx.lineTo(x, y + dy * size);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawPools(ctx) {
    const pools = [...this.sim.pools.values()].sort((left, right) => compareText(left.key, right.key));
    for (const [poolIndex, pool] of pools.entries()) {
      if (pool.opacity < 0.01) continue;
      ctx.save();
      ctx.globalAlpha = pool.opacity;
      const glow = ctx.createRadialGradient(pool.x, pool.y, pool.radius * 0.42, pool.x, pool.y, pool.radius * 1.1);
      glow.addColorStop(0, `rgba(120, 164, 212, ${0.018 + pool.brightness * 0.045})`);
      glow.addColorStop(0.72, `rgba(73, 115, 163, ${0.014 + pool.brightness * 0.03})`);
      glow.addColorStop(1, 'rgba(73, 115, 163, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(pool.x, pool.y, pool.radius * 1.1, 0, TAU);
      ctx.fill();

      ctx.strokeStyle = `rgba(188, 220, 255, ${0.1 + pool.brightness * 0.13})`;
      ctx.lineWidth = 0.8;
      ctx.shadowColor = 'rgba(96, 166, 225, 0.24)';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(pool.x, pool.y, pool.radius, 0, TAU);
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.lineWidth = 0.8;
      for (let tick = 0; tick < 12; tick += 1) {
        const angle = tick * TAU / 12;
        const inner = pool.radius - 4;
        const outer = pool.radius + 4;
        ctx.beginPath();
        ctx.moveTo(pool.x + Math.cos(angle) * inner, pool.y + Math.sin(angle) * inner);
        ctx.lineTo(pool.x + Math.cos(angle) * outer, pool.y + Math.sin(angle) * outer);
        ctx.stroke();
      }

      const sector = `SECTOR-${this.sectorCode(poolIndex)}`;
      ctx.font = '500 11px system-ui, sans-serif';
      const project = this.fitText(ctx, pool.name, pool.radius * 0.92);
      const badge = `${pool.count} UNITS`;
      ctx.font = '600 9px ui-monospace, Consolas, monospace';
      const sectorWidth = ctx.measureText(sector).width;
      ctx.font = '500 11px system-ui, sans-serif';
      const projectWidth = ctx.measureText(project).width;
      ctx.font = '600 8px ui-monospace, Consolas, monospace';
      const badgeWidth = ctx.measureText(badge).width + 10;
      const labelGap = 7;
      const totalWidth = sectorWidth + labelGap + projectWidth + labelGap + badgeWidth;
      let labelX = pool.x - totalWidth / 2;
      const labelY = pool.y - pool.radius - 15;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.font = '600 9px ui-monospace, Consolas, monospace';
      ctx.fillStyle = 'rgba(167, 227, 255, 0.72)';
      ctx.fillText(sector, labelX, labelY);
      labelX += sectorWidth + labelGap;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.70)';
      ctx.font = '500 11px system-ui, sans-serif';
      ctx.fillText(project, labelX, labelY);
      labelX += projectWidth + labelGap;
      this.roundedRect(ctx, labelX, labelY - 11, badgeWidth, 13, 2);
      ctx.fillStyle = 'rgba(167, 227, 255, 0.05)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(167, 227, 255, 0.18)';
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.48)';
      ctx.font = '600 8px ui-monospace, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(badge, labelX + badgeWidth / 2, labelY - 1);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.40)';
      ctx.font = '10px ui-monospace, Consolas, monospace';
      const branch = pool.branches.length ? pool.branches.join(' · ') : 'branch —';
      ctx.fillText(this.fitText(ctx, branch, pool.radius * 1.55), pool.x, pool.y - pool.radius - 1);
      ctx.font = '9px ui-monospace, Consolas, monospace';
      const statistics = `${pool.activeCount} ACTIVE · ${this.store.poolEventsPerMinute(pool.key)} EV/MIN · LAST ${formatClock(pool.lastActivity)}`;
      ctx.fillText(this.fitText(ctx, statistics, pool.radius * 1.75), pool.x, pool.y - pool.radius + 12);
      ctx.restore();
    }
  }

  sectorCode(index) {
    let value = index + 1;
    let code = '';
    while (value > 0) {
      value -= 1;
      code = String.fromCharCode(65 + (value % 26)) + code;
      value = Math.floor(value / 26);
    }
    return code;
  }

  drawTrails(ctx) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const entity of this.store.entities.values()) {
      if (entity.opacity < 0.02) continue;
      if (!Number.isFinite(entity.x) || !Number.isFinite(entity.y)) continue;
      if (entity.session.status === 'thinking' && !this.sim.reducedMotion) {
        this.drawThinkingMotes(ctx, entity);
      }
      for (const spark of entity.sparks.values()) {
        spark.history.forEach((point, index) => {
          if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
          const progress = (index + 1) / Math.max(1, spark.history.length);
          ctx.globalAlpha = entity.opacity * progress * 0.12;
          ctx.fillStyle = '#ffc9a3';
          ctx.beginPath();
          ctx.arc(point.x, point.y, 0.7 + progress * 1.2, 0, TAU);
          ctx.fill();
        });
      }
    }
    for (const particle of this.sim.particles) {
      if (!Number.isFinite(particle.x) || !Number.isFinite(particle.y)) continue;
      const life = 1 - particle.age / particle.duration;
      ctx.globalAlpha = life * 0.72;
      ctx.fillStyle = '#ffc9a3';
      ctx.shadowColor = '#ff8a5c';
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, 1.2 + life, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  drawThinkingMotes(ctx, entity) {
    const colors = SOURCE_COLORS[entity.session.source] || SOURCE_COLORS.codex;
    for (let index = 0; index < 3; index += 1) {
      const phase = this.sim.time * (0.42 + index * 0.05) + entity.phase + index * 2.1;
      const progress = ((this.sim.time * 0.18 + seededUnit(entity.key, index + 20)) % 1);
      const distance = entity.baseRadius * (2.2 - progress * 1.35);
      ctx.globalAlpha = entity.opacity * (0.15 + progress * 0.28);
      ctx.fillStyle = colors.core;
      ctx.beginPath();
      ctx.arc(
        entity.x + Math.cos(phase) * distance,
        entity.y + Math.sin(phase) * distance * 0.72,
        0.9 + progress * 0.8,
        0,
        TAU,
      );
      ctx.fill();
    }
  }

  drawOrbitRings(ctx) {
    const parentsById = new Map();
    for (const entity of this.store.entities.values()) {
      if (!entity.leaving && typeof entity.session.id === 'string') parentsById.set(entity.session.id, entity);
    }
    const radiiByParent = new Map();
    for (const entity of this.store.entities.values()) {
      if (!entity.isSatellite || entity.opacity < 0.02 || !Number.isFinite(entity.orbitRadius)) continue;
      const parent = parentsById.get(entity.session.parentId);
      if (!parent || parent.opacity < 0.02) continue;
      if (![parent.x, parent.y].every(Number.isFinite)) continue;
      if (!radiiByParent.has(parent)) radiiByParent.set(parent, new Set());
      radiiByParent.get(parent).add(entity.orbitRadius);
    }

    ctx.save();
    ctx.lineWidth = 1;
    for (const [parent, radii] of radiiByParent) {
      const opacity = 0.035 + parent.familyEmphasis * 0.065;
      ctx.globalAlpha = parent.opacity;
      ctx.strokeStyle = `rgba(255, 255, 255, ${opacity})`;
      for (const radius of [...radii].sort((left, right) => left - right)) {
        ctx.beginPath();
        ctx.ellipse(parent.x, parent.y, radius, radius * 0.58, 0, 0, TAU);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawRelationships(ctx) {
    const parentsById = new Map();
    for (const entity of this.store.entities.values()) {
      if (!entity.leaving && typeof entity.session.id === 'string') parentsById.set(entity.session.id, entity);
    }

    ctx.save();
    ctx.lineWidth = 0.8;
    for (const entity of this.store.entities.values()) {
      if (!entity.isSatellite || entity.opacity < 0.02) continue;
      const parent = parentsById.get(entity.session.parentId);
      if (!parent || parent.opacity < 0.02) continue;
      if (![entity.x, entity.y, parent.x, parent.y].every(Number.isFinite)) continue;
      const colors = SOURCE_COLORS[entity.session.source] || SOURCE_COLORS.codex;
      const familyEmphasis = Math.max(entity.familyEmphasis, parent.familyEmphasis);
      ctx.globalAlpha = Math.min(entity.opacity, parent.opacity);
      ctx.strokeStyle = `rgba(${colors.rgb}, ${0.14 + familyEmphasis * 0.26})`;
      ctx.beginPath();
      ctx.moveTo(parent.x, parent.y);
      ctx.lineTo(entity.x, entity.y);
      ctx.stroke();

      if (!this.sim.reducedMotion && ['thinking', 'tool'].includes(entity.session.status)) {
        const pointCount = 2 + Math.floor(seededUnit(entity.key, 41) * 2);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = colors.core;
        ctx.shadowColor = colors.glow;
        ctx.shadowBlur = 7;
        for (let index = 0; index < pointCount; index += 1) {
          const progress = (this.sim.time * 0.38 + index / pointCount + seededUnit(entity.key, 42)) % 1;
          ctx.globalAlpha = Math.min(entity.opacity, parent.opacity) * (0.32 + progress * 0.46);
          ctx.beginPath();
          ctx.arc(
            parent.x + (entity.x - parent.x) * progress,
            parent.y + (entity.y - parent.y) * progress,
            1.1 + progress * 0.7,
            0,
            TAU,
          );
          ctx.fill();
        }
        ctx.restore();
      }
    }
    ctx.restore();
  }

  drawOrbs(ctx) {
    const entities = [...this.store.entities.values()]
      .filter((entity) => entity.opacity > 0.01)
      .sort((left, right) => Number(left.isSatellite) - Number(right.isSatellite));
    for (const entity of entities) this.drawOrb(ctx, entity);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const entity of entities) {
      for (const spark of entity.sparks.values()) {
        if (spark.opacity < 0.01 || !Number.isFinite(spark.x) || !Number.isFinite(spark.y)) continue;
        ctx.globalAlpha = spark.opacity * 0.9;
        ctx.fillStyle = '#ffc9a3';
        ctx.shadowColor = '#ff8a5c';
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(spark.x, spark.y, 3.5, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();

    for (const entity of entities) {
      if (entity.isSatellite) this.drawSatelliteNameplate(ctx, entity);
      else this.drawNameplate(ctx, entity);
    }
  }

  drawOrb(ctx, entity) {
    if (!Number.isFinite(entity.x) || !Number.isFinite(entity.y)) return;
    const colors = SOURCE_COLORS[entity.session.source] || SOURCE_COLORS.codex;
    const hovered = this.hoveredKey === entity.key;
    const breathing = entity.session.status === 'thinking' && !this.sim.reducedMotion
      ? 1 + 0.075 * (1 + Math.sin(this.sim.time * TAU / 2.8))
      : 1;
    const exhale = entity.session.status === 'waiting'
      && !this.sim.reducedMotion
      && Number.isFinite(entity.waitingExhaleAge)
      ? 1 + 0.22 * Math.sin(
        Math.PI * clamp(entity.waitingExhaleAge / WAITING_EXHALE_DURATION, 0, 1),
      )
      : 1;
    const idlePulse = entity.session.status === 'idle' && !this.sim.reducedMotion
      ? Math.max(0, Math.cos((this.sim.time + entity.phase) * TAU / 8)) ** 18 * 0.16
      : 0;
    const brightness = clamp(
      entity.brightness + idlePulse + (hovered ? 0.16 : 0) + entity.familyEmphasis * 0.08,
      0,
      1.26,
    );
    const radius = entity.baseRadius * entity.scale;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const haloRadius = radius * 2 * breathing * exhale;
    const halo = ctx.createRadialGradient(entity.x, entity.y, radius * 0.2, entity.x, entity.y, haloRadius);
    halo.addColorStop(0, `rgba(${colors.rgb}, ${0.2 * brightness})`);
    halo.addColorStop(0.35, `rgba(${colors.rgb}, ${0.12 * brightness})`);
    halo.addColorStop(1, `rgba(${colors.rgb}, 0)`);
    ctx.globalAlpha = entity.opacity;
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(entity.x, entity.y, haloRadius, 0, TAU);
    ctx.fill();

    const core = ctx.createRadialGradient(
      entity.x - radius * 0.28,
      entity.y - radius * 0.32,
      radius * 0.08,
      entity.x,
      entity.y,
      radius,
    );
    core.addColorStop(0, '#ffffff');
    core.addColorStop(0.27, colors.core);
    core.addColorStop(1, colors.glow);
    ctx.globalAlpha = entity.opacity * (0.28 + brightness * 0.72);
    ctx.fillStyle = core;
    ctx.shadowColor = colors.glow;
    ctx.shadowBlur = 12 + brightness * 12;
    ctx.beginPath();
    ctx.arc(entity.x, entity.y, radius, 0, TAU);
    ctx.fill();
    ctx.restore();

    this.drawContextRing(ctx, entity, radius, colors);
    this.drawFace(ctx, entity, radius);
  }

  drawContextRing(ctx, entity, radius, colors) {
    const usage = contextUsage(entity.session);
    if (usage === null) return;
    ctx.save();
    ctx.globalAlpha = entity.opacity;
    ctx.strokeStyle = usage <= 0.6
      ? `rgba(${colors.rgb}, 0.35)`
      : usage <= 0.8
        ? 'rgba(255, 255, 255, 0.45)'
        : '#ffb454';
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(entity.x, entity.y, radius + 4, -Math.PI / 2, -Math.PI / 2 + TAU * usage);
    ctx.stroke();
    ctx.restore();
  }

  drawFace(ctx, entity, radius) {
    if (!Number.isFinite(entity.x) || !Number.isFinite(entity.y)) return;
    if (radius < 7) return;
    const isIdle = entity.session.status === 'idle';
    const isBlinking = !this.sim.reducedMotion
      && ((this.sim.time + entity.blinkOffset) % entity.blinkInterval) < 0.15;
    const eyeY = entity.y - radius * 0.08;
    const eyeOffset = radius * 0.31;
    ctx.save();
    ctx.globalAlpha = entity.opacity * clamp(entity.brightness + 0.34, 0.32, 0.86);
    ctx.strokeStyle = 'rgba(7, 11, 20, 0.76)';
    ctx.fillStyle = 'rgba(7, 11, 20, 0.76)';
    ctx.lineWidth = Math.max(1, radius * 0.09);
    ctx.lineCap = 'round';
    if (isIdle || isBlinking) {
      ctx.beginPath();
      ctx.moveTo(entity.x - eyeOffset - radius * 0.11, eyeY);
      ctx.lineTo(entity.x - eyeOffset + radius * 0.11, eyeY);
      ctx.moveTo(entity.x + eyeOffset - radius * 0.11, eyeY);
      ctx.lineTo(entity.x + eyeOffset + radius * 0.11, eyeY);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(entity.x - eyeOffset, eyeY, Math.max(1, radius * 0.09), 0, TAU);
      ctx.arc(entity.x + eyeOffset, eyeY, Math.max(1, radius * 0.09), 0, TAU);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(entity.x, entity.y + radius * 0.24, radius * 0.2, 0.2, Math.PI - 0.2);
    ctx.stroke();
    ctx.restore();
  }

  drawNameplate(ctx, entity) {
    const radius = entity.baseRadius * entity.scale;
    const titleY = entity.y + radius * 1.9;
    const longRun = isLongRunning(entity.session);
    let statusText = '';
    if (entity.session.status === 'tool') {
      statusText = entity.session.activity || 'ツール実行中';
      if (entity.session.activityDetail) statusText += `: ${entity.session.activityDetail}`;
      const elapsed = Date.now() - entity.session.lastActivity;
      if (elapsed >= 30_000) {
        statusText += elapsed < 60_000 ? '・30秒+' : `・${Math.floor(elapsed / 60_000)}分`;
      }
      if (longRun) statusText += '・LONG RUN';
    }
    else if (entity.session.status === 'thinking') statusText = '考え中';
    else if (entity.session.status === 'waiting') statusText = 'ひと休み';
    const metricText = [contextLabel(entity.session), outputTokensLabel(entity.session)]
      .filter(Boolean)
      .join(' · ');

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.globalAlpha = entity.opacity;
    ctx.font = '500 11px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
    if (entity.session.writeAccess === 'write') {
      const title = this.fitText(ctx, entity.session.title, 108);
      const titleWidth = ctx.measureText(title).width;
      const markerWidth = 10;
      const startX = entity.x - (markerWidth + titleWidth) / 2;
      ctx.textAlign = 'left';
      ctx.fillStyle = '#ffb454';
      ctx.font = '8px system-ui, sans-serif';
      ctx.fillText('▲', startX, titleY);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.78)';
      ctx.font = '500 11px system-ui, sans-serif';
      ctx.fillText(title, startX + markerWidth, titleY);
    } else {
      ctx.fillText(this.fitText(ctx, entity.session.title, 120), entity.x, titleY);
    }
    if (statusText || metricText) {
      ctx.font = '9px system-ui, sans-serif';
      const alertOpacity = longRun && !this.sim.reducedMotion
        ? (Math.sin(this.sim.time * TAU * 1.4) > 0 ? 1 : 0.42)
        : 1;
      const separator = statusText && metricText ? ' · ' : '';
      const metricWidth = ctx.measureText(metricText).width;
      const separatorWidth = ctx.measureText(separator).width;
      const iconWidth = entity.session.status === 'tool' && statusText ? 10 : 0;
      const iconGap = iconWidth ? 4 : 0;
      const availableStatusWidth = Math.max(0, 140 - metricWidth - separatorWidth - iconWidth - iconGap);
      const fittedStatus = statusText ? this.fitText(ctx, statusText, availableStatusWidth) : '';
      const statusWidth = ctx.measureText(fittedStatus).width;
      const actualSeparator = fittedStatus && metricText ? separator : '';
      const totalWidth = iconWidth + iconGap + statusWidth
        + ctx.measureText(actualSeparator).width + metricWidth;
      let lineX = entity.x - totalWidth / 2;
      ctx.textAlign = 'left';
      if (iconWidth && fittedStatus) {
        ctx.globalAlpha = entity.opacity * alertOpacity;
        this.drawToolIcon(ctx, entity.session.activity, lineX + iconWidth / 2, titleY + 13);
        lineX += iconWidth + iconGap;
      }
      if (fittedStatus) {
        ctx.globalAlpha = entity.opacity * alertOpacity;
        ctx.fillStyle = longRun ? '#ffb454' : 'rgba(255, 255, 255, 0.45)';
        ctx.fillText(fittedStatus, lineX, titleY + 13);
        lineX += statusWidth;
      }
      if (actualSeparator) {
        ctx.globalAlpha = entity.opacity;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.40)';
        ctx.fillText(actualSeparator, lineX, titleY + 13);
        lineX += ctx.measureText(actualSeparator).width;
      }
      if (metricText) {
        ctx.globalAlpha = entity.opacity;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.40)';
        ctx.fillText(metricText, lineX, titleY + 13);
      }
    }
    if (entity.session.status !== 'idle'
      && entity.session.lastMessage
      && !this.isMessageCalloutVisible(entity.key)) {
      ctx.globalAlpha = entity.opacity;
      ctx.textAlign = 'center';
      ctx.font = '9px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      const message = Array.from(entity.session.lastMessage).slice(0, 26).join('');
      ctx.fillText(this.fitText(ctx, message, 140), entity.x, titleY + 26);
    }
    ctx.restore();
  }

  drawSatelliteNameplate(ctx, entity) {
    if (!Number.isFinite(entity.x) || !Number.isFinite(entity.y)) return;
    const radius = entity.baseRadius * entity.scale;
    const label = entity.session.nickname || entity.session.title;
    ctx.save();
    ctx.globalAlpha = entity.opacity;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '500 7px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.60)';
    const direction = entity.beltSlot % 2 === 1 ? -1 : 1;
    ctx.fillText(this.fitText(ctx, `◦ ${label}`, 80), entity.x, entity.y + direction * radius * 1.9);
    ctx.restore();
  }

  drawToolIcon(ctx, activity, x, y) {
    const name = String(activity || '').toLowerCase();
    let icon = 'gear';
    if (name.includes('bash') || name.includes('exec') || name.includes('shell')) icon = 'terminal';
    else if (name.includes('read')) icon = 'book';
    else if (name.includes('edit') || name.includes('write') || name.includes('apply_patch')) icon = 'pen';
    else if (name.includes('webfetch') || name.includes('web_search') || name.includes('websearch')) icon = 'globe';
    else if (name.includes('grep') || name.includes('glob') || name.includes('search')) icon = 'search';
    else if (name.includes('agent') || name.includes('task')) icon = 'flag';

    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (icon === 'terminal') {
      ctx.strokeRect(-5, -4, 10, 8);
      ctx.beginPath();
      ctx.moveTo(-3, -1.5);
      ctx.lineTo(-1, 0);
      ctx.lineTo(-3, 1.5);
      ctx.moveTo(0.5, 2);
      ctx.lineTo(3, 2);
      ctx.stroke();
    } else if (icon === 'book') {
      ctx.beginPath();
      ctx.moveTo(0, -3.5);
      ctx.quadraticCurveTo(-2.5, -4.5, -4.5, -3);
      ctx.lineTo(-4.5, 3.5);
      ctx.quadraticCurveTo(-2.5, 2.5, 0, 4);
      ctx.quadraticCurveTo(2.5, 2.5, 4.5, 3.5);
      ctx.lineTo(4.5, -3);
      ctx.quadraticCurveTo(2.5, -4.5, 0, -3.5);
      ctx.lineTo(0, 4);
      ctx.stroke();
    } else if (icon === 'pen') {
      ctx.beginPath();
      ctx.moveTo(-3.8, 3.8);
      ctx.lineTo(-2.8, 0.7);
      ctx.lineTo(2.7, -4.3);
      ctx.lineTo(4.2, -2.8);
      ctx.lineTo(-0.8, 2.7);
      ctx.closePath();
      ctx.stroke();
    } else if (icon === 'search') {
      ctx.beginPath();
      ctx.arc(-1, -1, 3.2, 0, TAU);
      ctx.moveTo(1.4, 1.4);
      ctx.lineTo(4.5, 4.5);
      ctx.stroke();
    } else if (icon === 'globe') {
      ctx.beginPath();
      ctx.arc(0, 0, 4.5, 0, TAU);
      ctx.moveTo(-4.2, 0);
      ctx.lineTo(4.2, 0);
      ctx.moveTo(0, -4.5);
      ctx.bezierCurveTo(-2.2, -2.3, -2.2, 2.3, 0, 4.5);
      ctx.moveTo(0, -4.5);
      ctx.bezierCurveTo(2.2, -2.3, 2.2, 2.3, 0, 4.5);
      ctx.stroke();
    } else if (icon === 'flag') {
      ctx.beginPath();
      ctx.moveTo(-3.5, 4.5);
      ctx.lineTo(-3.5, -4.5);
      ctx.lineTo(3.5, -3);
      ctx.lineTo(-3.5, -0.5);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, 2.3, 0, TAU);
      for (let index = 0; index < 6; index += 1) {
        const angle = index * TAU / 6;
        ctx.moveTo(Math.cos(angle) * 3.2, Math.sin(angle) * 3.2);
        ctx.lineTo(Math.cos(angle) * 4.6, Math.sin(angle) * 4.6);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  drawRipples(ctx) {
    if (this.sim.reducedMotion) return;
    ctx.save();
    for (const ripple of this.sim.ripples) {
      const progress = ripple.age / ripple.duration;
      const colors = SOURCE_COLORS[ripple.source] || SOURCE_COLORS.codex;
      ctx.globalAlpha = (1 - progress) ** ripple.fadePower * ripple.alpha * ripple.strength;
      ctx.strokeStyle = colors.core;
      ctx.lineWidth = ripple.lineWidth;
      ctx.beginPath();
      ctx.arc(ripple.x, ripple.y, ripple.radius + progress * ripple.expansion, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawEventPops(ctx) {
    if (this.sim.reducedMotion) return;
    ctx.save();
    ctx.font = '500 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const eventPop of this.store.eventPops) {
      const progress = eventPop.age / eventPop.duration;
      ctx.globalAlpha = (1 - progress) * 0.78;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
      ctx.fillText(this.fitText(ctx, eventPop.label, 140), eventPop.x, eventPop.y - progress * 34);
    }
    ctx.restore();
  }

  isMessageCalloutVisible(entityKey) {
    if ((this.store.spotlightCallouts.get(entityKey)?.alpha || 0) > 0.05) return true;
    return (this.sim.expandedCallouts.get(`${entityKey}\u0000message`)?.alpha || 0) > 0.05;
  }

  drawCallouts(ctx) {
    const occupiedRects = [];
    const expanded = [...this.sim.expandedCallouts.values()]
      .filter((callout) => callout.alpha > 0.01)
      .sort((left, right) => Number(right.target) - Number(left.target)
        || left.order - right.order
        || compareText(left.id, right.id));
    for (const callout of expanded) {
      const entity = this.store.entities.get(callout.entityKey);
      const content = entity ? this.expandedCalloutContent(ctx, callout, entity) : null;
      if (content) this.drawLeaderLineCallout(ctx, callout, entity, content, occupiedRects);
    }

    const spotlights = [...this.store.spotlightCallouts.values()]
      .filter((callout) => callout.alpha > 0.01)
      .sort((left, right) => right.messageAt - left.messageAt
        || right.sequence - left.sequence);
    for (const callout of spotlights) {
      const entity = this.store.entities.get(callout.entityKey);
      if (!entity) continue;
      ctx.font = 'italic 9px system-ui, sans-serif';
      const lines = this.wrapText(ctx, callout.message, CALLOUT_LABEL_MAX_WIDTH, 2);
      if (!lines.length) continue;
      this.drawLeaderLineCallout(ctx, callout, entity, {
        lines,
        font: 'italic 9px system-ui, sans-serif',
        textOpacity: 0.66,
      }, occupiedRects);
    }
  }

  expandedCalloutContent(ctx, callout, entity) {
    if (callout.kind === 'message' && entity.session.lastMessage) {
      const font = 'italic 9px system-ui, sans-serif';
      ctx.font = font;
      return {
        lines: [this.fitText(ctx, entity.session.lastMessage, CALLOUT_LABEL_MAX_WIDTH)],
        font,
        textOpacity: 0.66,
      };
    }
    if (callout.kind === 'branch' && entity.session.gitBranch) {
      const font = '9px system-ui, sans-serif';
      ctx.font = font;
      return {
        lines: [this.fitText(ctx, `⎇ ${entity.session.gitBranch}`, CALLOUT_LABEL_MAX_WIDTH)],
        font,
        textOpacity: 0.45,
      };
    }
    if (callout.kind === 'meta') {
      const values = [entity.session.model];
      if (Number.isFinite(entity.session.startedAt)) values.push(formatUptime(entity.session.startedAt));
      const label = values.filter(Boolean).join(' · ');
      if (!label) return null;
      const font = '9px system-ui, sans-serif';
      ctx.font = font;
      return {
        lines: [this.fitText(ctx, label, CALLOUT_LABEL_MAX_WIDTH)],
        font,
        textOpacity: 0.45,
      };
    }
    return null;
  }

  drawLeaderLineCallout(ctx, callout, entity, content, occupiedRects) {
    if (entity.opacity < 0.05 || !Number.isFinite(entity.x) || !Number.isFinite(entity.y)) return;
    ctx.save();
    ctx.font = content.font;
    const labelWidth = Math.max(...content.lines.map((line) => ctx.measureText(line).width));
    const labelHeight = content.lines.length * CALLOUT_LABEL_LINE_HEIGHT;
    const slotNames = this.calloutSlotNames(entity);
    const candidates = slotNames.map(
      (slotName) => this.calloutGeometry(entity, slotName, labelWidth, labelHeight),
    );
    const fallback = candidates[0];
    const hasCollision = (candidate) => occupiedRects
      .some((rect) => this.rectsOverlap(rect, candidate.collisionRect));
    const geometry = candidates.find((candidate) => !hasCollision(candidate))
      || fallback;
    occupiedRects.push(geometry.collisionRect);

    const alpha = clamp(callout.alpha * entity.opacity, 0, 1);
    const reach = clamp(callout.reach, 0, 1);
    const diagonalLength = Math.hypot(
      geometry.elbowX - geometry.anchorX,
      geometry.shelfY - geometry.anchorY,
    );
    const shelfLength = labelWidth + 6;
    const reachedLength = (diagonalLength + shelfLength) * reach;
    const diagonalProgress = diagonalLength > 0
      ? clamp(reachedLength / diagonalLength, 0, 1)
      : 1;
    const shelfProgress = shelfLength > 0
      ? clamp((reachedLength - diagonalLength) / shelfLength, 0, 1)
      : 1;

    ctx.strokeStyle = `rgba(255, 255, 255, ${0.10 * alpha})`;
    ctx.fillStyle = `rgba(255, 255, 255, ${0.10 * alpha})`;
    ctx.lineWidth = 0.8;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(geometry.anchorX, geometry.anchorY, 1.2, 0, TAU);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(geometry.anchorX, geometry.anchorY);
    ctx.lineTo(
      geometry.anchorX + (geometry.elbowX - geometry.anchorX) * diagonalProgress,
      geometry.anchorY + (geometry.shelfY - geometry.anchorY) * diagonalProgress,
    );
    if (shelfProgress > 0) {
      ctx.moveTo(geometry.elbowX, geometry.shelfY);
      ctx.lineTo(
        geometry.elbowX + (geometry.shelfEndX - geometry.elbowX) * shelfProgress,
        geometry.shelfY,
      );
    }
    ctx.stroke();

    const labelReveal = clamp((shelfProgress - 0.12) / 0.42, 0, 1);
    if (labelReveal > 0) {
      ctx.globalAlpha = alpha * labelReveal;
      ctx.fillStyle = `rgba(255, 255, 255, ${content.textOpacity})`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      content.lines.forEach((line, index) => {
        ctx.fillText(
          line,
          geometry.labelX,
          geometry.labelY + index * CALLOUT_LABEL_LINE_HEIGHT,
        );
      });
    }
    ctx.restore();
  }

  calloutSlotNames(entity) {
    const satelliteNameplateIsAbove = entity.isSatellite && entity.beltSlot % 2 === 1;
    return satelliteNameplateIsAbove
      ? ['SE', 'SW', 'NE', 'NW']
      : ['NE', 'NW', 'SE', 'SW'];
  }

  calloutGeometry(entity, slotName, labelWidth, labelHeight) {
    const angle = CALLOUT_SLOTS[slotName];
    const directionX = Math.cos(angle);
    const directionY = Math.sin(angle);
    const radius = entity.baseRadius * entity.scale;
    const anchorX = entity.x + directionX * (radius + 4);
    const anchorY = entity.y + directionY * (radius + 4);
    const elbowX = anchorX + directionX * CALLOUT_DIAGONAL_LENGTH;
    const shelfY = anchorY + directionY * CALLOUT_DIAGONAL_LENGTH;
    const labelXForDirection = (shelfDirection) => shelfDirection > 0
      ? elbowX + 3
      : elbowX - labelWidth - 3;
    const fitsHorizontally = (labelX) => labelX >= CALLOUT_MARGIN
      && labelX + labelWidth <= this.width - CALLOUT_MARGIN;
    let shelfDirection = directionX >= 0 ? 1 : -1;
    let idealLabelX = labelXForDirection(shelfDirection);
    if (!fitsHorizontally(idealLabelX)) {
      const oppositeLabelX = labelXForDirection(-shelfDirection);
      if (fitsHorizontally(oppositeLabelX)) {
        shelfDirection *= -1;
        idealLabelX = oppositeLabelX;
      }
    }
    const idealLabelY = shelfY - labelHeight - 3;
    const maximumX = Math.max(CALLOUT_MARGIN, this.width - labelWidth - CALLOUT_MARGIN);
    const maximumY = Math.max(CALLOUT_MARGIN, this.height - labelHeight - CALLOUT_MARGIN);
    const labelX = clamp(idealLabelX, CALLOUT_MARGIN, maximumX);
    const labelY = clamp(idealLabelY, CALLOUT_MARGIN, maximumY);
    const shelfEndX = elbowX + shelfDirection * (labelWidth + 6);
    return {
      slotName,
      anchorX,
      anchorY,
      elbowX,
      shelfY,
      shelfEndX,
      labelX,
      labelY,
      collisionRect: {
        x: labelX - 2,
        y: labelY - 2,
        width: labelWidth + 4,
        height: labelHeight + 4,
      },
    };
  }

  rectsOverlap(left, right) {
    return left.x < right.x + right.width
      && left.x + left.width > right.x
      && left.y < right.y + right.height
      && left.y + left.height > right.y;
  }

  wrapText(ctx, value, maximumWidth, maximumLines) {
    const characters = Array.from(String(value || ''));
    const lines = [];
    let line = '';
    for (const character of characters) {
      const candidate = line + character;
      if (line && ctx.measureText(candidate).width > maximumWidth) {
        lines.push(line);
        line = character;
        if (lines.length === maximumLines) break;
      } else {
        line = candidate;
      }
    }
    if (lines.length < maximumLines && line) lines.push(line);
    if (lines.join('').length < characters.length && lines.length) {
      lines[lines.length - 1] = this.fitText(ctx, `${lines.at(-1)}…`, maximumWidth);
    }
    return lines;
  }

  fitText(ctx, value, maximumWidth) {
    const text = String(value || '');
    if (ctx.measureText(text).width <= maximumWidth) return text;
    let result = text;
    while (result.length > 1 && ctx.measureText(`${result}…`).width > maximumWidth) result = result.slice(0, -1);
    return `${result}…`;
  }

  roundedRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }
}

class Interaction {
  constructor(canvasElement, store, renderer, onSelect) {
    this.canvas = canvasElement;
    this.store = store;
    this.renderer = renderer;
    this.onSelect = onSelect;
    this.hoveredKey = null;
    canvasElement.addEventListener('pointermove', (event) => this.onPointerMove(event));
    canvasElement.addEventListener('pointerleave', () => this.setHovered(null));
    canvasElement.addEventListener('click', (event) => this.onClick(event));
  }

  pointerPosition(event) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = rect.width > 0 ? this.renderer.width / rect.width : 1;
    const scaleY = rect.height > 0 ? this.renderer.height / rect.height : 1;
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    };
  }

  hitTest(point) {
    let match = null;
    let nearest = Number.POSITIVE_INFINITY;
    for (const entity of this.store.entities.values()) {
      if (entity.opacity < 0.16 || entity.leaving) continue;
      const radius = entity.baseRadius * entity.scale + 8;
      const distance = Math.hypot(point.x - entity.x, point.y - entity.y);
      if (distance <= radius && distance / radius < nearest) {
        nearest = distance / radius;
        match = entity;
      }
    }
    return match;
  }

  setHovered(key) {
    this.hoveredKey = key;
    this.renderer.hoveredKey = key;
    this.canvas.style.cursor = key ? 'pointer' : 'default';
  }

  onPointerMove(event) {
    this.setHovered(this.hitTest(this.pointerPosition(event))?.key || null);
  }

  onClick(event) {
    const entity = this.hitTest(this.pointerPosition(event));
    if (entity) this.onSelect(entity.key);
  }
}

class A11y {
  constructor(listElement, onSelect) {
    this.list = listElement;
    this.onSelect = onSelect;
  }

  sync(sessions) {
    const fragment = document.createDocumentFragment();
    for (const session of sessions.slice().sort((left, right) => compareText(left.key, right.key))) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      const source = SOURCE_LABELS[session.source] || session.source;
      const status = STATUS_LABELS[session.status] || session.status;
      button.type = 'button';
      button.textContent = `${session.title}、${session.projectName}、${source}、${status}`;
      button.addEventListener('click', () => this.onSelect(session.key));
      item.append(button);
      fragment.append(item);
    }
    this.list.replaceChildren(fragment);
  }
}

class HUD {
  constructor(store) {
    this.store = store;
    this.lastSnapshotAt = null;
    this.eventSamples = [];
    this.sparkContext = eventSparkline.getContext('2d');
    this.tick();
  }

  recordSnapshot(sessions, previousSessions, seed = false) {
    const counts = { thinking: 0, tool: 0, waiting: 0, idle: 0 };
    const now = Date.now();
    for (const session of sessions) {
      counts[session.status] += 1;
      const previous = previousSessions.get(session.key);
      const events = seed
        ? session.recentEvents
        : previous
          ? this.store.newEvents(previous.recentEvents, session.recentEvents)
          : session.recentEvents.slice(-1);
      for (const event of events) {
        const timestamp = eventTimestamp(event, now);
        if (timestamp !== null && timestamp >= now - EVENT_WINDOW_MS && timestamp <= now + 60_000) {
          this.eventSamples.push(timestamp);
        }
      }
    }
    for (const [status, element] of Object.entries(statusCountElements)) {
      element.textContent = String(counts[status]);
    }
    const totalOutput = sessions.reduce(
      (total, session) => total + (Number.isFinite(session.outputTokensTotal) ? session.outputTokensTotal : 0),
      0,
    );
    hudTotalOutput.textContent = formatCompactNumber(totalOutput);
    this.lastSnapshotAt = now;
    this.pruneEvents(now);
    this.drawSparkline(now);
  }

  pruneEvents(now = Date.now()) {
    const cutoff = now - EVENT_WINDOW_MS;
    this.eventSamples = this.eventSamples.filter((timestamp) => timestamp >= cutoff && timestamp <= now + 60_000);
  }

  tick(now = Date.now()) {
    const date = new Date(now);
    const clock = [date.getHours(), date.getMinutes(), date.getSeconds()]
      .map((value) => String(value).padStart(2, '0'))
      .join(':');
    hudClock.textContent = clock;
    hudClock.dateTime = date.toISOString();
    if (this.lastSnapshotAt === null) {
      syncElapsed.textContent = '—';
      hudSync.classList.remove('is-stale');
    } else {
      const elapsed = Math.max(0, Math.floor((now - this.lastSnapshotAt) / 1000));
      syncElapsed.textContent = `${elapsed}s`;
      hudSync.classList.toggle('is-stale', elapsed > 20);
    }
    this.pruneEvents(now);
    this.drawSparkline(now);
  }

  drawSparkline(now = Date.now()) {
    const ctx = this.sparkContext;
    const width = eventSparkline.width;
    const height = eventSparkline.height;
    const counts = Array.from({ length: 15 }, () => 0);
    for (const timestamp of this.eventSamples) {
      const age = now - timestamp;
      const index = 14 - Math.floor(age / 60_000);
      if (index >= 0 && index < counts.length) counts[index] += 1;
    }
    const maximum = Math.max(1, ...counts);
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height - 1.5);
    ctx.lineTo(width, height - 1.5);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(167, 227, 255, 0.72)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    counts.forEach((count, index) => {
      const x = index * width / (counts.length - 1);
      const y = height - 2 - (count / maximum) * (height - 5);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
}

class DetailPanel {
  constructor(store, getRecentEventCount) {
    this.store = store;
    this.getRecentEventCount = getRecentEventCount;
    this.selectedKey = null;
    this.renderedEvents = new Map();
    this.renderedGlobalEvents = new Map();
    this.globalEventsInitialized = false;
    this.typeIns = new Map();
    focusBack.addEventListener('click', () => this.showOverview());
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.selectedKey) this.showOverview();
    });
    this.renderOverview();
  }

  toggle(key) {
    if (this.selectedKey === key) this.showOverview();
    else this.open(key);
  }

  open(key) {
    if (!this.store.sessionsByKey.has(key)) return;
    this.selectedKey = key;
    focusBack.hidden = false;
    overviewView.hidden = true;
    sessionView.hidden = false;
    overviewTreeView.hidden = true;
    sessionTreeView.hidden = false;
    overviewStreamView.hidden = true;
    sessionStreamView.hidden = false;
    panelEyebrow.textContent = 'Session detail';
    this.render();
  }

  showOverview() {
    this.selectedKey = null;
    focusBack.hidden = true;
    overviewView.hidden = false;
    sessionView.hidden = true;
    overviewTreeView.hidden = false;
    sessionTreeView.hidden = true;
    overviewStreamView.hidden = false;
    sessionStreamView.hidden = true;
    panelEyebrow.textContent = 'Operation overview';
    detailTitle.textContent = 'FLEET OVERVIEW';
    this.renderOverview();
  }

  refresh() {
    this.renderOverview();
    if (!this.selectedKey) return;
    if (!this.store.sessionsByKey.has(this.selectedKey)) this.showOverview();
    else this.render();
  }

  renderOverview(now = Date.now()) {
    const groups = new Map();
    const sessions = [...this.store.sessionsByKey.values()]
      .sort((left, right) => compareText(left.key, right.key));
    for (const session of sessions) {
      const key = projectKey(session);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(session);
    }
    this.renderOverviewStats(sessions, groups.size);

    const fragment = document.createDocumentFragment();
    for (const [, projectSessions] of [...groups].sort(([left], [right]) => compareText(left, right))) {
      const project = document.createElement('li');
      project.className = 'overview-project';
      const heading = document.createElement('h4');
      heading.className = 'overview-project-heading';
      heading.textContent = projectSessions[0].projectName;
      const list = document.createElement('ul');
      const projectIds = new Set(projectSessions.map((session) => session.id).filter(Boolean));
      const roots = projectSessions.filter((session) => !session.parentId || !projectIds.has(session.parentId));
      const visited = new Set();
      for (const session of roots) {
        this.appendOverviewSessionNode(list, session, projectSessions, visited);
      }
      for (const session of projectSessions) {
        this.appendOverviewSessionNode(list, session, projectSessions, visited);
      }
      project.append(heading, list);
      fragment.append(project);
    }
    overviewAgents.replaceChildren(fragment);
    if (!overviewAgents.children.length) this.appendItem(overviewAgents, 'セッションはまだありません');
    this.renderGlobalEvents(now);
  }

  renderOverviewStats(sessions = [...this.store.sessionsByKey.values()], sectorCount = null) {
    const statuses = { thinking: 0, tool: 0, waiting: 0, idle: 0 };
    const modelCounts = new Map();
    const sectorCounts = new Map();
    let subAgentCount = 0;
    let writeCount = 0;
    let totalOutput = 0;
    let toolCalls = 0;
    for (const session of sessions) {
      statuses[session.status] += 1;
      if (session.parentId) subAgentCount += 1;
      subAgentCount += session.subAgents.length;
      if (session.model) modelCounts.set(session.model, (modelCounts.get(session.model) ?? 0) + 1);
      if (session.writeAccess === 'write') writeCount += 1;
      if (Number.isFinite(session.outputTokensTotal)) totalOutput += session.outputTokensTotal;
      if (Number.isFinite(session.toolCallsTotal)) toolCalls += session.toolCallsTotal;
      const sector = projectKey(session);
      const current = sectorCounts.get(sector);
      sectorCounts.set(sector, {
        count: (current?.count ?? 0) + 1,
        label: session.projectName,
      });
    }
    const sectors = sectorCount ?? new Set(sessions.map(projectKey)).size;
    const sessionCount = sessions.length;
    overviewSectorCount.textContent = String(sectors);
    overviewSessionCount.textContent = String(sessionCount);
    overviewSubagentCount.textContent = String(subAgentCount);
    overviewEventCount.textContent = String(this.getRecentEventCount());
    overviewModelCounts.textContent = [...modelCounts]
      .sort(([leftModel, leftCount], [rightModel, rightCount]) => (
        rightCount - leftCount || compareText(leftModel, rightModel)
      ))
      .map(([model, count]) => `${model}×${count}`)
      .join(' · ') || '—';
    overviewWriteCount.textContent = String(writeCount);
    const busiestSector = [...sectorCounts.values()]
      .sort((left, right) => right.count - left.count || compareText(left.label, right.label))[0];
    overviewBusiestSector.textContent = busiestSector
      ? `${busiestSector.label} ×${busiestSector.count}`
      : '—';
    overviewTotalOutput.textContent = formatCompactNumber(totalOutput);
    overviewToolCalls.textContent = formatCompactNumber(toolCalls);
    for (const status of Object.keys(STATUS_LABELS)) {
      const count = statuses[status];
      const bar = overviewStatusBarElements[status];
      overviewStatusCountElements[status].textContent = String(count);
      bar.setAttribute('aria-valuenow', String(count));
      bar.setAttribute('aria-valuemax', String(sessionCount));
      bar.firstElementChild.style.width = `${sessionCount ? count / sessionCount * 100 : 0}%`;
    }
  }

  appendOverviewSessionNode(list, session, projectSessions, visited) {
    if (visited.has(session.key)) return;
    visited.add(session.key);
    const item = document.createElement('li');
    item.className = 'overview-session-node';
    item.append(this.createOverviewRow(
      session.title,
      STATUS_LABELS[session.status] || session.status,
      session.status,
      () => this.open(session.key),
      session,
    ));

    const children = document.createElement('ul');
    const codexChildren = projectSessions
      .filter((candidate) => candidate.parentId === session.id && candidate.key !== session.key)
      .sort((left, right) => compareText(left.key, right.key));
    for (const child of codexChildren) {
      this.appendOverviewSessionNode(children, child, projectSessions, visited);
    }
    for (const subAgent of session.subAgents.slice().sort((left, right) => compareText(left.id, right.id))) {
      const done = subAgent.status === 'done';
      const subAgentItem = document.createElement('li');
      subAgentItem.className = 'overview-session-node';
      subAgentItem.append(this.createOverviewRow(
        subAgent.label || 'サブエージェント',
        done ? '完了' : '稼働中',
        done ? 'idle' : 'tool',
      ));
      children.append(subAgentItem);
    }
    if (children.children.length) item.append(children);
    list.append(item);
  }

  createOverviewRow(title, state, status, onSelect = null, session = null) {
    const row = document.createElement(onSelect ? 'button' : 'div');
    row.className = `overview-session-row${onSelect ? '' : ' is-sub-agent'}`;
    if (onSelect) {
      row.type = 'button';
      row.addEventListener('click', onSelect);
    }
    const dot = document.createElement('span');
    dot.className = `state-dot status-${status}`;
    dot.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'agent-title';
    label.textContent = title;
    const meta = document.createElement('small');
    meta.textContent = state;
    row.append(dot, label, meta);
    if (session) row.append(this.createRuntimeMetrics(session), this.createMiniTimeline(session));
    return row;
  }

  collapseEventEntries(entries) {
    const collapsed = [];
    for (const entry of entries) {
      const previous = collapsed.at(-1);
      if (previous?.sessionKey === entry.sessionKey && previous.text === entry.text) {
        previous.count += 1;
        previous.newCount += Number(entry.isNew);
        previous.isNew ||= entry.isNew;
        continue;
      }
      collapsed.push({
        ...entry,
        count: 1,
        newCount: Number(entry.isNew),
      });
    }
    return collapsed;
  }

  createEventItem(entry, now = Date.now()) {
    const item = document.createElement('li');
    if (entry.isNew) item.classList.add('is-new');
    const content = document.createElement('span');
    content.className = 'event-content';
    const label = document.createElement('span');
    label.className = 'event-label';
    this.setTypeInText(
      label,
      entry.label,
      entry.typeIn || (entry.isNew && entry.newCount === entry.count),
    );
    content.append(label);
    if (entry.count > 1) {
      const badge = document.createElement('span');
      badge.className = 'event-repeat-badge';
      badge.textContent = `×${entry.count}`;
      content.append(badge);
    }
    item.append(content);
    if (entry.timestamp !== null) {
      const time = document.createElement('time');
      time.dataset.timestamp = String(entry.timestamp);
      time.dateTime = new Date(entry.timestamp).toISOString();
      time.textContent = formatRelativeTime(entry.timestamp, now);
      item.append(time);
    }
    return item;
  }

  renderGlobalEvents(now = Date.now()) {
    const entries = [];
    const visibleSessionKeys = new Set();
    for (const session of this.store.sessionsByKey.values()) {
      visibleSessionKeys.add(session.key);
      const previousEvents = this.renderedGlobalEvents.get(session.key);
      const additions = previousEvents
        ? this.store.newEvents(previousEvents, session.recentEvents)
        : [];
      const firstNewIndex = session.recentEvents.length - additions.length;
      session.recentEvents.forEach((event, index) => {
        const value = typeof event === 'string' ? event : JSON.stringify(event);
        const text = value.replace(/^\d{2}:\d{2}\s+/, '');
        const timestamp = eventTimestamp(value, now);
        entries.push({
          sessionKey: session.key,
          text,
          label: `${session.title} · ${text}`,
          timestamp,
          sortTime: timestamp ?? session.lastActivity ?? 0,
          tieBreaker: `${session.key}\u0000${String(index).padStart(6, '0')}`,
          isNew: this.globalEventsInitialized && (previousEvents
            ? index >= firstNewIndex
            : index === session.recentEvents.length - 1),
          typeIn: this.globalEventsInitialized
            && !previousEvents
            && index === session.recentEvents.length - 1,
        });
      });
      this.renderedGlobalEvents.set(session.key, session.recentEvents.slice());
    }
    for (const key of this.renderedGlobalEvents.keys()) {
      if (!visibleSessionKeys.has(key)) this.renderedGlobalEvents.delete(key);
    }
    this.globalEventsInitialized = this.store.hasSnapshot;
    entries.sort((left, right) => right.sortTime - left.sortTime
      || compareText(right.tieBreaker, left.tieBreaker));

    const fragment = document.createDocumentFragment();
    const collapsedEntries = this.collapseEventEntries(entries);
    const sessionEntryCounts = new Map();
    const diverseEntries = collapsedEntries.filter((entry) => {
      const count = sessionEntryCounts.get(entry.sessionKey) || 0;
      if (count >= 3) return false;
      sessionEntryCounts.set(entry.sessionKey, count + 1);
      return true;
    });
    for (const entry of diverseEntries.slice(0, GLOBAL_EVENT_LIMIT)) {
      fragment.append(this.createEventItem(entry, now));
    }
    overviewEvents.replaceChildren(fragment);
    if (!overviewEvents.children.length) this.appendItem(overviewEvents, '最近のイベントはありません');
  }

  render() {
    const session = this.store.sessionsByKey.get(this.selectedKey);
    if (!session) return;
    detailTitle.textContent = session.title;
    detailSource.textContent = SOURCE_LABELS[session.source] || session.source;
    detailSource.className = `source-value source-${session.source}`;
    detailCwd.textContent = session.cwd || '未取得';
    detailBranch.textContent = session.gitBranch || '—';
    detailModel.textContent = session.model || '—';
    detailAccess.textContent = session.writeAccess ? session.writeAccess.toUpperCase() : '—';
    detailAccess.className = session.writeAccess ? `access-value access-${session.writeAccess}` : 'access-value';
    detailApproval.textContent = session.approvalPolicy || '—';
    detailOrigin.textContent = session.originator || '—';
    detailOutputTokens.textContent = formatCompactNumber(session.outputTokensTotal) || '—';
    detailTopTools.textContent = topToolsLabel(session);
    this.updateLiveReadouts(session);
    this.renderTimeline(session);
    this.renderAgentTree(session);
    this.renderEvents(session);
  }

  updateLiveReadouts(session, now = Date.now()) {
    const longRun = isLongRunning(session, now);
    detailStatus.textContent = STATUS_LABELS[session.status] || session.status;
    detailStatus.className = `status-badge status-${session.status}${longRun ? ' is-long-run' : ''}`;
    detailLongRun.hidden = !longRun;
    detailLastSignal.textContent = formatRelativeTime(session.lastActivity, now);
    detailUptime.textContent = formatUptime(session.startedAt, now);
  }

  tick(now = Date.now()) {
    for (const element of overviewEvents.querySelectorAll('time[data-timestamp]')) {
      element.textContent = formatRelativeTime(Number(element.dataset.timestamp), now);
    }
    for (const element of panel.querySelectorAll('.mini-status-timeline[data-session-key]')) {
      this.renderMiniTimeline(element, element.dataset.sessionKey, now);
    }
    for (const element of panel.querySelectorAll('.agent-runtime[data-session-key]')) {
      const session = this.store.sessionsByKey.get(element.dataset.sessionKey);
      if (session) element.textContent = this.runtimeMetricsLabel(session, now);
    }
    if (!this.selectedKey) {
      this.renderOverviewStats();
      return;
    }
    const session = this.store.sessionsByKey.get(this.selectedKey);
    if (!session) return;
    this.updateLiveReadouts(session, now);
    this.renderTimeline(session, now);
    for (const element of detailEvents.querySelectorAll('time[data-timestamp]')) {
      element.textContent = formatRelativeTime(Number(element.dataset.timestamp), now);
    }
  }

  renderTimeline(session, now = Date.now()) {
    const labels = this.renderStatusSegments(detailTimeline, session.key, now);
    detailTimeline.setAttribute(
      'aria-label',
      labels.length ? `直近30分の状態履歴: ${labels.join('、')}` : '状態履歴はまだありません',
    );
  }

  renderStatusSegments(element, sessionKey, now = Date.now()) {
    const history = this.store.statusHistory.get(sessionKey) || [];
    const cutoff = now - STATUS_HISTORY_MS;
    const fragment = document.createDocumentFragment();
    const labels = [];
    history.forEach((entry, index) => {
      const start = Math.max(cutoff, entry.t);
      const end = Math.min(now, history[index + 1]?.t ?? now);
      if (end <= start) return;
      const segment = document.createElement('span');
      segment.className = `timeline-segment status-${entry.status}`;
      segment.style.left = `${(start - cutoff) / STATUS_HISTORY_MS * 100}%`;
      segment.style.width = `${Math.max(0.25, (end - start) / STATUS_HISTORY_MS * 100)}%`;
      fragment.append(segment);
      labels.push(STATUS_LABELS[entry.status] || entry.status);
    });
    element.replaceChildren(fragment);
    return labels;
  }

  createMiniTimeline(session, now = Date.now()) {
    const timeline = document.createElement('span');
    timeline.className = 'mini-status-timeline';
    timeline.dataset.sessionKey = session.key;
    this.renderMiniTimeline(timeline, session.key, now);
    return timeline;
  }

  renderMiniTimeline(element, sessionKey, now = Date.now()) {
    const labels = this.renderStatusSegments(element, sessionKey, now);
    element.setAttribute(
      'aria-label',
      labels.length ? `状態履歴: ${labels.join('、')}` : '状態履歴はまだありません',
    );
  }

  runtimeMetricsLabel(session, now = Date.now()) {
    return [outputTokensLabel(session), formatUptime(session.startedAt, now)]
      .filter((value) => value && value !== '—')
      .join(' · ') || '—';
  }

  createRuntimeMetrics(session, now = Date.now()) {
    const metrics = document.createElement('small');
    metrics.className = 'agent-runtime';
    metrics.dataset.sessionKey = session.key;
    metrics.textContent = this.runtimeMetricsLabel(session, now);
    return metrics;
  }

  renderAgentTree(session) {
    detailAgents.replaceChildren();
    this.appendSessionNode(detailAgents, session, new Set(), true);
  }

  appendSessionNode(list, session, visited, root = false) {
    if (visited.has(session.key)) return;
    visited.add(session.key);
    const item = this.createAgentNode(
      session.title,
      STATUS_LABELS[session.status] || session.status,
      session.status,
      root,
      session,
    );
    list.append(item);
    const childList = document.createElement('ul');
    const codexChildren = [...this.store.sessionsByKey.values()]
      .filter((candidate) => candidate.parentId === session.id && candidate.key !== session.key)
      .sort((left, right) => compareText(left.key, right.key));
    for (const child of codexChildren) this.appendSessionNode(childList, child, visited);
    for (const subAgent of session.subAgents.slice().sort((left, right) => compareText(left.id, right.id))) {
      const done = subAgent.status === 'done';
      childList.append(this.createAgentNode(
        subAgent.label || 'サブエージェント',
        done ? '完了' : '稼働中',
        done ? 'idle' : 'tool',
      ));
    }
    if (childList.children.length) item.append(childList);
  }

  createAgentNode(title, state, status, root = false, session = null) {
    const item = document.createElement('li');
    item.className = `agent-tree-node${root ? ' is-root' : ''}`;
    const row = document.createElement('div');
    row.className = 'agent-tree-row';
    if (!root) {
      const branch = document.createElement('span');
      branch.className = 'tree-branch';
      branch.textContent = '└─';
      row.append(branch);
    }
    const dot = document.createElement('span');
    dot.className = `state-dot status-${status}`;
    dot.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'agent-title';
    label.textContent = title;
    const meta = document.createElement('small');
    meta.textContent = state;
    row.append(dot, label, meta);
    if (session) row.append(this.createRuntimeMetrics(session), this.createMiniTimeline(session));
    item.append(row);
    return item;
  }

  renderEvents(session) {
    const previousEvents = this.renderedEvents.get(session.key);
    const additions = previousEvents ? this.store.newEvents(previousEvents, session.recentEvents) : [];
    const firstNewIndex = session.recentEvents.length - additions.length;
    this.renderedEvents.set(session.key, session.recentEvents.slice());
    const entries = [];
    for (let index = session.recentEvents.length - 1; index >= 0; index -= 1) {
      const event = session.recentEvents[index];
      const value = typeof event === 'string' ? event : JSON.stringify(event);
      const text = value.replace(/^\d{2}:\d{2}\s+/, '');
      entries.push({
        sessionKey: session.key,
        text,
        label: text,
        timestamp: eventTimestamp(value),
        isNew: Boolean(previousEvents && index >= firstNewIndex),
      });
    }
    detailEvents.replaceChildren();
    for (const entry of this.collapseEventEntries(entries)) {
      detailEvents.append(this.createEventItem(entry));
    }
    if (!detailEvents.children.length) this.appendItem(detailEvents, '最近のイベントはありません');
  }

  setTypeInText(element, value, enabled) {
    const characters = Array.from(value);
    if (!enabled || this.store.reducedMotion || !characters.length) {
      element.textContent = value;
      return;
    }
    element.textContent = '';
    this.typeIns.set(element, {
      characters,
      age: 0,
      duration: 0.25,
    });
  }

  updateTypeIns(deltaTime) {
    for (const [element, typeIn] of this.typeIns) {
      if (!element.isConnected) {
        this.typeIns.delete(element);
        continue;
      }
      typeIn.age += deltaTime;
      const progress = this.store.reducedMotion ? 1 : clamp(typeIn.age / typeIn.duration, 0, 1);
      const visibleLength = Math.ceil(progress * typeIn.characters.length);
      element.textContent = typeIn.characters.slice(0, visibleLength).join('');
      if (progress >= 1) this.typeIns.delete(element);
    }
  }

  appendItem(list, primary, secondary = '') {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = primary;
    item.append(label);
    if (secondary) {
      const meta = document.createElement('small');
      meta.textContent = secondary;
      item.append(meta);
    }
    list.append(item);
  }
}

class App {
  constructor() {
    this.store = new Store();
    this.reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.sim = new Sim(this.store, this.reducedMotionQuery.matches);
    this.resize = this.resize.bind(this);
    this.animate = this.animate.bind(this);
    this.tick = this.tick.bind(this);
    this.renderer = new Renderer(canvas, this.store, this.sim);
    this.hud = new HUD(this.store);
    this.panel = new DetailPanel(this.store, () => this.hud.eventSamples.length);
    this.interaction = new Interaction(canvas, this.store, this.renderer, (key) => this.panel.toggle(key));
    this.a11y = new A11y(sessionList, (key) => this.panel.toggle(key));
    this.wsClient = new WSClient({
      onSnapshot: (sessions) => this.onSnapshot(sessions),
      onConnection: (connected) => this.setConnection(connected),
    });
    this.animationFrame = null;
    this.secondTimer = null;
    this.lastFrameTime = 0;

    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(canvasRegion);
    window.addEventListener('resize', this.resize);
    document.addEventListener('visibilitychange', () => this.onVisibilityChange());
    this.reducedMotionQuery.addEventListener('change', (event) => this.sim.setReducedMotion(event.matches));
    window.addEventListener('beforeunload', () => {
      this.wsClient.stop();
      this.stopTemporalUpdates();
      this.resizeObserver.disconnect();
    });

    this.resize();
    this.wsClient.connect();
    this.startAnimation();
    this.startTemporalUpdates();
  }

  resize() {
    this.renderer.resize();
    this.sim.resize(this.renderer.width, this.renderer.height);
  }

  onSnapshot(rawSessions) {
    const previousSessions = this.store.sessionsByKey;
    const seedEvents = !this.store.hasSnapshot;
    const sessions = this.store.applySnapshot(rawSessions);
    this.sim.syncSnapshot();
    this.a11y.sync(sessions);
    this.hud.recordSnapshot(sessions, previousSessions, seedEvents);
    this.panel.refresh();
  }

  setConnection(connected) {
    connection.classList.toggle('is-connected', connected);
    connection.classList.toggle('is-waiting', !connected);
    connectionLabel.textContent = connected ? 'Link ok' : 'Link lost';
    document.body.classList.toggle('link-lost', !connected);
  }

  startTemporalUpdates() {
    if (document.hidden || this.secondTimer !== null) return;
    this.tick();
    this.secondTimer = window.setInterval(this.tick, 1000);
  }

  stopTemporalUpdates() {
    if (this.secondTimer !== null) window.clearInterval(this.secondTimer);
    this.secondTimer = null;
  }

  tick() {
    const now = Date.now();
    this.hud.tick(now);
    this.panel.tick(now);
  }

  startAnimation() {
    if (document.hidden || this.animationFrame !== null) return;
    this.lastFrameTime = 0;
    this.animationFrame = requestAnimationFrame(this.animate);
  }

  onVisibilityChange() {
    if (document.hidden) {
      if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
      this.lastFrameTime = 0;
      this.stopTemporalUpdates();
    } else {
      this.startAnimation();
      this.startTemporalUpdates();
    }
  }

  animate(timestamp) {
    if (document.hidden) {
      this.animationFrame = null;
      return;
    }
    const minimumFrameTime = 1000 / 30;
    const elapsed = this.lastFrameTime ? timestamp - this.lastFrameTime : minimumFrameTime;
    if (this.lastFrameTime && elapsed < minimumFrameTime) {
      this.animationFrame = requestAnimationFrame(this.animate);
      return;
    }
    this.lastFrameTime = timestamp;
    const deltaTime = Math.min(elapsed / 1000, 0.1);
    this.sim.setFamilyFocus(this.interaction.hoveredKey, this.panel.selectedKey);
    this.sim.update(deltaTime, timestamp / 1000);
    this.panel.updateTypeIns(deltaTime);
    this.renderer.render();
    this.animationFrame = requestAnimationFrame(this.animate);
  }
}

new App();
