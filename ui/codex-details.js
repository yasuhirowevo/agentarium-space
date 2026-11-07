const UNKNOWN = 'Unknown';
const STALE_AFTER_MS = 15 * 60 * 1000;

function text(value, limit = 240) {
  if (typeof value !== 'string' || !value.trim()) return UNKNOWN;
  const clean = value.trim().replace(/\s+/g, ' ');
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function timestamp(value) {
  return Number.isFinite(value) && value >= 0 && value <= 8.64e15 ? value : null;
}

function nonnegative(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function choice(labels, value, fallback = UNKNOWN) {
  return typeof value === 'string' && Object.hasOwn(labels, value) ? labels[value] : fallback;
}

export function executionDuration(value) {
  if (nonnegative(value) === null) return UNKNOWN;
  if (value < 60_000) return `${Number((value / 1000).toFixed(2))}s`;
  const seconds = Math.floor(value / 1000);
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m ${seconds % 60}s`;
}

export function turnReadout(turn, now = Date.now()) {
  const labels = {
    active: 'Current turn', completed: 'Completed turn', interrupted: 'Interrupted turn',
  };
  const label = choice(labels, turn?.status, 'Turn unknown');
  const startedAt = timestamp(turn?.startedAt);
  const completedAt = timestamp(turn?.completedAt);
  let duration = null;
  if (turn?.status === 'active' && startedAt !== null && now >= startedAt) {
    duration = Math.floor((now - startedAt) / 1000) * 1000;
  } else if (turn?.status === 'completed' || turn?.status === 'interrupted') {
    duration = nonnegative(turn.durationMs);
    if (duration === null && startedAt !== null && completedAt !== null && completedAt >= startedAt) {
      duration = completedAt - startedAt;
    }
  }
  return { label, duration: executionDuration(duration) };
}

function dateLabel(value) {
  return timestamp(value) === null ? UNKNOWN : new Date(value).toLocaleString('en-US');
}

function windowLabel(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'window unknown';
  if (minutes % 1440 === 0) return `${minutes / 1440}d window`;
  if (minutes % 60 === 0) return `${minutes / 60}h window`;
  return `${minutes}m window`;
}

export function allowanceReadouts(allowances, now = Date.now()) {
  if (!Array.isArray(allowances)) return [];
  return allowances.filter((entry) => entry && typeof entry === 'object').slice(0, 8).map((entry) => {
    const observedAt = timestamp(entry.observedAt);
    const windows = Array.isArray(entry.windows) ? entry.windows : [];
    return {
      limit: text(entry.limitId, 80),
      observed: `Observed ${dateLabel(observedAt)}`,
      windows: windows.filter((window) => window && typeof window === 'object').slice(0, 2).map((window) => {
        const resetsAt = timestamp(window.resetsAt);
        const stale = (observedAt !== null && now - observedAt >= STALE_AFTER_MS)
          || (resetsAt !== null && now >= resetsAt);
        const percent = window.remainingPercent;
        const remaining = Number.isFinite(percent) && percent >= 0 && percent <= 100
          ? `${Number(percent.toFixed(1))}% remaining` : 'Remaining unknown';
        return {
          label: `${text(window.name, 32)} · ${windowLabel(window.windowMinutes)}`,
          value: `${remaining}${stale ? ' · stale snapshot' : ''}`,
          reset: `Reset ${dateLabel(resetsAt)}`,
          stale,
        };
      }),
    };
  });
}

function targetLabel(targetId, targetPath, sessions) {
  const child = typeof targetId === 'string' && targetId
    ? sessions.find((session) => session.source === 'codex' && session.id === targetId) : null;
  return child ? text(child.title, 120) : text(targetPath || targetId, 120);
}

export function assignmentLabel(session, sessions) {
  if (session?.source !== 'codex' || typeof session.id !== 'string' || !session.id) return null;
  const assignments = sessions.filter((parent) => parent.source === 'codex')
    .flatMap((parent) => Array.isArray(parent.codexDetails?.delegations) ? parent.codexDetails.delegations : [])
    .filter((assignment) => assignment?.targetId === session.id)
    .sort((left, right) => (timestamp(left.assignedAt) ?? -1) - (timestamp(right.assignedAt) ?? -1));
  const latest = assignments.at(-1);
  return latest ? `Assigned · ${text(latest.task, 120)}` : null;
}

export function codexDetailReadout(details, now = Date.now(), sessions = []) {
  const turn = turnReadout(details?.turn, now);
  const commands = Array.isArray(details?.commands) ? details.commands : [];
  const command = commands.filter((entry) => entry && typeof entry === 'object').at(-1);
  const outcomes = { success: 'Success', failed: 'Failed', unknown: UNKNOWN };
  const changes = Array.isArray(details?.fileChanges) ? details.fileChanges : null;
  const files = (changes || []).filter((entry) => entry && typeof entry.path === 'string').slice(0, 100);
  const kinds = { add: 'Added', update: 'Updated', delete: 'Deleted', move: 'Moved' };
  const compaction = details?.compaction;
  const count = Number.isInteger(compaction?.observedCount) && compaction.observedCount >= 0
    ? compaction.observedCount : null;
  const plan = details?.plan;
  const planStatuses = { pending: 'Pending', in_progress: 'In progress', completed: 'Completed' };
  const planSteps = Array.isArray(plan?.steps) ? plan.steps : [];
  const delegations = Array.isArray(details?.delegations) ? details.delegations : [];
  const wait = details?.agentWait;
  const waitTargets = Array.isArray(wait?.targets) ? wait.targets : [];
  return {
    turn,
    effort: text(details?.effort, 32),
    command: command ? {
      label: text(command.label, 120),
      result: `${choice(outcomes, command.outcome)} · exit ${Number.isInteger(command.exitCode) ? command.exitCode : 'unknown'} · ${nonnegative(command.durationMs) === null ? 'duration unknown' : executionDuration(command.durationMs)}`,
      failed: command.outcome === 'failed',
    } : null,
    edits: {
      label: `${turn.label} · observed edits`,
      count: changes ? `${files.length}${details?.filesTruncated || changes.length > 100 ? '+' : ''} observed` : UNKNOWN,
      files: files.map((file) => `${choice(kinds, file.kind)} · ${file.kind === 'move' ? `${text(file.from)} → ` : ''}${text(file.path)}`),
    },
    compaction: count === null ? UNKNOWN : `${count} observed · latest ${dateLabel(compaction.lastAt)}`,
    allowances: allowanceReadouts(details?.allowances, now),
    plan: plan ? {
      explanation: typeof plan.explanation === 'string' && plan.explanation.trim() ? text(plan.explanation, 160) : null,
      steps: planSteps.filter((step) => step && typeof step === 'object').slice(0, 20)
        .map((step) => `${choice(planStatuses, step.status)} · ${text(step.step, 120)}`),
    } : null,
    delegations: delegations.filter((entry) => entry && typeof entry === 'object').slice(0, 32).map((entry) => ({
      target: targetLabel(entry.targetId, entry.targetPath, sessions),
      task: text(entry.task, 120),
      activity: `Last child activity · ${text(entry.lastActivity, 32)} · ${dateLabel(entry.lastActivityAt)}`,
    })),
    wait: wait?.scope === 'mailbox' ? 'Waiting for agent mailbox'
      : wait?.scope === 'targets'
        ? `Waiting for agents · ${waitTargets.filter((target) => target && typeof target === 'object').slice(0, 32).map((target) => targetLabel(target.id, target.path, sessions)).join(', ') || UNKNOWN}`
        : null,
  };
}
