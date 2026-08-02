import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import chokidar from 'chokidar';
import {
  activeDelegationStarts,
  codexDelegationCommand,
  delegationLinkIdFromCommand,
  recordDelegationStart,
  recoverDelegationStartsFromFiles,
} from '../delegations.js';
import { JsonlTail } from '../tail.js';
import {
  activeWindowMs,
  addOutputTokens,
  addRecentEvent,
  addToolCall,
  collectActiveSessions,
  createSession,
  isActiveSession,
  normalizeCwd,
  observeSessionTimestamp,
  setFirstUserPrompt,
  setLastMessage,
  touchSession,
} from '../state.js';

const INITIAL_FILE_WINDOW_MS = 24 * 60 * 60 * 1000;

function debug(message, error) {
  if (process.env.AGENTARIUM_DEBUG) console.error(`[codex] ${message}`, error ?? '');
}

function isSessionLog(filePath, root) {
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const parts = relative.split(path.sep);
  return parts.length === 4
    && /^\d{4}$/.test(parts[0])
    && /^\d{2}$/.test(parts[1])
    && /^\d{2}$/.test(parts[2])
    && parts[3].toLowerCase().endsWith('.jsonl');
}

function createIgnoredWatchPath(root) {
  const directoryPatterns = [/^\d{4}$/, /^\d{2}$/, /^\d{2}$/];
  return (filePath, info) => {
    const relative = path.relative(root, filePath);
    if (!relative) return false;
    if (relative.startsWith('..') || path.isAbsolute(relative)) return true;

    const parts = relative.split(path.sep);
    for (let index = 0; index < Math.min(parts.length, directoryPatterns.length); index += 1) {
      if (!directoryPatterns[index].test(parts[index])) return true;
    }
    if (parts.length <= directoryPatterns.length) {
      return info ? !info.isDirectory() : false;
    }
    if (parts.length === directoryPatterns.length + 1) {
      const isJsonl = parts.at(-1).toLowerCase().endsWith('.jsonl');
      return info ? !(info.isFile() && isJsonl) : !isJsonl;
    }
    return true;
  };
}

async function findRecentLogs(root, now, windowMs = INITIAL_FILE_WINDOW_MS) {
  const found = [];

  async function walk(directory, depth) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      debug(`could not list ${directory}`, error);
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 3) {
        await walk(filePath, depth + 1);
      } else if (entry.isFile() && isSessionLog(filePath, root)) {
        try {
          const info = await stat(filePath);
          if (now - info.mtimeMs <= windowMs) found.push(filePath);
        } catch (error) {
          debug(`could not stat ${filePath}`, error);
        }
      }
    }));
  }

  await walk(root, 0);
  return found;
}

async function runWithConcurrency(items, worker, limit = 16) {
  let nextIndex = 0;
  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
  await Promise.all(workers);
}

function fallbackId(filePath) {
  const name = path.basename(filePath, path.extname(filePath));
  const match = name.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i);
  return match?.[1] ?? name;
}

function rolloutUuid(filePath) {
  const name = path.basename(filePath, path.extname(filePath));
  if (!/^rollout-/i.test(name)) return null;
  const match = name.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i);
  return match?.[1] ?? null;
}

function userMessageText(payload) {
  if (typeof payload.message === 'string') return payload.message;
  if (typeof payload.text === 'string') return payload.text;
  return '';
}

function agentMessageKind(payload) {
  return payload.phase === 'commentary' ? 'commentary' : 'final';
}

function reasoningSummaryText(payload) {
  if (!Array.isArray(payload.summary)) return '';
  const item = payload.summary
    .filter((entry) => entry?.type === 'summary_text' && typeof entry.text === 'string')
    .at(-1);
  return item?.text.replaceAll('**', '') ?? '';
}

function shortDetail(value, maximum = 48) {
  const text = Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value.join(' ')
    : value;
  if (typeof text !== 'string') return null;
  const compact = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return compact ? Array.from(compact).slice(0, maximum).join('') : null;
}

