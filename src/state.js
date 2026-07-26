import path from 'node:path';

const IDLE_AFTER_MS = 15 * 60 * 1000;
const CLAUDE_STREAMING_MS = 10 * 1000;
const DONE_SUB_AGENT_MS = 60 * 1000;
const DEFAULT_ACTIVE_WINDOW_MS = 60 * 60 * 1000;
const MAX_FUTURE_MS = 60 * 1000;
const MESSAGE_KINDS = new Set(['final', 'commentary', 'progress']);

export function activeWindowMs(env = process.env) {
  const minutes = Number(env.AGENTARIUM_WINDOW_MIN);
  return Number.isFinite(minutes) && minutes > 0
    ? minutes * 60 * 1000
    : DEFAULT_ACTIVE_WINDOW_MS;
}

export function normalizeCwd(cwd) {
  return typeof cwd === 'string' ? cwd.replaceAll('\\', '/') : '';
}

export function projectName(cwd) {
  const normalized = normalizeCwd(cwd).replace(/\/+$/, '');
  return normalized ? path.posix.basename(normalized) : '';
}

export function createSession(id, source, key) {
  return {
    id,
    key,
    source,
    cwd: '',
    customTitle: '',
    aiTitle: '',
    firstUserPrompt: '',
    lastActivity: 0,
    lastSidechainActivity: 0,
    gitBranch: null,
    parentId: null,
    nickname: null,
    pendingTools: new Map(),
    subAgents: new Map(),
    recentEvents: [],
    lastMessage: null,
    lastMessageAt: null,
    lastMessageKind: null,
    contextUsedTokens: null,
    contextWindowTokens: null,
    model: null,
    writeAccess: null,
    approvalPolicy: null,
    originator: null,
    outputTokensTotal: null,
    startedAt: null,
    toolCounts: new Map(),
    toolCallsTotal: 0,
    lastMainKind: null,
    taskActive: false,
    finalMessageSeen: false,
  };
}

export function timestampMs(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function observeSessionTimestamp(session, timestamp) {
  const parsed = timestampMs(timestamp);
  if (parsed === null) return null;

  const time = Math.min(parsed, Date.now() + MAX_FUTURE_MS);
  session.startedAt = Number.isFinite(session.startedAt)
    ? Math.min(session.startedAt, time)
    : time;
  return time;
}

export function touchSession(session, timestamp, isSidechain = false) {
  const time = observeSessionTimestamp(session, timestamp);
  if (time === null) return null;
  const field = isSidechain ? 'lastSidechainActivity' : 'lastActivity';
  session[field] = Math.max(session[field] ?? 0, time);
  return time;
}

export function addOutputTokens(session, value) {
  if (!Number.isFinite(value)) return;
  const tokens = Math.max(0, value);
  session.outputTokensTotal = (Number.isFinite(session.outputTokensTotal)
    ? session.outputTokensTotal
    : 0) + tokens;
}

export function addToolCall(session, name) {
  if (typeof name !== 'string') return;
  const normalized = name.trim();
  if (!normalized) return;
  if (!(session.toolCounts instanceof Map)) session.toolCounts = new Map();
  session.toolCounts.set(normalized, (session.toolCounts.get(normalized) ?? 0) + 1);
  session.toolCallsTotal = (Number.isFinite(session.toolCallsTotal)
    ? session.toolCallsTotal
    : 0) + 1;
}

export function setFirstUserPrompt(session, value) {
  if (session.firstUserPrompt || typeof value !== 'string') return;
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.toLowerCase().startsWith('the following is the ')) return;
  if (compact) session.firstUserPrompt = Array.from(compact).slice(0, 40).join('');
}

export function setSessionTitle(session, field, value) {
  if ((field !== 'customTitle' && field !== 'aiTitle') || typeof value !== 'string') return;
  session[field] = Array.from(value).slice(0, 120).join('');
}

export function setLastMessage(session, value, time, kind = 'final') {
  if (typeof value !== 'string' || !Number.isFinite(time)) return;
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return;
  const message = Array.from(compact).slice(0, 60).join('');
  const messageKind = MESSAGE_KINDS.has(kind) ? kind : 'final';
  if (session.lastMessage === message && session.lastMessageKind === messageKind) return;
  session.lastMessage = message;
  session.lastMessageAt = time;
  session.lastMessageKind = messageKind;
}

export function addRecentEvent(session, timestamp, label) {
  if (!label) return;
  const time = timestampMs(timestamp);
  if (time === null) return;
  const date = new Date(time);
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  session.recentEvents.push(`${clock} ${label}`);
  if (session.recentEvents.length > 10) session.recentEvents.splice(0, session.recentEvents.length - 10);
}

