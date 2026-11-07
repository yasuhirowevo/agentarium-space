import { createClaudeWatcher } from './watchers/claude.js';
import { createCodexWatcher } from './watchers/codex.js';

async function main() {
  const now = Date.now();
  const claude = createClaudeWatcher();
  const codex = createCodexWatcher();
  const [claudeSessions, codexSessions] = await Promise.all([
    claude.scan(now),
    codex.scan(now),
  ]);
  const sessions = claudeSessions
    .concat(codexSessions)
    .sort((left, right) => right.lastActivity - left.lastActivity);

  process.stdout.write(`${JSON.stringify({ type: 'snapshot', at: now, sessions }, null, 2)}\n`);
}

main().catch((error) => {
  if (process.env.AGENTARIUM_DEBUG) console.error('[scan] unexpected error', error);
  process.stdout.write(`${JSON.stringify({ type: 'snapshot', at: Date.now(), sessions: [] }, null, 2)}\n`);
  process.exitCode = 0;
});
