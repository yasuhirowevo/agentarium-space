import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import chokidar from 'chokidar';
import { JsonlTail, readLatestJsonlRecord } from '../tail.js';
import { applyCodexExecution } from '../codex-execution.js';
import { applyCodexMetadata } from '../codex-metadata.js';
import { applyCodexWorkflow } from '../codex-workflow.js';
import {
  activeWindowMs,
  addOutputTokens,
  addRecentEvent,
  addToolCall,
  collectActiveSessions,
  createSession,
  isActiveSession,
  isRetainedSession,
  isRunningSession,
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

async function findRecentLogs(root, now, onFile = () => {}) {
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
        onFile(filePath);
        try {
          const info = await stat(filePath);
          if (now - info.mtimeMs <= INITIAL_FILE_WINDOW_MS) found.push(filePath);
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
  if (payload.recipient && payload.recipient !== 'all') return null;
  if (payload.recipient_name && payload.recipient_name !== 'all') return null;
  if (payload.channel && !['commentary', 'final'].includes(payload.channel)) return null;
  const phase = payload.phase ?? payload.channel;
  if (phase === 'commentary') return 'commentary';
  return phase == null || phase === 'final_answer' || phase === 'final' ? 'final' : null;
}

function contentText(content, type) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((entry) => entry?.type === type && typeof entry.text === 'string')
    .map((entry) => entry.text)
    .join('\n');
}

function resetMessages(session) {
  session.codexMessageKeys = new Map();
  session.codexMessageIds = new Set();
  session.codexSuppressedMessage = null;
}

function rememberMessage(session, kind, text, messageId) {
  // Compare the complete text so distinct messages with the same public excerpt
  // remain eligible, without retaining full message bodies in the dedup cache.
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (!session.codexMessageKeys) resetMessages(session);
  const key = `${kind}:${createHash('sha256').update(normalized).digest('hex')}`;
  const identity = typeof messageId === 'string' && messageId ? `${kind}:${messageId}` : null;
  if (identity && session.codexMessageIds.has(identity)) return false;
  const previousId = session.codexMessageKeys.get(key);
  // An ID-less record can be the other representation of an identified message.
  // Once that record has an ID, another ID with the same text is a new utterance.
  const duplicate = session.codexMessageKeys.has(key)
    && (!identity || previousId === null || previousId === identity);
  if (identity) {
    session.codexMessageIds.add(identity);
    if (session.codexMessageIds.size > 128) {
      session.codexMessageIds.delete(session.codexMessageIds.values().next().value);
    }
  }
  session.codexMessageKeys.delete(key);
  session.codexMessageKeys.set(key, identity ?? previousId ?? null);
  if (session.codexMessageKeys.size > 128) {
    session.codexMessageKeys.delete(session.codexMessageKeys.keys().next().value);
  }
  const matchedUnidentified = Boolean(identity && previousId === null);
  return duplicate && !matchedUnidentified ? null : { key, matchedUnidentified };
}

function applyUserMessage(session, text, timestamp, includeEvent, messageId) {
  const message = rememberMessage(session, 'user', text, messageId);
  if (!message || message.matchedUnidentified) return;
  setFirstUserPrompt(session, text);
  if (includeEvent) addRecentEvent(session, timestamp, 'User message');
}

function applyAgentMessage(session, payload, text, time) {
  const kind = agentMessageKind(payload);
  if (!kind || (kind !== 'final' && session.finalMessageSeen)) return;
  if (kind === 'final' && text.trim()) session.finalMessageSeen = true;
  const message = rememberMessage(session, kind, text, payload.id);
  if (message) {
    const suppressed = session.codexSuppressedMessage;
    // An ID arriving after an ID-less record must still identify a new utterance
    // if the legacy same-text rule kept the previous turn's display unchanged.
    if (message.matchedUnidentified && (!suppressed || suppressed.key !== message.key
      || suppressed.lastMessageAt !== session.lastMessageAt || kind !== session.lastMessageKind)) return;
    const messageTime = message.matchedUnidentified ? suppressed.time ?? time : time;
    // Preserve the legacy no-ID behavior across turns, while updating different
    // full messages and explicitly identified utterances with the same excerpt.
    const deduplicate = !payload.id && message.key === session.codexLastAgentMessageKey;
    const updated = setLastMessage(session, text, messageTime, kind, { deduplicate });
    session.codexSuppressedMessage = !updated && deduplicate
      ? { key: message.key, time: messageTime, lastMessageAt: session.lastMessageAt }
      : null;
    session.codexLastAgentMessageKey = message.key;
  }
}

function rememberTurn(session, turnId) {
  if (typeof turnId !== 'string' || !turnId) return;
  session.codexKnownTurnIds ??= new Set();
  session.codexKnownTurnIds.delete(turnId);
  session.codexKnownTurnIds.add(turnId);
  if (session.codexKnownTurnIds.size > 128) {
    session.codexKnownTurnIds.delete(session.codexKnownTurnIds.values().next().value);
  }
}

function applyMessageRecord(session, record, payload, time, includeEvent = true) {
  if (record.type === 'event_msg' && payload.type === 'user_message') {
    applyUserMessage(session, userMessageText(payload), record.timestamp, includeEvent);
  } else if (record.type === 'event_msg' && payload.type === 'agent_message') {
    applyAgentMessage(session, payload, userMessageText(payload), time);
  } else if (record.type === 'event_msg' && payload.type === 'item_completed') {
    const item = payload.item;
    if (item?.type === 'UserMessage') {
      applyUserMessage(session, contentText(item.content, 'text'), record.timestamp, includeEvent, item.id);
    } else if (item?.type === 'AgentMessage') {
      applyAgentMessage(session, item, contentText(item.content, 'Text'), time);
    }
  } else if (record.type === 'response_item' && payload.type === 'message'
    && payload.role === 'assistant') {
    applyAgentMessage(session, payload, contentText(payload.content, 'output_text'), time);
  }
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
  return done ? `${target} returned` : target;
}

function applyTokenMetadata(session, payload) {
  const contextWindow = payload.model_context_window ?? payload.info?.model_context_window;
  if (Number.isFinite(contextWindow) && contextWindow > 0) {
    session.contextWindowTokens = contextWindow;
  }
  if (payload.type !== 'token_count') return;
  const usage = payload.info?.last_token_usage;
  const cumulative = payload.info?.total_token_usage;
  if (Number.isFinite(cumulative?.output_tokens) && cumulative.output_tokens >= 0) {
    const previous = session.codexCumulativeUsage;
    const regressed = previous && ['output_tokens', 'input_tokens', 'total_tokens'].some((key) => (
      Number.isFinite(cumulative[key]) && Number.isFinite(previous[key])
      && cumulative[key] < previous[key]
    ));
    const same = previous && ['output_tokens', 'input_tokens', 'total_tokens'].every((key) => (
      cumulative[key] === previous[key]
    ));
    const newTurn = session.codexUsageTurn !== (session.codexTurnSequence ?? 0);
    if (regressed && !newTurn) return;
    if (!same) {
      addOutputTokens(session, !previous || regressed
        ? cumulative.output_tokens
        : cumulative.output_tokens - previous.output_tokens);
      session.codexCumulativeUsage = { ...cumulative };
      session.codexUsageTurn = session.codexTurnSequence ?? 0;
    }
  } else {
    // Older logs can omit cumulative usage; retain their per-response accounting.
    addOutputTokens(session, usage?.output_tokens);
  }
  if (Number.isFinite(usage?.input_tokens)) {
    session.contextUsedTokens = Math.max(0, usage.input_tokens);
  }
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

function observeUsageTurn(session, turnId) {
  if (typeof turnId === 'string' && turnId) {
    session.codexUsageTurnIds ??= new Set();
    if (session.codexUsageTurnIds.has(turnId)) return;
    session.codexUsageTurnIds.add(turnId);
    if (session.codexUsageTurnIds.size > 128) {
      session.codexUsageTurnIds.delete(session.codexUsageTurnIds.values().next().value);
    }
  }
  session.codexTurnSequence = (session.codexTurnSequence ?? 0) + 1;
}

function applyRichFields(session, record, payload) {
  observeSessionTimestamp(session, record.timestamp ?? payload.timestamp);
  if (record.type === 'session_meta' && typeof payload.originator === 'string') {
    session.originator = payload.originator;
  }
  if (record.type === 'turn_context') {
    if (typeof payload.turn_id === 'string' && payload.turn_id) observeUsageTurn(session, payload.turn_id);
    if (typeof payload.model === 'string') session.model = payload.model;
    if (Object.hasOwn(payload, 'sandbox_policy')) {
      session.writeAccess = writeAccessFor(payload.sandbox_policy);
    }
    if (typeof payload.approval_policy === 'string') session.approvalPolicy = payload.approval_policy;
  }
  if (record.type === 'event_msg') {
    // Usage boundaries apply to historical head metadata as well, without
    // replaying task state or counting the same start/context identity twice.
    if (payload.type === 'task_started') observeUsageTurn(session, payload.turn_id);
    applyTokenMetadata(session, payload);
  }
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
  session.isSubAgent = Boolean(hasSubagentSource);
  session.parentId = typeof spawn?.parent_thread_id === 'string'
    ? spawn.parent_thread_id
    : hasSubagentSource && typeof payload.parent_thread_id === 'string'
      ? payload.parent_thread_id
      : null;
  session.nickname = typeof spawn?.agent_nickname === 'string' ? spawn.agent_nickname : null;
}

function applyRecord(session, record, fileSessionId) {
  if (!record || typeof record !== 'object') return;
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
  if (record.type === 'session_meta' && !acceptsSessionMeta(session, payload, fileSessionId)) return;
  // Reject stale contexts before either metadata or completion is changed.
  if (record.type === 'turn_context' && typeof payload.turn_id === 'string'
    && session.codexDetails?.turn?.id !== payload.turn_id
    && session.codexExecution?.turns.has(payload.turn_id)) return;
  if (record.type === 'turn_context' && typeof payload.turn_id === 'string' && payload.turn_id
    && payload.turn_id !== (session.codexTurnId ?? session.completedTurnId)) {
    if (session.codexKnownTurnIds?.has(payload.turn_id)) return;
    // New context invalidates old completion, but does not end active work.
    session.completedAt = null;
    session.completedTurnId = null;
  }
  const eventTime = record.type === 'event_msg' ? touchSession(session, record.timestamp) : null;
  if (record.type === 'event_msg') {
    // Retirement recovery can know boundaries outside the observed details tail.
    // Apply its acceptance rules before any detail reducer sees a replay.
    if (payload.type === 'task_started') {
      const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : null;
      if (turnId && (session.codexKnownTurnIds?.has(turnId) || turnId === session.completedTurnId)) return;
      if (!turnId && Number.isFinite(session.completedAt) && eventTime <= session.completedAt) return;
    } else if (payload.type === 'task_complete' || payload.type === 'turn_aborted') {
      if (typeof payload.turn_id === 'string' && typeof session.codexTurnId === 'string'
        && payload.turn_id !== session.codexTurnId) return;
    }
  }
  applyRichFields(session, record, payload);
  applyCodexExecution(session, record);
  applyCodexMetadata(session, record);
  applyCodexWorkflow(session, record);

  if (record.type === 'session_meta') {
    applySessionMeta(session, record, payload);
    return;
  }

  if (record.type === 'turn_context') {
    touchSession(session, record.timestamp);
    if (typeof payload.cwd === 'string') session.cwd = normalizeCwd(payload.cwd);
    if (typeof payload.turn_id === 'string') session.codexTurnId = payload.turn_id;
    return true;
  }

  if (record.type === 'event_msg') {
    const time = eventTime;
    if (payload.type === 'task_started') {
      const turnId = typeof payload.turn_id === 'string' ? payload.turn_id : null;
      session.completedAt = null;
      session.completedTurnId = null;
      session.retirementTaskActive = true;
      resetMessages(session);
      rememberTurn(session, turnId);
      session.codexTurnId = turnId;
      session.taskActive = true;
      session.finalMessageSeen = false;
      addRecentEvent(session, record.timestamp, 'Task started');
    } else if (payload.type === 'task_complete' || payload.type === 'turn_aborted') {
      rememberTurn(session, typeof payload.turn_id === 'string' ? payload.turn_id : session.codexTurnId);
      session.taskActive = false;
      session.retirementTaskActive = false;
      if (!Number.isFinite(session.completedAt)) {
        session.completedAt = time;
        session.completedTurnId = payload.turn_id ?? session.codexTurnId ?? null;
      }
      if (payload.type === 'turn_aborted') session.pendingTools.clear();
      addRecentEvent(session, record.timestamp,
        payload.type === 'turn_aborted' ? 'Task aborted' : 'Task complete');
    } else {
      applyMessageRecord(session, record, payload, time);
    }
    return;
  }

  if (record.type !== 'response_item') return;
  const time = touchSession(session, record.timestamp);
  applyMessageRecord(session, record, payload, time);
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

  if (record.type === 'event_msg' || record.type === 'response_item') {
    const time = touchSession(session, record.timestamp);
    // Head records are historical fallbacks, not the active turn. A final there
    // must not suppress commentary from a newer turn in the tail.
    applyMessageRecord(session, record, payload, time, false);
    session.finalMessageSeen = false;
  }
}

function isTaskBoundary(record) {
  return record?.type === 'event_msg'
    && ['task_started', 'task_complete', 'turn_aborted'].includes(record.payload?.type);
}

async function recoverRetirementState(filePath, endOffset, maxBytes) {
  const boundaries = [];
  // The reader walks backward under its existing 8 MiB limit. Collect only
  // lifecycle evidence, then apply the normal acceptance rules in file order.
  await readLatestJsonlRecord(filePath, (record) => {
    if (isTaskBoundary(record) || record?.type === 'turn_context') boundaries.push(record);
    return false;
  }, { endOffset, maxBytes });
  if (boundaries.length === 0) return null;
  const recovered = createSession('', 'codex', '');
  let context = null;
  for (const boundary of boundaries.reverse()) {
    if (applyRecord(recovered, boundary, null) === true) context = boundary;
  }
  return { state: recovered, context };
}

export function createCodexWatcher({
  root = path.join(os.homedir(), '.codex', 'sessions'),
  onUpdate = () => {},
  windowMs = activeWindowMs(),
} = {}) {
  root = path.resolve(root);
  const tail = new JsonlTail();
  const sessions = new Map();
  const fileQueues = new Map();
  const filePathsById = new Map();
  let parentRestoration = Promise.resolve();
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
    const id = rolloutUuid(filePath);
    if (id) filePathsById.set(id, filePath);
    return enqueue(filePath, async () => {
      try {
        const result = await tail.read(filePath);
        const fileSessionId = rolloutUuid(filePath);
        let session = sessions.get(filePath);
        const initial = !session || result.reset;
        if (initial) {
          session = createSession(
            fallbackId(filePath),
            'codex',
            normalizeCwd(path.resolve(filePath)),
          );
          sessions.set(filePath, session);
        }
        for (const record of result.metaRecords) applyMetaRecord(session, record, fileSessionId);
        // The next task_started may be in the skipped middle. Historical head
        // messages must not suppress identical messages from the current tail.
        if (result.metaRecords.length > 0) {
          resetMessages(session);
          session.codexLastAgentMessageKey = null;
        }
        const retirement = initial && result.truncated
          ? await recoverRetirementState(filePath, result.startOffset,
            8 * 1024 * 1024 - (result.endOffset - result.startOffset))
          : null;
        if (retirement) {
          // Seed only acceptance/retirement metadata before the observed tail.
          const recovered = retirement.state;
          session.retirementTaskActive = recovered.retirementTaskActive;
          session.completedAt = recovered.completedAt;
          session.completedTurnId = recovered.completedTurnId;
          session.codexTurnId = recovered.codexTurnId;
          for (const turnId of recovered.codexKnownTurnIds ?? []) rememberTurn(session, turnId);
          // Replaced context-only identities are stale too. The current context
          // may still receive its first observed start, so do not mark it started.
          for (const turnId of recovered.codexExecution?.turns ?? []) {
            if (turnId !== recovered.codexTurnId) rememberTurn(session, turnId);
          }
        }
        if (initial && !result.records.some((record) => record?.type === 'turn_context')) {
          const context = retirement?.context ?? await readLatestJsonlRecord(filePath, (record) => record?.type === 'turn_context', {
            endOffset: result.endOffset,
          });
          // Only turn metadata is recovered. The skipped history must not replay
          // old tools, usage notifications, or task transitions.
          if (context) applyRecord(session, context, fileSessionId);
        }
        for (const record of result.records) applyRecord(session, record, fileSessionId);
        if (result.metaRecords.length > 0 || result.records.length > 0 || result.reset) onUpdate();
      } catch (error) {
        debug(`could not process ${filePath}`, error);
      }
    });
  }

  function restoreAncestors(now = Date.now()) {
    parentRestoration = parentRestoration.catch(() => {}).then(async () => {
      const visited = new Set();
      const pending = [...sessions.values()].filter((session) => isActiveSession(session, now, windowMs)
        && isRunningSession(session));
      while (pending.length > 0) {
        const session = pending.pop();
        if (!session.parentId || visited.has(session.parentId)) continue;
        visited.add(session.parentId);
        let parent = [...sessions.values()].find((candidate) => candidate.id === session.parentId);
        if (!parent) {
          const filePath = filePathsById.get(session.parentId);
          if (filePath) {
            await processFile(filePath);
            parent = sessions.get(filePath);
          }
        }
        if (parent) pending.push(parent);
      }
    });
    return parentRestoration;
  }

  async function scan(now = Date.now()) {
    const files = await findRecentLogs(root, now, (filePath) => {
      const id = rolloutUuid(filePath);
      if (id) filePathsById.set(id, filePath);
    });
    await runWithConcurrency(files, processFile);
    await restoreAncestors(now);
    return getSessions(now);
  }

  function getSessions(now = Date.now()) {
    return collectActiveSessions([sessions], now, windowMs, (filePath) => {
      enqueue(filePath, () => {
        const session = sessions.get(filePath);
        if (session && isRetainedSession(session, [sessions], now, windowMs)) return;
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
    const processChangedFile = async (filePath) => {
      await processFile(filePath);
      await restoreAncestors();
    };
    watcher.on('add', processChangedFile);
    watcher.on('change', processChangedFile);
    watcher.on('unlink', (filePath) => {
      if (!isSessionLog(filePath, root)) return;
      const id = rolloutUuid(filePath);
      if (filePathsById.get(id) === filePath) filePathsById.delete(id);
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

  return { scan, start, close, getSessions, sessions };
}
