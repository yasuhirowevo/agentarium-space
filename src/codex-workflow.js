import { timestampMs } from './state.js';

const MAX_IDENTITIES = 256;
const MAX_ASSIGNMENTS = 32;
const PLAN_STATUSES = new Set(['pending', 'in_progress', 'completed']);
const ACTIVITY_KINDS = new Set(['started', 'interacted', 'completed', 'interrupted']);

function identity(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function excerpt(value, maximum) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean ? Array.from(clean).slice(0, maximum).join('') : null;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parse(value) {
  if (typeof value !== 'string') return null;
  try { return JSON.parse(value); } catch { return null; }
}

function boundedSet(map, key, value) {
  map.set(key, value);
  if (map.size > MAX_IDENTITIES) map.delete(map.keys().next().value);
}

function stateFor(session) {
  session.codexDetails ??= {};
  session.codexDetails.plan ??= null;
  session.codexDetails.delegations ??= [];
  session.codexDetails.agentWait ??= null;
  session.codexWorkflow ??= {
    turnId: null, calls: new Map(), identities: new Map(), seen: new Map(), sequence: 0,
    planSequence: -1,
  };
  const state = session.codexWorkflow;
  const turnId = session.codexDetails.turn?.id ?? null;
  if (state.turnId !== turnId) {
    state.turnId = turnId;
    state.calls.clear();
    state.planSequence = -1;
    session.codexDetails.plan = null;
    session.codexDetails.delegations = [];
    session.codexDetails.agentWait = null;
  }
  return state;
}

function targetFor(state, value) {
  const target = identity(value);
  if (!target) return null;
  if (state.identities.has(target)) return { ...state.identities.get(target) };
  return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(target)
    ? { id: target, path: null } : { id: null, path: target };
}

function rememberTarget(state, target, alias) {
  if (target.id) boundedSet(state.identities, target.id, target);
  if (target.path) boundedSet(state.identities, target.path, target);
  if (identity(alias)) boundedSet(state.identities, alias, target);
}

function sameTarget(assignment, target) {
  return Boolean((target.id && assignment.targetId === target.id)
    || (target.path && assignment.targetPath === target.path));
}

function planSteps(args) {
  if (!Array.isArray(args.plan) || args.plan.length > 20) return null;
  const steps = [];
  for (const entry of args.plan) {
    if (!object(entry) || !PLAN_STATUSES.has(entry.status)) return null;
    const step = excerpt(entry.step, 120);
    if (!step) return null;
    steps.push({ step, status: entry.status });
  }
  return steps;
}

function applyCall(session, payload, record, state) {
  const callId = identity(payload.call_id);
  if (!callId || state.calls.has(callId) || state.seen.has(callId)) return;
  const name = payload.name;
  if (!['update_plan', 'spawn_agent', 'followup_task', 'wait_agent', 'wait'].includes(name)) return;
  const args = parse(payload.arguments);
  if (!object(args)) return;
  // The orchestration wait tool uses cell_id; it is not an agent wait.
  if (name === 'wait' && !Array.isArray(args.ids)) return;
  if (name === 'followup_task' && (!identity(args.target) || !excerpt(args.message, 120))) return;
  const values = name === 'wait' ? args.ids : args.targets;
  if ((name === 'wait_agent' || name === 'wait') && values !== undefined
    && (!Array.isArray(values) || values.length > 32 || values.some((value) => !identity(value)))) return;
  const call = {
    id: callId, name,
    args: { target: identity(args.target), task_name: identity(args.task_name),
      message: excerpt(args.message, 120), explanation: excerpt(args.explanation, 160) },
    startedAt: timestampMs(record.timestamp),
    turnId: state.turnId, sequence: state.sequence++, activity: null,
  };
  if (name === 'update_plan') {
    call.steps = planSteps(args);
  }
  boundedSet(state.calls, callId, call);
  if (name === 'wait_agent' || name === 'wait') {
    const targets = Array.isArray(values) ? values.map((value) => targetFor(state, value)) : [];
    call.wait = {
      callId, turnId: state.turnId, startedAt: call.startedAt, targets,
      scope: targets.length ? 'targets' : 'mailbox',
    };
    session.codexDetails.agentWait = call.wait;
  }
}

function assignment(session, state, call, target) {
  const aliases = call.name === 'spawn_agent' ? call.args.task_name : call.args.target;
  rememberTarget(state, target, aliases);
  session.codexDetails.delegations.push({
    callId: call.id, turnId: call.turnId,
    targetId: target.id, targetPath: target.path,
    task: excerpt(call.args.task_name, 120) ?? excerpt(call.args.message, 120),
    assignedAt: call.startedAt,
    lastActivity: call.activity?.kind ?? null,
    lastActivityAt: call.activity?.at ?? null,
  });
  if (session.codexDetails.delegations.length > MAX_ASSIGNMENTS) session.codexDetails.delegations.shift();
}

function applyOutput(session, payload, record, state) {
  const callId = identity(payload.call_id);
  const call = state.calls.get(callId);
  state.calls.delete(callId);
  if (session.codexDetails.agentWait?.callId === callId) {
    session.codexDetails.agentWait = [...state.calls.values()].filter((entry) => entry.wait).at(-1)?.wait ?? null;
  }
  if (!call || call.turnId !== state.turnId) return;
  boundedSet(state.seen, callId, true);
  if (call.name === 'update_plan') {
    if (payload.output !== 'Plan updated' || call.sequence < state.planSequence) return;
    state.planSequence = call.sequence;
    session.codexDetails.plan = call.steps === null ? null : {
      turnId: call.turnId, callId, updatedAt: timestampMs(record.timestamp),
      explanation: excerpt(call.args.explanation, 160), steps: call.steps,
    };
  } else if (call.name === 'spawn_agent') {
    const result = parse(payload.output);
    if (!object(result) || (!identity(result.agent_id) && !identity(result.task_name))) return;
    const known = identity(result.task_name) ? targetFor(state, result.task_name) : null;
    const target = {
      id: call.activity?.target.id ?? identity(result.agent_id) ?? known?.id ?? null,
      path: call.activity?.target.path ?? identity(result.task_name) ?? known?.path ?? null,
    };
    assignment(session, state, call, target);
  } else if (call.name === 'followup_task' && payload.output === '') {
    assignment(session, state, call, call.activity?.target ?? targetFor(state, call.args.target));
  }
}

function applyActivity(session, payload, record, state) {
  const item = payload.item;
  if (item?.type !== 'SubAgentActivity' || !identity(item.id) || !ACTIVITY_KINDS.has(item.kind)) return;
  if (identity(payload.turn_id) && payload.turn_id !== state.turnId) return;
  const target = { id: identity(item.agent_thread_id), path: identity(item.agent_path) };
  if (!target.id && !target.path) return;
  const at = timestampMs(record.timestamp);
  const call = state.calls.get(item.id);
  if (call && ['spawn_agent', 'followup_task'].includes(call.name)) {
    call.activity = { target, kind: item.kind, at };
    rememberTarget(state, target, call.name === 'spawn_agent' ? call.args.task_name : call.args.target);
  } else rememberTarget(state, target);
  for (const entry of session.codexDetails.delegations) {
    if ((!sameTarget(entry, target) && entry.callId !== item.id)
      || (entry.lastActivityAt !== null && at !== null && at < entry.lastActivityAt)) continue;
    if (entry.callId === item.id) {
      // A late lifecycle item can resolve a short alias after its call output.
      // Carry that evidence into every alias used by subsequent calls/waits.
      for (const [alias, known] of state.identities) {
        if ((entry.targetId && known.id === entry.targetId)
          || (entry.targetPath && known.path === entry.targetPath)) {
          state.identities.set(alias, { id: target.id ?? known.id, path: target.path ?? known.path });
        }
      }
      entry.targetPath = target.path ?? entry.targetPath;
    }
    entry.targetId ??= target.id;
    entry.targetPath ??= target.path;
    entry.lastActivity = item.kind;
    entry.lastActivityAt = at;
  }
  for (const waiting of session.codexDetails.agentWait?.targets ?? []) {
    const resolved = targetFor(state, waiting.id ?? waiting.path);
    waiting.id = resolved?.id ?? waiting.id;
    waiting.path = resolved?.path ?? waiting.path;
  }
}

// Called after the execution reducer so accepted turn identity owns this state.
// Only observed tail/append records belong here, never historical head metadata.
export function applyCodexWorkflow(session, record) {
  if (!object(record) || !object(record.payload)) return;
  const state = stateFor(session);
  const status = session.codexDetails.turn?.status;
  if (status === 'completed' || status === 'interrupted') {
    session.codexDetails.agentWait = null;
    state.calls.clear();
    return;
  }
  if (!state.turnId) return;
  const payload = record.payload;
  if (identity(payload.turn_id) && payload.turn_id !== state.turnId) return;
  if (record.type === 'response_item' && payload.type === 'function_call') applyCall(session, payload, record, state);
  else if (record.type === 'response_item' && payload.type === 'function_call_output') applyOutput(session, payload, record, state);
  else if (record.type === 'event_msg' && payload.type === 'item_completed') applyActivity(session, payload, record, state);
}