export function sessionStatus(session, now, windowMs = activeWindowMs()) {
  const idleAfterMs = session.pendingTools.size > 0 ? windowMs : IDLE_AFTER_MS;
  if (!session.lastActivity || now - session.lastActivity > idleAfterMs) return 'idle';
  if (session.pendingTools.size > 0) return 'tool';

  if (session.source === 'claude') {
    if (session.lastMainKind === 'assistant_text') {
      return now - session.lastActivity < CLAUDE_STREAMING_MS ? 'thinking' : 'waiting';
    }
    return 'thinking';
  }

  return session.taskActive ? 'thinking' : 'waiting';
}

function currentActivity(session) {
  let latest = null;
  for (const tool of session.pendingTools.values()) {
    if (!latest || tool.startedAt >= latest.startedAt) latest = tool;
  }
  return latest;
}

function titleFor(session) {
  const autoReviewTitle = session.model === 'codex-auto-review'
    ? `auto-review·${session.id.slice(-4)}`
    : null;
  return session.customTitle
    || session.aiTitle
    || session.firstUserPrompt
    || session.nickname
    || autoReviewTitle
    || session.id.slice(0, 8);
}

export function removeFinishedSubAgents(session, now) {
  for (const [id, subAgent] of session.subAgents) {
    if (subAgent.status === 'done' && now - subAgent.doneAt >= DONE_SUB_AGENT_MS) {
      session.subAgents.delete(id);
    }
  }
}

export function toPublicSession(session, now, windowMs = activeWindowMs()) {
  removeFinishedSubAgents(session, now);
  const activity = currentActivity(session);
  const toolCounts = session.toolCounts instanceof Map
    ? [...session.toolCounts.entries()]
      .filter(([name, count]) => typeof name === 'string' && Number.isFinite(count) && count > 0)
      .sort(([leftName, leftCount], [rightName, rightCount]) => (
        rightCount - leftCount || (leftName === rightName ? 0 : leftName < rightName ? -1 : 1)
      ))
      .slice(0, 3)
      .map(([name, count]) => ({ name, count }))
    : [];
  return {
    id: session.id,
    key: session.key,
    source: session.source,
    cwd: normalizeCwd(session.cwd),
    projectName: projectName(session.cwd),
    title: titleFor(session),
    status: sessionStatus(session, now, windowMs),
    activity: activity?.name ?? null,
    activityDetail: activity?.detail ?? null,
    lastMessage: session.lastMessage,
    lastMessageAt: session.lastMessageAt,
    lastMessageKind: MESSAGE_KINDS.has(session.lastMessageKind)
      ? session.lastMessageKind
      : session.lastMessage
        ? 'final'
        : null,
    contextUsedTokens: Number.isFinite(session.contextUsedTokens) ? session.contextUsedTokens : null,
    contextWindowTokens: Number.isFinite(session.contextWindowTokens) ? session.contextWindowTokens : null,
    model: typeof session.model === 'string' ? session.model : null,
    writeAccess: session.writeAccess === 'write' || session.writeAccess === 'read'
      ? session.writeAccess
      : null,
    approvalPolicy: typeof session.approvalPolicy === 'string' ? session.approvalPolicy : null,
    originator: typeof session.originator === 'string' ? session.originator : null,
    outputTokensTotal: Number.isFinite(session.outputTokensTotal)
      ? Math.max(0, session.outputTokensTotal)
      : null,
    startedAt: Number.isFinite(session.startedAt) ? session.startedAt : null,
    toolCounts,
    toolCallsTotal: Number.isFinite(session.toolCallsTotal)
      ? Math.max(0, session.toolCallsTotal)
      : 0,
    lastActivity: session.lastActivity,
    gitBranch: session.gitBranch,
    parentId: session.parentId,
    nickname: typeof session.nickname === 'string' ? session.nickname : null,
    subAgents: Array.from(session.subAgents.values(), ({ id, label, status, startedAt }) => ({
      id,
      label,
      status,
      startedAt,
    })),
    recentEvents: session.recentEvents.slice(-10),
  };
}

export function isActiveSession(session, now, windowMs = activeWindowMs()) {
  const latestActivity = Math.max(session.lastActivity, session.lastSidechainActivity ?? 0);
  return Boolean(latestActivity) && now - latestActivity <= windowMs;
}

export function collectActiveSessions(
  sessionMaps,
  now,
  windowMs = activeWindowMs(),
  onEvict = (key, _session, sessionMap) => sessionMap.delete(key),
) {
  const sessions = [];
  for (const sessionMap of sessionMaps) {
    for (const [key, session] of sessionMap) {
      if (!isActiveSession(session, now, windowMs)) {
        onEvict(key, session, sessionMap);
        continue;
      }
      sessions.push(toPublicSession(session, now, windowMs));
    }
  }
  return sessions.sort((left, right) => right.lastActivity - left.lastActivity);
}
