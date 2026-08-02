import { createDelegationReader, resolveDelegations } from './delegations.js';
import { createClaudeWatcher } from './watchers/claude.js';
import { createCodexWatcher } from './watchers/codex.js';

async function main() {
  const now = Date.now();
  const claude = createClaudeWatcher();
  const codex = createCodexWatcher();
  const delegationReader = createDelegationReader();
  const [claudeSessions, codexSessions, records] = await Promise.all([
    claude.scan(now),
    codex.scan(now),
    delegationReader.scan(),
  ]);
  await Promise.allSettled([
    claude.recoverDelegationStarts(records, now),
    codex.recoverDelegationStarts(records, now),
  ]);
  const sessions = claudeSessions
    .concat(codexSessions)
    .sort((left, right) => right.lastActivity - left.lastActivity);
  const starts = claude.getDelegationStarts(now).concat(codex.getDelegationStarts(now));
  const delegations = resolveDelegations(records, starts, sessions, now);

  process.stdout.write(`${JSON.stringify({ type: 'snapshot', at: now, sessions, delegations }, null, 2)}\n`);
}

main().catch((error) => {
  if (process.env.AGENTARIUM_DEBUG) console.error('[scan] unexpected error', error);
  process.stdout.write(`${JSON.stringify({ type: 'snapshot', at: Date.now(), sessions: [], delegations: [] }, null, 2)}\n`);
  process.exitCode = 0;
});
