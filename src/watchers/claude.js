import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import chokidar from 'chokidar';
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
  setSessionTitle,
  touchSession,
} from '../state.js';

const INITIAL_FILE_WINDOW_MS = 24 * 60 * 60 * 1000;
// Claude Code logs do not expose the model window, so this default is an approximation.
const CLAUDE_CONTEXT_WINDOW = 200000;

function debug(message, error) {
  if (process.env.AGENTARIUM_DEBUG) console.error(`[claude] ${message}`, error ?? '');
}

function isDirectSessionLog(filePath, root) {
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
  const parts = relative.split(path.sep);
  return parts.length === 2 && parts[1].toLowerCase().endsWith('.jsonl');
}

function createIgnoredWatchPath(root) {
  return (filePath, info) => {
    const relative = path.relative(root, filePath);
    if (!relative) return false;
    if (relative.startsWith('..') || path.isAbsolute(relative)) return true;

    const parts = relative.split(path.sep);
    if (parts.length === 1) return info ? !info.isDirectory() : false;
    if (parts.length === 2) {
      const isJsonl = parts[1].toLowerCase().endsWith('.jsonl');
      return info ? !(info.isFile() && isJsonl) : !isJsonl;
    }
    return true;
  };
}

async function findRecentLogs(root, now) {
  const found = [];
  try {
    const projects = await readdir(root, { withFileTypes: true });
    await Promise.all(projects.filter((entry) => entry.isDirectory()).map(async (project) => {
      const projectDir = path.join(root, project.name);
      let entries;
      try {
        entries = await readdir(projectDir, { withFileTypes: true });
      } catch (error) {
        debug(`could not list ${projectDir}`, error);
        return;
      }
      await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')).map(async (entry) => {
        const filePath = path.join(projectDir, entry.name);
        try {
          const info = await stat(filePath);
          if (now - info.mtimeMs <= INITIAL_FILE_WINDOW_MS) found.push(filePath);
        } catch (error) {
          debug(`could not stat ${filePath}`, error);
        }
      }));
    }));
  } catch (error) {
    debug(`could not list ${root}`, error);
  }
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

