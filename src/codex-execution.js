import path from 'node:path';
import { addRecentEvent, normalizeCwd, timestampMs } from './state.js';

const MAX_ITEMS = 256;
const MAX_TURNS = 128;
const MAX_COMMANDS = 20;
const MAX_FILES = 100;

function text(value, maximum) {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact ? Array.from(compact).slice(0, maximum).join('') : null;
}

function finiteTime(value) {
  return Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000 ? value : null;
}

function seconds(value) {
  return Number.isFinite(value) ? finiteTime(value * 1000) : null;
}

function identity(value) {
  return typeof value === 'string' && value ? value : null;
}

function remember(set, key, maximum) {
  if (set.has(key)) return false;
  set.add(key);
  if (set.size > maximum) set.delete(set.values().next().value);
  return true;
}

function stateFor(session) {
  session.codexDetails ??= {};
  session.codexDetails.turn ??= null;
  session.codexDetails.commands ??= [];
  session.codexDetails.fileChanges ??= [];
  session.codexDetails.filesTruncated ??= false;
  session.codexExecution ??= { items: new Set(), turns: new Set(), files: new Map() };
  return session.codexExecution;
}

function newTurn(session, turn) {
  session.codexDetails.turn = turn;
  session.codexDetails.fileChanges = [];
  session.codexDetails.filesTruncated = false;
  session.codexExecution.files.clear();
}

function applyTurn(session, record, payload, state) {
  const details = session.codexDetails;
  const id = identity(payload.turn_id);
  const current = details.turn;
  if (record.type === 'turn_context') {
    if (!id || id === current?.id || state.turns.has(id)) return;
    if (current?.id) remember(state.turns, current.id, MAX_TURNS);
    newTurn(session, { id, status: 'unknown', startedAt: null, completedAt: null, durationMs: null });
    return;
  }
  if (record.type !== 'event_msg') return;
  if (payload.type === 'task_started') {
    const startKey = id ?? `at:${payload.started_at ?? record.timestamp}`;
    if (id && state.turns.has(id)) return;
    if (!id && state.lastStartKey === startKey) return;
    state.lastStartKey = startKey;
    if (current?.id && current.id !== id) remember(state.turns, current.id, MAX_TURNS);
    const turn = {
      id, status: 'active',
      startedAt: seconds(payload.started_at) ?? timestampMs(record.timestamp),
      completedAt: null, durationMs: null,
    };
    if (current && id && current.id === id) details.turn = turn;
    else newTurn(session, turn);
    if (id) remember(state.turns, id, MAX_TURNS);
  } else if (payload.type === 'task_complete' || payload.type === 'turn_aborted') {
    if (id && current?.id && id !== current.id) return;
    if (current && ['completed', 'interrupted'].includes(current.status)) return;
    if (!current && id && state.turns.has(id)) return;
    const startedAt = current?.startedAt ?? seconds(payload.started_at);
    const completedAt = seconds(payload.completed_at) ?? timestampMs(record.timestamp);
    const durationMs = finiteTime(payload.duration_ms)
      ?? (startedAt !== null && completedAt !== null && completedAt >= startedAt
        ? completedAt - startedAt : null);
    details.turn = {
      id: id ?? current?.id ?? null,
      status: payload.type === 'turn_aborted' ? 'interrupted' : 'completed',
      startedAt, completedAt, durationMs,
    };
    if (details.turn.id) remember(state.turns, details.turn.id, MAX_TURNS);
  }
}

function commandDuration(item, payload) {
  const duration = item.duration;
  if (Number.isInteger(duration?.secs) && duration.secs >= 0
    && Number.isInteger(duration?.nanos) && duration.nanos >= 0 && duration.nanos < 1e9) {
    return finiteTime(duration.secs * 1000 + duration.nanos / 1e6);
  }
  const start = finiteTime(payload.started_at_ms);
  const end = finiteTime(payload.completed_at_ms);
  return start !== null && end !== null && end >= start ? end - start : null;
}

