export const DELEGATION_VISIBLE_MS = 60 * 1000;

export function normalizeDelegationLinks(rawLinks, sessionsByKey, limit = 8) {
  if (!Array.isArray(rawLinks) || !(sessionsByKey instanceof Map)) return [];
  return rawLinks
    .filter((link) => (
      link
        && typeof link.id === 'string'
        && typeof link.parentKey === 'string'
        && typeof link.childKey === 'string'
        && link.parentKey !== link.childKey
        && sessionsByKey.has(link.parentKey)
        && sessionsByKey.has(link.childKey)
        && ['running', 'complete', 'failed', 'timed_out'].includes(link.status)
    ))
    .slice(0, limit)
    .map((link) => ({
      id: link.id,
      parentKey: link.parentKey,
      childKey: link.childKey,
      parentSource: link.parentSource,
      childSource: link.childSource,
      status: link.status,
      startedAt: Number.isFinite(link.startedAt) ? link.startedAt : null,
      updatedAt: Number.isFinite(link.updatedAt) ? link.updatedAt : null,
      endedAt: Number.isFinite(link.endedAt) ? link.endedAt : null,
      count: Number.isInteger(link.count) && link.count > 0 ? link.count : 1,
    }));
}

export function delegationVisualState(link, now = Date.now(), reducedMotion = false) {
  const terminalAge = Number.isFinite(link?.endedAt) ? Math.max(0, now - link.endedAt) : 0;
  const fade = link?.status === 'running'
    ? 1
    : Math.max(0, Math.min(1, 1 - terminalAge / DELEGATION_VISIBLE_MS));
  return {
    fade,
    moving: link?.status === 'running' && !reducedMotion,
  };
}