function messageContent(record) {
  const content = record?.message?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

function assistantMessageKind(record) {
  return record?.message?.stop_reason === 'tool_use' ? 'commentary' : 'final';
}

function applyCommonFields(session, record) {
  if (typeof record.sessionId === 'string') session.id = record.sessionId;
  if (typeof record.cwd === 'string') session.cwd = normalizeCwd(record.cwd);
  if (typeof record.gitBranch === 'string') session.gitBranch = record.gitBranch;
}

function applyTokenUsage(session, record) {
  if (record.type !== 'assistant') return;
  const usage = record.message?.usage;
  if (!usage || typeof usage !== 'object') return;
  addOutputTokens(session, usage.output_tokens);
  const values = [
    usage.input_tokens,
    usage.cache_creation_input_tokens,
    usage.cache_read_input_tokens,
  ];
  if (!values.some((value) => Number.isFinite(value))) return;
  session.contextUsedTokens = values.reduce(
    (total, value) => total + (Number.isFinite(value) ? Math.max(0, value) : 0),
    0,
  );
  session.contextWindowTokens = CLAUDE_CONTEXT_WINDOW;
}

function applyRichFields(session, record) {
  observeSessionTimestamp(session, record.timestamp);
  if (typeof record.version === 'string') session.originator = record.version;
  if (record.type !== 'assistant') return;
  // sidechain (sub-agent) は別コンテキストなので、main の CTX / model を汚染しない
  // （OUT トークン・ツール数は「セッション総量」として sidechain 分も算入する）
  if (record.isSidechain !== true) {
    if (typeof record.message?.model === 'string') session.model = record.message.model;
    applyTokenUsage(session, record);
  }
  for (const item of messageContent(record)) {
    if (item?.type === 'tool_use') addToolCall(session, item.name);
  }
}

function shortDetail(value, maximum = 48) {
  if (typeof value !== 'string') return null;
  const compact = value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return compact ? Array.from(compact).slice(0, maximum).join('') : null;
}

function toolDetail(name, input) {
  if (!input || typeof input !== 'object') return null;
  const normalizedName = name.toLowerCase();
  if (normalizedName === 'bash') {
    const firstLine = typeof input.command === 'string' ? input.command.split(/\r?\n/, 1)[0] : null;
    return shortDetail(firstLine, 40);
  }
  if (['read', 'edit', 'write', 'notebookedit'].includes(normalizedName)) {
    if (typeof input.file_path !== 'string') return null;
    return shortDetail(path.posix.basename(input.file_path.replaceAll('\\', '/')));
  }
  if (normalizedName === 'grep' || normalizedName === 'glob') {
    const pattern = shortDetail(input.pattern, 46);
    return pattern ? `"${pattern}"` : null;
  }
  if (normalizedName === 'webfetch') {
    if (typeof input.url !== 'string') return null;
    try {
      return shortDetail(new URL(input.url).hostname);
    } catch {
      return null;
    }
  }
  if (normalizedName === 'websearch') return shortDetail(input.query);
  if (normalizedName === 'agent' || normalizedName === 'task') return shortDetail(input.description);
  return null;
}

function toolEventLabel(tool, done = false) {
  const target = tool.detail ? `${tool.name}: ${tool.detail}` : tool.name;
  return done ? `${target} done` : target;
}

function applyRecord(session, record) {
  if (!record || typeof record !== 'object') return;
  applyRichFields(session, record);
  const isSidechain = record.isSidechain === true;
  if (isSidechain) {
    touchSession(session, record.timestamp, true);
    return;
  }

  applyCommonFields(session, record);
  if (record.type === 'custom-title' && typeof record.customTitle === 'string') {
    setSessionTitle(session, 'customTitle', record.customTitle);
    return;
  }
  if (record.type === 'ai-title' && typeof record.aiTitle === 'string') {
    setSessionTitle(session, 'aiTitle', record.aiTitle);
    return;
  }
  if (record.type !== 'user' && record.type !== 'assistant') return;

  const time = touchSession(session, record.timestamp);
  const content = messageContent(record);

  if (record.type === 'user') {
    const toolResults = content.filter((item) => item?.type === 'tool_result');
    for (const result of toolResults) {
      const tool = session.pendingTools.get(result.tool_use_id);
      session.pendingTools.delete(result.tool_use_id);
      const subAgent = session.subAgents.get(result.tool_use_id);
      if (subAgent) {
        subAgent.status = 'done';
        subAgent.doneAt = time ?? session.lastActivity;
      }
      if (tool) addRecentEvent(session, record.timestamp, toolEventLabel(tool, true));
    }

    if (toolResults.length === 0) {
      const text = content.find((item) => item?.type === 'text')?.text;
      setFirstUserPrompt(session, text);
      addRecentEvent(session, record.timestamp, 'User message');
      session.lastMainKind = 'user';
    } else {
      session.lastMainKind = 'tool_result';
    }
    return;
  }

  const toolUses = content.filter((item) => item?.type === 'tool_use' && typeof item.id === 'string');
  for (const toolUse of toolUses) {
    const name = typeof toolUse.name === 'string' ? toolUse.name : 'tool';
    const input = toolUse.input && typeof toolUse.input === 'object' ? toolUse.input : {};
    const detail = toolDetail(name, input);
    const startedAt = time ?? session.lastActivity;
    const tool = { name, detail, startedAt };
    session.pendingTools.set(toolUse.id, tool);
    addRecentEvent(session, record.timestamp, toolEventLabel(tool));

    if (name === 'Agent' || name === 'Task') {
      session.subAgents.set(toolUse.id, {
        id: toolUse.id,
        label: input.description || input.subagent_type || name,
        status: 'running',
        startedAt,
      });
    }
  }

  const assistantText = content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join(' ');
  const messageKind = assistantMessageKind(record);
  setLastMessage(session, assistantText, time, messageKind);

  const isTextOnly = content.length > 0 && content.every((item) => item?.type === 'text');
  session.lastMainKind = isTextOnly && messageKind === 'final'
    ? 'assistant_text'
    : 'assistant_other';
}

function applyMetaRecord(session, record) {
  if (!record || typeof record !== 'object') return;
  applyRichFields(session, record);
  if (record.isSidechain === true) {
    touchSession(session, record.timestamp, true);
    return;
  }

  applyCommonFields(session, record);
  if (record.type === 'custom-title' && typeof record.customTitle === 'string') {
    setSessionTitle(session, 'customTitle', record.customTitle);
    return;
  }
  if (record.type === 'ai-title' && typeof record.aiTitle === 'string') {
    setSessionTitle(session, 'aiTitle', record.aiTitle);
    return;
  }
  if (record.type !== 'user' && record.type !== 'assistant') return;

  const time = touchSession(session, record.timestamp);
  const content = messageContent(record);
  if (record.type === 'assistant') {
    const assistantText = content
      .filter((item) => item?.type === 'text' && typeof item.text === 'string')
      .map((item) => item.text)
      .join(' ');
    setLastMessage(session, assistantText, time, assistantMessageKind(record));
    return;
  }
  if (!content.some((item) => item?.type === 'tool_result')) {
    setFirstUserPrompt(session, content.find((item) => item?.type === 'text')?.text);
  }
}

export function createClaudeWatcher({
  root = path.join(os.homedir(), '.claude', 'projects'),
  onUpdate = () => {},
  windowMs = activeWindowMs(),
} = {}) {
  root = path.resolve(root);
  const tail = new JsonlTail();
  const sessions = new Map();
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
    if (!isDirectSessionLog(filePath, root)) return;
    return enqueue(filePath, async () => {
      try {
        const result = await tail.read(filePath);
        let session = sessions.get(filePath);
        if (!session || result.reset) {
          session = createSession(
            path.basename(filePath, path.extname(filePath)),
            'claude',
            normalizeCwd(path.resolve(filePath)),
          );
          sessions.set(filePath, session);
        }
        for (const record of result.metaRecords) applyMetaRecord(session, record);
        for (const record of result.records) applyRecord(session, record);
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
      depth: 1,
      ignored: createIgnoredWatchPath(root),
      ignoreInitial: true,
      persistent: true,
    });
    watcher.on('add', processFile);
    watcher.on('change', processFile);
    watcher.on('unlink', (filePath) => {
      if (!isDirectSessionLog(filePath, root)) return;
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