function callDetail(argumentsValue, inputValue) {
  let parsed;
  try {
    parsed = typeof argumentsValue === 'string' ? JSON.parse(argumentsValue) : argumentsValue;
  } catch {
    parsed = null;
  }

  const preferredKeys = [
    'command',
    'cmd',
    'path',
    'query',
    'message',
    'prompt',
    'description',
    'url',
    'file_path',
  ];
  const findValue = (value, preferredKey, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 4) return null;
    for (const [key, candidate] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey === preferredKey || normalizedKey.endsWith(`_${preferredKey}`)) {
        const detail = shortDetail(candidate);
        if (detail) return detail;
      }
    }
    for (const candidate of Object.values(value)) {
      const detail = findValue(candidate, preferredKey, depth + 1);
      if (detail) return detail;
    }
    return null;
  };

  if (parsed && typeof parsed === 'object') {
    for (const key of preferredKeys) {
      const detail = findValue(parsed, key);
      if (detail) return detail;
    }
  }

  if (typeof inputValue !== 'string') return null;
  const commandMatch = inputValue.match(/command\s*[:=]\s*"((?:[^"\\]|\\.){1,60})/i);
  if (commandMatch) {
    try {
      return shortDetail(JSON.parse(`"${commandMatch[1]}"`), 60);
    } catch {
      return shortDetail(commandMatch[1], 60);
    }
  }

  const withoutPrefix = inputValue.replace(
    /^\s*(?:(?:const|let|var)\s+[\w$]+\s*=\s*)?(?:await\s+)?tools\.[\w$.]+\s*\(\s*/,
    '',
  );
  return shortDetail(withoutPrefix);
}

function toolEventLabel(tool, done = false) {
  const target = tool.detail ? `${tool.name}: ${tool.detail}` : tool.name;
  return done ? `${target} done` : target;
}

function applyTokenMetadata(session, payload) {
  if (payload.type === 'task_started'
    && Number.isFinite(payload.model_context_window)
    && payload.model_context_window > 0) {
    session.contextWindowTokens = payload.model_context_window;
  }
  if (payload.type !== 'token_count') return;
  const usage = payload.info?.last_token_usage;
  if (!usage || typeof usage !== 'object') return;
  addOutputTokens(session, usage.output_tokens);
  if (!Number.isFinite(usage.input_tokens)) return;
  session.contextUsedTokens = Math.max(0, usage.input_tokens);
}

function writeAccessFor(sandboxPolicy) {
  let value = '';
  if (typeof sandboxPolicy === 'string') value = sandboxPolicy;
  else if (sandboxPolicy && typeof sandboxPolicy === 'object') {
    try {
      value = JSON.stringify(sandboxPolicy);
    } catch {
      return null;
    }
  }
  const normalized = value.toLowerCase();
  if (normalized.includes('write') || normalized.includes('danger-full-access')) return 'write';
  if (normalized.includes('read-only') || normalized.includes('readonly')) return 'read';
  return null;
}

function applyRichFields(session, record, payload) {
  observeSessionTimestamp(session, record.timestamp ?? payload.timestamp);
  if (record.type === 'session_meta' && typeof payload.originator === 'string') {
    session.originator = payload.originator;
  }
  if (record.type === 'turn_context') {
    if (typeof payload.model === 'string') session.model = payload.model;
    if (Object.hasOwn(payload, 'sandbox_policy')) {
      session.writeAccess = writeAccessFor(payload.sandbox_policy);
    }
    if (typeof payload.approval_policy === 'string') session.approvalPolicy = payload.approval_policy;
  }
  if (record.type === 'event_msg') applyTokenMetadata(session, payload);
  if (record.type === 'response_item'
    && (payload.type === 'function_call' || payload.type === 'custom_tool_call')) {
    addToolCall(session, payload.name);
  }
}

function acceptsSessionMeta(session, payload, fileSessionId) {
  if (typeof payload.id !== 'string') return false;
  if (fileSessionId !== null) return payload.id === fileSessionId;
  if (typeof session.acceptedSessionMetaId !== 'string') {
    session.acceptedSessionMetaId = payload.id;
  }
  return payload.id === session.acceptedSessionMetaId;
}

function applySessionMeta(session, record, payload) {
  touchSession(session, record.timestamp ?? payload.timestamp);
  session.id = payload.id;
  if (typeof payload.cwd === 'string') session.cwd = normalizeCwd(payload.cwd);
  const subagent = payload.source?.subagent;
  const hasSubagentSource = subagent && typeof subagent === 'object' && !Array.isArray(subagent);
  const spawn = hasSubagentSource ? subagent.thread_spawn : null;
  session.parentId = typeof spawn?.parent_thread_id === 'string'
    ? spawn.parent_thread_id
    : hasSubagentSource && typeof payload.parent_thread_id === 'string'
      ? payload.parent_thread_id
      : null;
  session.nickname = typeof spawn?.agent_nickname === 'string' ? spawn.agent_nickname : null;
}

