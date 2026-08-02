import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import chokidar from 'chokidar';

export const DELEGATION_VERSION = 1;
export const TERMINAL_VISIBLE_MS = 60 * 1000;
export const MAX_RECOVERY_LINKS = 64;
export const MAX_VISIBLE_PAIRS = 8;

const MAX_FILE_BYTES = 8 * 1024;
const MAX_LINK_AGE_MS = 26 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 60 * 1000;
const CHILD_CLOCK_SKEW_MS = 2 * 1000;
const START_RETENTION_MS = 26 * 60 * 60 * 1000;
const DEFAULT_STARTUP_TIMEOUT_MS = 3_000;
const LINK_ID_RE = /^agl_[A-Za-z0-9_-]{20,80}$/;
const CHILD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const TERMINAL_STATUSES = new Set(['complete', 'failed', 'timed_out']);

function debug(message, error) {
  if (process.env.AGENTARIUM_DEBUG) console.error(`[delegations] ${message}`, error ?? '');
}

export function delegationRoot(env = process.env, homedir = os.homedir()) {
  const override = env.AGENTARIUM_DELEGATION_DIR;
  if (typeof override === 'string' && override.trim() && path.isAbsolute(override.trim())) {
    return path.resolve(override.trim());
  }
  return path.join(homedir, '.agentarium-space', 'delegations-v1');
}

export function createDelegationLinkId() {
  return `agl_${randomBytes(18).toString('base64url')}`;
}

function finiteTimestamp(value) {
  return Number.isFinite(value) && Number.isInteger(value) && value > 0 ? value : null;
}

export function parseDelegationRecord(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.version !== DELEGATION_VERSION) return null;
  if (typeof value.linkId !== 'string' || !LINK_ID_RE.test(value.linkId)) return null;
  if (value.childSource !== 'claude' && value.childSource !== 'codex') return null;
  if (typeof value.childSessionId !== 'string' || !CHILD_ID_RE.test(value.childSessionId)) return null;
  if (value.status !== 'running' && !TERMINAL_STATUSES.has(value.status)) return null;

  const startedAt = finiteTimestamp(value.startedAt);
  const updatedAt = finiteTimestamp(value.updatedAt);
  if (startedAt === null || updatedAt === null) return null;
  if (startedAt > now + MAX_FUTURE_MS || updatedAt < startedAt || updatedAt > now + MAX_FUTURE_MS) return null;
  if (updatedAt - startedAt > MAX_LINK_AGE_MS) return null;

  if (value.status === 'running') {
    const expiresAt = finiteTimestamp(value.expiresAt);
    if (expiresAt === null || expiresAt < updatedAt || expiresAt - startedAt > MAX_LINK_AGE_MS) return null;
    return {
      version: DELEGATION_VERSION,
      linkId: value.linkId,
      childSource: value.childSource,
      childSessionId: value.childSessionId,
      status: value.status,
      startedAt,
      updatedAt,
      expiresAt,
    };
  }

  const endedAt = finiteTimestamp(value.endedAt);
  if (endedAt === null || endedAt < startedAt || updatedAt < endedAt) return null;
  if (endedAt - startedAt > MAX_LINK_AGE_MS) return null;
  return {
    version: DELEGATION_VERSION,
    linkId: value.linkId,
    childSource: value.childSource,
    childSessionId: value.childSessionId,
    status: value.status,
    startedAt,
    updatedAt,
    endedAt,
  };
}

function isVisible(record, now) {
  if (record.status === 'running') return record.expiresAt > now;
  return record.endedAt <= now + MAX_FUTURE_MS && now - record.endedAt < TERMINAL_VISIBLE_MS;
}

