import { executionDuration, turnReadout } from './codex-details.js';
import { contextLabel } from './context-metrics.js';

export const SPOTLIGHT_CALLOUT_LIMIT = 4;
const MESSAGE_KINDS = new Set(['progress', 'commentary', 'final']);

export function normalizeMessageKind(value) {
  return MESSAGE_KINDS.has(value) ? value : 'final';
}

export function persistentCalloutFor(session) {
  const message = compactText(session?.lastMessageText, 320) ?? compactText(session?.lastMessage, 320);
  if (message) return { message, messageAt: timestamp(session.lastMessageAt) ?? 0, hasMessage: true };
  const activity = compactText(session?.activity);
  if (session?.status !== 'tool' || !activity) return null;
  const detail = compactText(session.activityDetail);
  return {
    message: detail ? `${activity}: ${detail}` : activity,
    messageAt: timestamp(session.lastActivity) ?? 0,
    hasMessage: false,
  };
}

function compactText(value, limit = 160) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const characters = Array.from(clean);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join('')}…` : clean;
}

function timestamp(value) {
  return Number.isFinite(value) && value >= 0 && value <= 8.64e15 ? value : null;
}

function workCallout(text, at) {
  return { text: compactText(text), at: timestamp(at) ?? 0 };
}

function waitTargetLabel(target, sessions) {
  if (!target) return null;
  const id = compactText(target.id);
  const child = id ? sessions.find((entry) => entry?.source === 'codex' && entry.id === target.id) : null;
  return compactText(child?.title) ?? compactText(target.path) ?? id;
}

export function isChildSession(session) {
  return Boolean(session && (session.parentId || session.isSubAgent === true
    || session.model === 'codex-auto-review'));
}

export function isMainCalloutSession(session) {
  return Boolean(session && !isChildSession(session));
}

function callout(kind, title, paragraphs) {
  const content = paragraphs.map((value) => compactText(value)).filter(Boolean).slice(0, 3);
  return content.length ? { kind, title, paragraphs: content } : null;
}

export function mainCalloutsFor(session, sessions, now = Date.now()) {
  if (!isMainCalloutSession(session)) return [];
  const allSessions = Array.isArray(sessions) ? sessions : [];
  const details = session.source === 'codex' ? session.codexDetails : null;
  const turn = details?.turn;
  const turnId = compactText(turn?.id);
  const active = session.status === 'thinking' || session.status === 'tool';
  const activeTurn = active && turn?.status === 'active' && turnId;
  const work = [];
  if (['active', 'completed', 'interrupted'].includes(turn?.status)) {
    const readout = turnReadout(turn, now);
    work.push(readout.duration === 'Unknown' ? readout.label : `${readout.label} · ${readout.duration}`);
  }
  const activity = session.status === 'tool' ? compactText(session.activity) : null;
  const detail = compactText(session.activityDetail);
  const current = activity ? [detail ? `${activity}: ${detail}` : activity] : [];
  const wait = details?.agentWait;
  if (activeTurn && wait?.turnId === turn.id) {
    if (wait.scope === 'mailbox') current.push('Waiting · agent mailbox');
    else if (wait.scope === 'targets' && Array.isArray(wait.targets)) {
      const targets = wait.targets.map((target) => waitTargetLabel(target, allSessions)).filter(Boolean);
      if (targets.length) current.push(`Waiting · ${targets.join(', ')}`);
    }
  }
  if (current.length) work.push(current.join(' · '));
  const plan = details?.plan;
  if (activeTurn && plan?.turnId === turn.id && Array.isArray(plan.steps)) {
    const steps = plan.steps.filter((step) => compactText(step?.step)
      && ['pending', 'in_progress', 'completed'].includes(step.status));
    if (steps.length) {
      const completed = steps.filter((step) => step.status === 'completed').length;
      const currentStep = compactText(steps.find((step) => step.status === 'in_progress')?.step, 120);
      work.push(`Plan ${completed}/${steps.length} completed${currentStep ? ` · ${currentStep}` : ''}`);
    }
  }

  const result = [];
  if (turnId) {
    const commands = Array.isArray(details?.commands) ? details.commands : [];
    const command = commands.filter((entry) => entry?.turnId === turn.id && compactText(entry.label)
      && (timestamp(entry.completedAt) === null || entry.completedAt <= now))
      .sort((left, right) => (timestamp(left.completedAt) ?? -1) - (timestamp(right.completedAt) ?? -1)).at(-1);
    if (command) {
      const outcome = command.outcome === 'success' ? 'Success' : command.outcome === 'failed' ? 'Failed' : null;
      const exit = Number.isInteger(command.exitCode) ? `exit ${command.exitCode}` : null;
      const duration = Number.isFinite(command.durationMs) && command.durationMs >= 0
        ? executionDuration(command.durationMs) : null;
      const summary = [outcome, exit, duration].filter(Boolean).join(' · ');
      if (summary) result.push(summary);
      result.push(`Command · ${compactText(command.label, 120)}`);
    }
    const files = Array.isArray(details.fileChanges)
      ? details.fileChanges.filter((file) => compactText(file?.path)).slice(0, 100) : [];
    if (files.length) {
      const extra = details.filesTruncated || details.fileChanges.length > 100 ? '+' : '';
      result.push(`${files.length}${extra} observed ${files.length === 1 && !extra ? 'edit' : 'edits'} · ${compactText(files.at(-1).path, 120)}`);
    }
  }

  const context = [];
  const model = compactText(session.model, 80);
  const effort = compactText(details?.effort, 32);
  const startedAt = timestamp(session.startedAt);
  const uptime = startedAt !== null && timestamp(now) !== null && now >= startedAt
    ? `Session ${executionDuration(Math.floor((now - startedAt) / 1000) * 1000)}` : null;
  const settings = [model, effort ? `Effort ${effort}` : null, uptime].filter(Boolean);
  if (settings.length) context.push(settings.join(' · '));
  const usage = contextLabel(session);
  const output = Number.isFinite(session.outputTokensTotal) && session.outputTokensTotal >= 0
    ? `OUT ${session.outputTokensTotal >= 1000 ? `${Math.round(session.outputTokensTotal / 1000)}k` : Math.round(session.outputTokensTotal)} tokens` : null;
  const metrics = [usage ? `${usage}${usage.endsWith('%') ? '' : ' tokens'}` : null, output].filter(Boolean);
  if (metrics.length) context.push(metrics.join(' · '));
  const branch = compactText(session.gitBranch, 120);
  if (branch) context.push(`Branch · ${branch}`);

  return [callout('work', 'Work', work), callout('result', 'Result', result),
    callout('context', 'Session', context)].filter(Boolean);
}

// A compact, observed piece of work accompanies the speech, rather than copying
// the detail rail or inferring progress from a generic session status.
export function workCalloutFor(session, sessions, now = Date.now()) {
  if (session?.source !== 'codex') return null;
  const allSessions = Array.isArray(sessions) ? sessions : [];
  const details = session.codexDetails;
  const turnId = compactText(details?.turn?.id);
  const active = session.status === 'thinking' || session.status === 'tool';
  const activeTurn = active && details?.turn?.status === 'active' && turnId;
  const wait = details?.agentWait;
  if (activeTurn && wait?.turnId === details.turn.id) {
    if (wait.scope === 'mailbox') return workCallout('Waiting · agent mailbox', wait.startedAt);
    if (wait.scope === 'targets' && Array.isArray(wait.targets)) {
      const targets = wait.targets.map((target) => waitTargetLabel(target, allSessions)).filter(Boolean);
      if (targets.length) return workCallout(`Waiting · ${targets.join(', ')}`, wait.startedAt);
    }
  }

  const plan = details?.plan;
  if (activeTurn && plan?.turnId === details.turn.id && Array.isArray(plan.steps)) {
    const step = plan.steps.find((entry) => entry?.status === 'in_progress' && compactText(entry.step));
    if (step) return workCallout(`Plan · ${compactText(step.step)}`, plan.updatedAt);
  }

  if (active && compactText(session.id)) {
    let latest = null;
    for (const parent of allSessions) {
      if (parent?.source !== 'codex' || !Array.isArray(parent.codexDetails?.delegations)) continue;
      for (const assignment of parent.codexDetails.delegations) {
        if (assignment?.targetId !== session.id) continue;
        if (!latest || (timestamp(assignment.assignedAt) ?? -1) >= (timestamp(latest.assignedAt) ?? -1)) {
          latest = assignment;
        }
      }
    }
    const task = compactText(latest?.task);
    if (task) return workCallout(`Assigned · ${task}`, latest.assignedAt);
  }

  if (!turnId || timestamp(now) === null || !Array.isArray(details?.commands)) return null;
  const recent = details.commands.filter((command) => {
    const at = timestamp(command?.completedAt);
    return command?.turnId === details.turn.id && at !== null && now >= at && now - at <= 45_000
      && (command.outcome === 'success' || command.outcome === 'failed') && compactText(command.label);
  }).sort((left, right) => left.completedAt - right.completedAt).at(-1);
  if (!recent) return null;
  const result = recent.outcome === 'success' ? 'Success' : 'Failed';
  const exit = Number.isInteger(recent.exitCode) ? ` · exit ${recent.exitCode}` : '';
  return workCallout(`${result}${exit} · ${compactText(recent.label, 120)}`, recent.completedAt);
}
