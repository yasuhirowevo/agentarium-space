export function contextUsage(session) {
  if (!Number.isFinite(session?.contextUsedTokens)
    || !Number.isFinite(session?.contextWindowTokens)
    || session.contextUsedTokens < 0
    || session.contextWindowTokens <= 0
    || session.contextUsedTokens > session.contextWindowTokens) return null;
  return session.contextUsedTokens / session.contextWindowTokens;
}

export function contextLabel(session) {
  if (!Number.isFinite(session?.contextUsedTokens) || session.contextUsedTokens < 0) return '';
  const usage = contextUsage(session);
  return usage === null
    ? `CTX ${Math.round(session.contextUsedTokens / 1000)}k`
    : `CTX ${Math.round(usage * 100)}%`;
}