function markerIds(command) {
  if (typeof command !== 'string' || command.length > 32 * 1024) return [];
  const ids = [];
  const pattern = /(?:^|\s)--agentarium-link(?:=|\s+)(?:["']?)(agl_[A-Za-z0-9_-]{20,80})(?:["']?)(?=\s|$)/g;
  for (const match of command.matchAll(pattern)) ids.push(match[1]);
  return [...new Set(ids)].filter((id) => LINK_ID_RE.test(id));
}

function hasAllowedWrapper(command, childSource) {
  const normalized = command.replaceAll('\\', '/');
  if (childSource === 'codex') {
    return /\/(?:\.claude|\.agents)\/skills\/codex\/scripts\/run-codex(?:-write|-bg)?\.sh(?=[\s"']|$)/.test(normalized);
  }
  return /\/(?:\.claude|\.agents)\/skills\/claude\/scripts\/run-claude(?:-write)?\.sh(?=[\s"']|$)/.test(normalized);
}

export function delegationLinkIdFromCommand(command, childSource) {
  if (typeof command !== 'string' || !hasAllowedWrapper(command, childSource)) return null;
  const ids = markerIds(command);
  return ids.length === 1 ? ids[0] : null;
}

function findCommand(value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 4) return null;
  for (const [key, candidate] of Object.entries(value)) {
    if ((key.toLowerCase() === 'command' || key.toLowerCase() === 'cmd')
      && typeof candidate === 'string') return candidate;
  }
  for (const candidate of Object.values(value)) {
    const nested = findCommand(candidate, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function commandFromRawInput(input) {
  if (typeof input !== 'string' || input.length > 32 * 1024) return null;
  const match = input.match(/(?:command|cmd)\s*[:=]\s*("(?:[^"\\]|\\.){1,32768}")/i);
  if (match) {
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }
  return hasAllowedWrapper(input, 'claude') ? input : null;
}

export function codexDelegationCommand(argumentsValue, inputValue) {
  let parsed = argumentsValue;
  if (typeof argumentsValue === 'string') {
    try {
      parsed = JSON.parse(argumentsValue);
    } catch {
      parsed = null;
    }
  }
  return findCommand(parsed) ?? commandFromRawInput(inputValue);
}

export function recordDelegationStart(map, linkId, parentKey, parentSource, startedAt) {
  if (!(map instanceof Map) || !LINK_ID_RE.test(linkId)) return;
  if (parentSource !== 'claude' && parentSource !== 'codex') return;
  if (typeof parentKey !== 'string' || !parentKey || !Number.isFinite(startedAt)) return;
  const existing = map.get(linkId);
  if (existing && (existing.parentKey !== parentKey || existing.parentSource !== parentSource)) {
    map.set(linkId, { linkId, ambiguous: true, startedAt: Math.min(existing.startedAt, startedAt) });
    return;
  }
  map.set(linkId, { linkId, parentKey, parentSource, startedAt });
}

export function activeDelegationStarts(map, now = Date.now()) {
  const starts = [];
  for (const [linkId, start] of map) {
    if (!Number.isFinite(start.startedAt) || now - start.startedAt > START_RETENTION_MS) {
      map.delete(linkId);
      continue;
    }
    if (!start.ambiguous) starts.push(start);
  }
  return starts;
}

export async function recoverDelegationStartsFromFiles({ files, linkIds, parseRecord }) {
  const wanted = new Set(linkIds);
  if (wanted.size === 0 || typeof parseRecord !== 'function') return;
  const queue = [...files];
  const worker = async () => {
    while (queue.length > 0 && wanted.size > 0) {
      const filePath = queue.shift();
      const input = createReadStream(filePath, { encoding: 'utf8' });
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (line.length > 256 * 1024 || !line.includes('--agentarium-link')) continue;
          let record;
          try {
            record = JSON.parse(line);
          } catch {
            continue;
          }
          const start = parseRecord(record, filePath);
          if (start && wanted.delete(start.linkId) && wanted.size === 0) break;
        }
      } catch (error) {
        debug(`could not recover markers from ${filePath}`, error);
      } finally {
        lines.close();
        input.destroy();
      }
    }
  };
  const concurrency = Math.min(8, queue.length);
  await Promise.all(Array.from({ length: concurrency }, worker));
}

function resolveChild(record, sessions, now) {
  const end = record.status === 'running' ? now : record.endedAt;
  const candidates = sessions.filter((session) => (
    session.source === record.childSource
      && session.id === record.childSessionId
      && Number.isFinite(session.lastActivity)
      && session.lastActivity >= record.startedAt - CHILD_CLOCK_SKEW_MS
      && session.lastActivity <= end + CHILD_CLOCK_SKEW_MS
  ));
  return candidates.length === 1 ? candidates[0] : null;
}

export function resolveDelegations(records, starts, sessions, now = Date.now()) {
  const startsById = new Map(starts.map((start) => [start.linkId, start]));
  const sessionsByKey = new Map(sessions.map((session) => [session.key, session]));
  const resolved = [];

  for (const record of records) {
    if (!isVisible(record, now)) continue;
    const start = startsById.get(record.linkId);
    if (!start || start.ambiguous || start.parentSource === record.childSource) continue;
    const parent = sessionsByKey.get(start.parentKey);
    const child = resolveChild(record, sessions, now);
    if (!parent || !child || parent.key === child.key) continue;
    resolved.push({
      id: record.linkId,
      parentKey: parent.key,
      childKey: child.key,
      parentSource: parent.source,
      childSource: child.source,
      status: record.status,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      endedAt: record.endedAt ?? null,
      count: 1,
    });
  }

  const pairs = new Map();
  for (const link of resolved.sort((left, right) => right.updatedAt - left.updatedAt)) {
    const pairKey = `${link.parentKey}\0${link.childKey}`;
    const existing = pairs.get(pairKey);
    if (!existing) {
      pairs.set(pairKey, link);
      continue;
    }
    existing.count += 1;
    if (link.status === 'running' && existing.status !== 'running') {
      pairs.set(pairKey, { ...link, count: existing.count });
    }
  }

  return [...pairs.values()]
    .sort((left, right) => (
      Number(right.status === 'running') - Number(left.status === 'running')
        || right.updatedAt - left.updatedAt
    ))
    .slice(0, MAX_VISIBLE_PAIRS);
}

async function readDelegationFile(filePath, now) {
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_FILE_BYTES) return null;
  const raw = await readFile(filePath, 'utf8');
  return parseDelegationRecord(JSON.parse(raw), now);
}

function abortPromise(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
  });
}

function timeoutPromise(milliseconds) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('delegation reader startup timed out')), milliseconds);
    timer.unref?.();
  });
}

