export const SPOTLIGHT_CALLOUT_LIMIT = 2;
export const SPOTLIGHT_BOOTSTRAP_MAX_AGE_MS = 20_000;

const MAX_FUTURE_SKEW_MS = 60_000;
const SPOTLIGHT_DURATIONS = {
  progress: 10,
  commentary: 18,
  final: 45,
};

export function normalizeMessageKind(value) {
  return Object.hasOwn(SPOTLIGHT_DURATIONS, value) ? value : 'final';
}

export function spotlightDurationFor(messageKind) {
  return SPOTLIGHT_DURATIONS[normalizeMessageKind(messageKind)];
}

export function shouldBootstrapSpotlight(session, observedAt) {
  if (!session || !Number.isFinite(observedAt)) return false;
  if (typeof session.lastMessage !== 'string' || !session.lastMessage.trim()) return false;
  if (!Number.isFinite(session.lastMessageAt)) return false;
  if (session.status !== 'thinking' && session.status !== 'tool') return false;

  const kind = normalizeMessageKind(session.lastMessageKind);
  if (kind !== 'commentary' && kind !== 'progress') return false;

  const age = observedAt - session.lastMessageAt;
  return age >= -MAX_FUTURE_SKEW_MS && age <= SPOTLIGHT_BOOTSTRAP_MAX_AGE_MS;
}
