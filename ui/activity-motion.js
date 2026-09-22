const READING_TOOLS = new Set(['read', 'grep', 'glob', 'webfetch', 'websearch']);
const WRITING_TOOLS = new Set(['edit', 'write', 'notebookedit', 'apply_patch', 'functions.apply_patch']);
const COMMAND_TOOLS = new Set(['bash', 'shell', 'exec_command', 'functions.shell', 'functions.exec_command']);

export function activityMotionFor(session) {
  const status = session?.status;
  if (status !== 'tool') {
    return status === 'thinking' || status === 'waiting' ? status : 'idle';
  }

  const name = typeof session.activity === 'string' ? session.activity.trim().toLowerCase() : '';
  if (READING_TOOLS.has(name)) return 'reading';
  if (WRITING_TOOLS.has(name)) return 'writing';
  if (COMMAND_TOOLS.has(name)) return 'command';
  return 'generic';
}