function delegationStartFromRecord(session, record, delegationStarts) {
  if (record?.type !== 'response_item') return null;
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
  if (payload.type !== 'function_call' && payload.type !== 'custom_tool_call') return null;
  const command = codexDelegationCommand(payload.arguments, payload.input);
  const linkId = delegationLinkIdFromCommand(command, 'claude');
  const startedAt = Date.parse(record.timestamp);
  if (!linkId || !Number.isFinite(startedAt)) return null;
  recordDelegationStart(delegationStarts, linkId, session.key, 'codex', startedAt);
  return { linkId };
}

function applyRecord(session, record, fileSessionId, delegationStarts) {
  if (!record || typeof record !== 'object') return;
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
  if (record.type === 'session_meta' && !acceptsSessionMeta(session, payload, fileSessionId)) return;
  applyRichFields(session, record, payload);

  if (record.type === 'session_meta') {
    applySessionMeta(session, record, payload);
    return;
  }

  if (record.type === 'turn_context') {
    touchSession(session, record.timestamp);
    if (typeof payload.cwd === 'string') session.cwd = normalizeCwd(payload.cwd);
    return;
  }

  if (record.type === 'event_msg') {
    const time = touchSession(session, record.timestamp);
    if (payload.type === 'task_started') {
      session.taskActive = true;
      session.finalMessageSeen = false;
      addRecentEvent(session, record.timestamp, 'Task started');
    } else if (payload.type === 'task_complete') {
      session.taskActive = false;
      addRecentEvent(session, record.timestamp, 'Task complete');
    } else if (payload.type === 'user_message') {
      setFirstUserPrompt(session, userMessageText(payload));
      addRecentEvent(session, record.timestamp, 'User message');
    } else if (payload.type === 'agent_message') {
      const kind = agentMessageKind(payload);
      const message = userMessageText(payload);
      setLastMessage(session, message, time, kind);
      if (kind === 'final' && message.trim()) session.finalMessageSeen = true;
    }
    return;
  }

  if (record.type !== 'response_item') return;
  const time = touchSession(session, record.timestamp);
  delegationStartFromRecord(session, record, delegationStarts);
  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    const callId = payload.call_id ?? payload.id;
    if (typeof callId !== 'string') return;
    const name = typeof payload.name === 'string' ? payload.name : 'tool';
    const tool = {
      name,
      detail: callDetail(payload.arguments, payload.input),
      startedAt: time ?? session.lastActivity,
    };
    session.pendingTools.set(callId, tool);
    addRecentEvent(session, record.timestamp, toolEventLabel(tool));
  } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
    const callId = payload.call_id ?? payload.id;
    if (typeof callId !== 'string') return;
    const tool = session.pendingTools.get(callId);
    session.pendingTools.delete(callId);
    if (tool) addRecentEvent(session, record.timestamp, toolEventLabel(tool, true));
  } else if (payload.type === 'reasoning' && !session.finalMessageSeen) {
    setLastMessage(session, reasoningSummaryText(payload), time, 'progress');
  }
}

function applyMetaRecord(session, record, fileSessionId) {
  if (!record || typeof record !== 'object') return;
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
  if (record.type === 'session_meta' && !acceptsSessionMeta(session, payload, fileSessionId)) return;
  applyRichFields(session, record, payload);

  if (record.type === 'session_meta') {
    applySessionMeta(session, record, payload);
    return;
  }

  if (record.type === 'turn_context') {
    touchSession(session, record.timestamp);
    if (typeof payload.cwd === 'string') session.cwd = normalizeCwd(payload.cwd);
    return;
  }

  if (record.type === 'event_msg') {
    const time = touchSession(session, record.timestamp);
    if (payload.type === 'user_message') {
      setFirstUserPrompt(session, userMessageText(payload));
    } else if (payload.type === 'agent_message') {
      setLastMessage(session, userMessageText(payload), time, agentMessageKind(payload));
    }
    return;
  }

  if (record.type === 'response_item') touchSession(session, record.timestamp);
}