function applyCommand(session, record, payload, item, turnId) {
  const command = Array.isArray(item.command) && item.command.every((part) => typeof part === 'string')
    ? item.command.join(' ') : item.command;
  const exitCode = Number.isInteger(item.exit_code) ? item.exit_code : null;
  const outcome = item.status === 'failed' ? 'failed'
    : item.status === 'completed' && exitCode !== null ? (exitCode === 0 ? 'success' : 'failed')
      : 'unknown';
  const result = {
    id: item.id, turnId, label: text(command, 120) ?? 'Command', outcome, exitCode,
    durationMs: commandDuration(item, payload),
    completedAt: finiteTime(payload.completed_at_ms) ?? timestampMs(record.timestamp),
  };
  session.codexDetails.commands.push(result);
  if (session.codexDetails.commands.length > MAX_COMMANDS) session.codexDetails.commands.shift();
  const label = outcome === 'unknown' ? 'result unknown' : outcome;
  const code = exitCode === null ? '' : ` (exit ${exitCode})`;
  const duration = result.durationMs === null ? '' : result.durationMs < 1000
    ? ` · ${Math.round(result.durationMs)}ms` : ` · ${Math.round(result.durationMs / 100) / 10}s`;
  addRecentEvent(session, record.timestamp, `${result.label}: ${label}${code}${duration}`);
}

function fullPath(value, cwd) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = normalizeCwd(value);
  const absolute = normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized);
  const full = path.posix.normalize(absolute || !cwd ? normalized : `${normalizeCwd(cwd)}/${normalized}`);
  return full.replace(/^[a-z]:\//, (drive) => drive.toUpperCase());
}

function displayPath(value, cwd) {
  const base = fullPath(cwd, '')?.replace(/\/$/, '');
  const relative = base && value.startsWith(`${base}/`) ? value.slice(base.length + 1) : value;
  return Array.from(relative).slice(0, 240).join('');
}

function applyFiles(session, record, item, turnId, state) {
  if (item.status !== 'completed' || !item.changes || typeof item.changes !== 'object'
    || Array.isArray(item.changes)) return;
  const current = session.codexDetails.turn;
  if (current?.id && current.id !== turnId) return;
  if (!current?.id && turnId) {
    newTurn(session, { id: turnId, status: 'unknown', startedAt: null, completedAt: null, durationMs: null });
  }
  const cwd = typeof session.cwd === 'string' ? session.cwd : '';
  const examples = [];
  let observed = 0;
  for (const [changedPath, change] of Object.entries(item.changes)) {
    if (!change || !['add', 'update', 'delete'].includes(change.type)) continue;
    const original = fullPath(changedPath, cwd);
    if (!original) continue;
    const moved = change.type === 'update' ? fullPath(change.move_path, cwd) : null;
    const target = moved ?? original;
    observed += 1;
    if (examples.length < 2) examples.push(`${moved ? 'move' : change.type} ${text(displayPath(target, cwd), 60)}`);
    const retainedCount = state.files.size - (moved && state.files.has(original) ? 1 : 0);
    if (!state.files.has(target) && retainedCount >= MAX_FILES) {
      session.codexDetails.filesTruncated = true;
      continue;
    }
    if (moved) state.files.delete(original);
    state.files.set(target, {
      path: displayPath(target, cwd), kind: moved ? 'move' : change.type,
      ...(moved ? { from: displayPath(original, cwd) } : {}),
    });
  }
  session.codexDetails.fileChanges = [...state.files.values()];
  if (observed) {
    const extra = observed > examples.length ? `, +${observed - examples.length} more` : '';
    addRecentEvent(session, record.timestamp,
      `Observed edits: ${observed} ${observed === 1 ? 'file' : 'files'} · ${examples.join(', ')}${extra}`);
  }
}

// Recover replay identities without publishing execution details from skipped history.
export function seedCodexTurnHistory(session, turnIds, currentTurnId) {
  const state = stateFor(session);
  for (const id of turnIds) remember(state.turns, id, MAX_TURNS);
  if (identity(currentTurnId)) {
    newTurn(session, { id: currentTurnId, status: 'unknown', startedAt: null, completedAt: null, durationMs: null });
  }
}

// Only the observed tail is applied here. Historical head metadata never replays work.
export function applyCodexExecution(session, record) {
  if (!record || typeof record !== 'object') return;
  const payload = record.payload;
  if (!payload || typeof payload !== 'object') return;
  const state = stateFor(session);
  applyTurn(session, record, payload, state);
  if (record.type !== 'event_msg' || payload.type !== 'item_completed') return;
  const item = payload.item;
  if (!item || !['CommandExecution', 'FileChange'].includes(item.type) || !identity(item.id)) return;
  const turnId = identity(payload.turn_id);
  const key = JSON.stringify([turnId, item.type, item.id]);
  if (!remember(state.items, key, MAX_ITEMS)) return;
  if (item.type === 'CommandExecution') applyCommand(session, record, payload, item, turnId);
  else applyFiles(session, record, item, turnId, state);
}
