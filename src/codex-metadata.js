import { addRecentEvent } from './state.js';

const MAX_IDENTITIES = 256;
const MAX_LIMITS = 8;

function boundedText(value, maximum) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? Array.from(text).slice(0, maximum).join('') : null;
}

function recordTime(record) {
  if (typeof record.timestamp !== 'string') return null;
  const time = Date.parse(record.timestamp);
  return Number.isFinite(time) ? time : null;
}

function epochSeconds(value) {
  return Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000
    ? value * 1000 : null;
}

function remember(set, key) {
  if (set.has(key)) return false;
  set.add(key);
  if (set.size > MAX_IDENTITIES) set.delete(set.values().next().value);
  return true;
}

function boundaryFor(turn) {
  return turn ? turn.id ?? turn.startedAt ?? null : null;
}

function applyEffort(session, record, payload, details) {
  const boundary = boundaryFor(details.turn);
  if (session.codexEffortBoundary !== boundary) {
    details.effort = null;
    session.codexEffortBoundary = boundary;
  }
  if (record.type !== 'turn_context') return;
  if (typeof payload.turn_id === 'string' && details.turn?.id
    && payload.turn_id !== details.turn.id) return;
  details.effort = boundedText(payload.effort, 32);
}

function applyCompaction(session, record, payload, details, time) {
  const item = record.type === 'event_msg' && payload.type === 'item_completed'
    ? payload.item : null;
  const representation = record.type === 'compacted' ? 'record'
    : item?.type === 'ContextCompaction' ? 'item' : null;
  if (!representation || time === null) return;
  if (item?.status && !['completed', 'success'].includes(item.status)) return;
  const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : details.turn?.id ?? null;
  const id = boundedText(item?.id ?? payload.id ?? record.id, 256);
  const completedAt = Number.isFinite(payload.completed_at_ms) && payload.completed_at_ms >= 0
    ? payload.completed_at_ms : time;
  session.codexCompactionIds ??= new Set();
  if (id && !remember(session.codexCompactionIds, JSON.stringify([turnId, id]))) return;

  // Two recorded representations may share the same completion timestamp even
  // when only the item has an ID. Never use token-count changes as evidence.
  session.codexCompactionTimes ??= new Map();
  const key = JSON.stringify([turnId, completedAt]);
  const previous = session.codexCompactionTimes.get(key);
  if (previous && (!previous.id || !id || previous.id === id)) {
    // Keep both representations: replaying the ID-less half of an already
    // paired operation must remain a duplicate after the item ID is skipped.
    previous.representations.add(representation);
    previous.id ??= id;
    return;
  }
  session.codexCompactionTimes.set(key, { representations: new Set([representation]), id });
  if (session.codexCompactionTimes.size > MAX_IDENTITIES) {
    session.codexCompactionTimes.delete(session.codexCompactionTimes.keys().next().value);
  }
  details.compaction = {
    observedCount: (details.compaction?.observedCount ?? 0) + 1,
    lastAt: Math.max(details.compaction?.lastAt ?? 0, completedAt),
  };
  addRecentEvent(session, record.timestamp, 'History compacted');
}

function allowanceWindow(name, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    name,
    remainingPercent: Number.isFinite(value.used_percent)
      ? Math.min(100, Math.max(0, 100 - value.used_percent)) : null,
    windowMinutes: Number.isFinite(value.window_minutes) && value.window_minutes > 0
      ? value.window_minutes : null,
    resetsAt: epochSeconds(value.resets_at),
  };
}

function applyAllowance(session, payload, details, time) {
  if (payload.type !== 'token_count' || time === null) return;
  const snapshot = payload.rate_limits;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return;
  const limitId = boundedText(snapshot.limit_id, 80) ?? 'unspecified';
  const windows = ['primary', 'secondary']
    .map((name) => allowanceWindow(name, snapshot[name])).filter(Boolean);
  session.codexAllowanceSnapshots ??= new Map();
  const previous = session.codexAllowanceSnapshots.get(limitId);
  if (previous && previous.observedAt > time) return;
  session.codexAllowanceSnapshots.delete(limitId);
  session.codexAllowanceSnapshots.set(limitId, { limitId, observedAt: time, windows });
  if (session.codexAllowanceSnapshots.size > MAX_LIMITS) {
    session.codexAllowanceSnapshots.delete(session.codexAllowanceSnapshots.keys().next().value);
  }
  details.allowances = [...session.codexAllowanceSnapshots.values()];
}

// Called for the observed tail/append only, after execution establishes its turn.
// The historical metadata head must not manufacture current observations.
export function applyCodexMetadata(session, record) {
  if (!record || typeof record !== 'object') return;
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
  const details = session.codexDetails ??= {};
  details.effort ??= null;
  details.compaction ??= null;
  details.allowances ??= [];
  applyEffort(session, record, payload, details);
  const time = recordTime(record);
  applyCompaction(session, record, payload, details, time);
  if (record.type === 'event_msg') applyAllowance(session, payload, details, time);
}