export function createCodexWatcher({
  root = path.join(os.homedir(), '.codex', 'sessions'),
  onUpdate = () => {},
  windowMs = activeWindowMs(),
} = {}) {
  root = path.resolve(root);
  const tail = new JsonlTail();
  const sessions = new Map();
  const delegationStarts = new Map();
  const fileQueues = new Map();
  let watcher = null;

  function enqueue(filePath, operation) {
    const previous = fileQueues.get(filePath) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(operation)
      .catch((error) => debug(`queued operation failed for ${filePath}`, error))
      .finally(() => {
        if (fileQueues.get(filePath) === current) fileQueues.delete(filePath);
      });
    fileQueues.set(filePath, current);
    return current;
  }

  function processFile(filePath) {
    if (!isSessionLog(filePath, root)) return;
    return enqueue(filePath, async () => {
      try {
        const result = await tail.read(filePath);
        const fileSessionId = rolloutUuid(filePath);
        let session = sessions.get(filePath);
        if (!session || result.reset) {
          session = createSession(
            fallbackId(filePath),
            'codex',
            normalizeCwd(path.resolve(filePath)),
          );
          sessions.set(filePath, session);
        }
        for (const record of result.metaRecords) applyMetaRecord(session, record, fileSessionId);
        for (const record of result.records) applyRecord(session, record, fileSessionId, delegationStarts);
        if (result.metaRecords.length > 0 || result.records.length > 0 || result.reset) onUpdate();
      } catch (error) {
        debug(`could not process ${filePath}`, error);
      }
    });
  }

  async function scan(now = Date.now()) {
    const files = await findRecentLogs(root, now);
    await runWithConcurrency(files, processFile);
    return getSessions(now);
  }

  function parseRecoveryRecord(record, filePath) {
    const fileSessionId = rolloutUuid(filePath);
    const session = sessions.get(filePath) ?? createSession(
      fallbackId(filePath),
      'codex',
      normalizeCwd(path.resolve(filePath)),
    );
    if (record?.type === 'session_meta') {
      const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
      if (acceptsSessionMeta(session, payload, fileSessionId)) session.id = payload.id;
    }
    return delegationStartFromRecord(session, record, delegationStarts);
  }

  async function recoverDelegationStarts(records, now = Date.now()) {
    const relevant = records
      .filter((record) => record.childSource === 'claude')
      .slice(0, 64);
    const known = new Set(activeDelegationStarts(delegationStarts, now).map((start) => start.linkId));
    const unresolved = relevant.filter((record) => !known.has(record.linkId));
    if (unresolved.length === 0) return;
    const earliest = Math.min(...unresolved.map((record) => record.startedAt));
    const files = await findRecentLogs(root, now, Math.max(INITIAL_FILE_WINDOW_MS, now - earliest + 60_000));
    await recoverDelegationStartsFromFiles({
      files,
      linkIds: unresolved.map((record) => record.linkId),
      parseRecord: parseRecoveryRecord,
    });
  }

  function getSessions(now = Date.now()) {
    return collectActiveSessions([sessions], now, windowMs, (filePath) => {
      enqueue(filePath, () => {
        const session = sessions.get(filePath);
        if (session && isActiveSession(session, now, windowMs)) return;
        tail.forget(filePath);
        if (sessions.delete(filePath)) onUpdate();
      });
    });
  }

  async function start() {
    if (watcher) return;
    watcher = chokidar.watch(root, {
      depth: 3,
      ignored: createIgnoredWatchPath(root),
      ignoreInitial: true,
      persistent: true,
    });
    watcher.on('add', processFile);
    watcher.on('change', processFile);
    watcher.on('unlink', (filePath) => {
      if (!isSessionLog(filePath, root)) return;
      enqueue(filePath, () => {
        tail.forget(filePath);
        if (sessions.delete(filePath)) onUpdate();
      });
    });
    watcher.on('error', (error) => debug('watch error', error));
    await new Promise((resolve) => watcher.once('ready', resolve));
    await scan();
  }

  async function close() {
    if (watcher) await watcher.close();
    watcher = null;
  }

  return {
    scan,
    start,
    close,
    getSessions,
    sessions,
    recoverDelegationStarts,
    getDelegationStarts: (now = Date.now()) => activeDelegationStarts(delegationStarts, now),
  };
}