export function createDelegationReader({
  root = delegationRoot(),
  onUpdate = () => {},
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  watchFactory = chokidar.watch,
} = {}) {
  root = path.resolve(root);
  const records = new Map();
  let state = 'idle';
  let watcher = null;
  let startPromise = null;
  let generation = 0;
  let controller = null;

  function recordsNow(now = Date.now()) {
    return [...records.values()]
      .filter((record) => isVisible(record, now))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_RECOVERY_LINKS);
  }

  async function load(filePath, notify = true) {
    if (path.extname(filePath).toLowerCase() !== '.json') return;
    try {
      const record = await readDelegationFile(filePath, Date.now());
      if (!record) {
        const deleted = records.delete(filePath);
        if (notify && deleted) onUpdate({ phase: 'normal' });
        return;
      }
      const previous = records.get(filePath);
      records.set(filePath, record);
      if (notify) onUpdate({ phase: !previous && record.status === 'running' ? 'running' : 'normal' });
    } catch (error) {
      const deleted = records.delete(filePath);
      if (notify && deleted) onUpdate({ phase: 'normal' });
      debug(`ignored invalid sidecar ${filePath}`, error);
    }
  }

  async function scan() {
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await chmod(root, 0o700).catch(() => {});
      const entries = await readdir(root, { withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
        .map((entry) => path.join(root, entry.name));
      await Promise.all(files.map((filePath) => load(filePath, false)));
      return recordsNow();
    } catch (error) {
      debug(`could not scan ${root}`, error);
      return [];
    }
  }

  async function disable(localWatcher, error) {
    debug('reader disabled', error);
    records.clear();
    state = 'disabled';
    if (localWatcher) await localWatcher.close().catch(() => {});
    if (watcher === localWatcher) watcher = null;
    onUpdate({ phase: 'normal' });
  }

  async function startInternal(localGeneration, signal) {
    let localWatcher = null;
    try {
      await Promise.race([scan(), abortPromise(signal), timeoutPromise(startupTimeoutMs)]);
      if (signal.aborted || generation !== localGeneration || state === 'closing' || state === 'closed') return;
      localWatcher = watchFactory(root, { depth: 0, ignoreInitial: true, persistent: true });
      watcher = localWatcher;
      localWatcher.on('add', load);
      localWatcher.on('change', load);
      localWatcher.on('unlink', (filePath) => {
        if (records.delete(filePath)) onUpdate({ phase: 'normal' });
      });
      localWatcher.on('error', (error) => {
        if (generation === localGeneration && state !== 'closing' && state !== 'closed') {
          void disable(localWatcher, error);
        }
      });
      const ready = new Promise((resolve) => localWatcher.once('ready', resolve));
      await Promise.race([ready, abortPromise(signal), timeoutPromise(startupTimeoutMs)]);
      if (signal.aborted || generation !== localGeneration || state === 'closing' || state === 'closed') {
        await localWatcher.close().catch(() => {});
        if (watcher === localWatcher) watcher = null;
        return;
      }
      // Close the scan-to-watch gap: a sidecar created after the initial
      // directory read but before the watcher became ready may not emit add.
      await Promise.race([scan(), abortPromise(signal), timeoutPromise(startupTimeoutMs)]);
      if (signal.aborted || generation !== localGeneration || state === 'closing' || state === 'closed') {
        await localWatcher.close().catch(() => {});
        if (watcher === localWatcher) watcher = null;
        return;
      }
      state = 'running';
      onUpdate({ phase: recordsNow().some((record) => record.status === 'running') ? 'running' : 'normal' });
    } catch (error) {
      if (state !== 'closing' && state !== 'closed') await disable(localWatcher, error);
      else if (localWatcher) await localWatcher.close().catch(() => {});
    }
  }

  function start() {
    if (startPromise || state === 'running' || state === 'closed') return startPromise ?? Promise.resolve();
    state = 'starting';
    generation += 1;
    controller = new AbortController();
    startPromise = startInternal(generation, controller.signal).finally(() => {
      startPromise = null;
    });
    return startPromise;
  }

  async function close() {
    if (state === 'closed') return;
    state = 'closing';
    generation += 1;
    controller?.abort(new Error('delegation reader closed'));
    const localWatcher = watcher;
    watcher = null;
    if (localWatcher) await localWatcher.close().catch(() => {});
    if (startPromise) {
      await Promise.race([startPromise, timeoutPromise(startupTimeoutMs)]).catch(() => {});
    }
    records.clear();
    state = 'closed';
  }

  return {
    root,
    scan,
    start,
    close,
    getRecords: recordsNow,
    getState: () => state,
  };
}
