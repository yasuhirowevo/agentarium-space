import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const IDS = {
  notes: '11111111-1111-4111-8111-111111111111',
  guide: '22222222-2222-4222-8222-222222222222',
  weather: '33333333-3333-4333-8333-333333333333',
  tests: '44444444-4444-4444-8444-444444444444',
  cards: '55555555-5555-4555-8555-555555555555',
};
const NOTES = 'C:/demo/orbit-notes';
const WEATHER = 'C:/demo/atlas-weather';
const encode = (records) => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;

// The caller supplies a fresh directory. These are invented transcripts, never
// copies of user sessions; the regular watchers and UI consume them unchanged.
export async function createDemoFixture(root, { now = Date.now() } = {}) {
  const claudeRoot = path.resolve(root, 'claude');
  const codexRoot = path.resolve(root, 'codex');
  await mkdir(claudeRoot);
  await mkdir(codexRoot);
  const claudeDir = path.join(claudeRoot, 'orbit-notes');
  const date = new Date(now).toISOString().slice(0, 10);
  const codexDir = path.join(codexRoot, ...date.split('-'));
  await mkdir(claudeDir);
  await mkdir(codexDir, { recursive: true });
  const files = Object.fromEntries(Object.entries(IDS).map(([name, id]) => [name,
    name === 'notes' || name === 'guide'
      ? path.join(claudeDir, `${id}.jsonl`)
      : path.join(codexDir, `rollout-${date}T12-00-00-${id}.jsonl`),
  ]));
  const stamp = (offset) => new Date(now + offset).toISOString();
  let sequence = 0;
  const claude = (name, at, type, fields) => ({
    type, timestamp: stamp(at), sessionId: IDS[name], cwd: NOTES,
    gitBranch: name === 'guide' ? 'demo/quick-start' : 'demo/note-search', ...fields,
  });
  const assistant = (name, at, content) => claude(name, at, 'assistant', { message: {
    id: `demo-message-${sequence++}`, model: 'claude-sonnet-4-6',
    usage: { input_tokens: 8500, cache_read_input_tokens: 14000, output_tokens: 180 }, content,
  } });
  const ctext = (name, at, text) => assistant(name, at, [{ type: 'text', text }]);
  const ctool = (at, id, name, input) => assistant('notes', at, [{ type: 'tool_use', id, name, input }]);
  const cresult = (at, id, extra = {}) => claude('notes', at, 'user', {
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'Demo operation complete.' }] }, ...extra,
  });
  const codex = (at, type, payload) => ({ type, timestamp: stamp(at), payload });
  const event = (at, payload) => codex(at, 'event_msg', payload);
  const call = (at, id, name, args) => codex(at, 'response_item', {
    type: 'function_call', call_id: id, name, arguments: JSON.stringify(args),
  });
  const result = (at, id, output = 'Demo operation complete.') => codex(at, 'response_item', {
    type: 'function_call_output', call_id: id, output,
  });
  const message = (at, text, phase = 'commentary') => event(at, { type: 'agent_message', message: text, phase });
  const usage = (at, output) => event(at, { type: 'token_count', info: {
    last_token_usage: { input_tokens: 32000, output_tokens: 240 },
    total_token_usage: { input_tokens: 42000, output_tokens: output, total_tokens: 42000 + output },
    model_context_window: 200000,
  } });
  const commandDone = (name, at, id, cmd) => event(at, {
    type: 'item_completed', turn_id: `demo-${name}`, item: {
      type: 'CommandExecution', id, command: cmd, status: 'completed', exit_code: 0,
      duration: { secs: 1, nanos: 200000000 },
    },
  });
  const edits = (name, at, id, changes) => event(at, {
    type: 'item_completed', turn_id: `demo-${name}`,
    item: { type: 'FileChange', id, status: 'completed', changes },
  });
  const plan = (at, id, completed = false) => [
    call(at, id, 'update_plan', { plan: [
      { step: 'Build forecast cards', status: 'completed' },
      { step: 'Verify empty states', status: completed ? 'completed' : 'in_progress' },
      { step: 'Review the finished view', status: completed ? 'completed' : 'pending' },
    ] }), result(at + 1, id, 'Plan updated'),
  ];
  const base = (name, title, nickname) => [
    codex(-90000, 'session_meta', { id: IDS[name], cwd: WEATHER, originator: 'codex_cli_rs',
      source: nickname ? { subagent: { thread_spawn: {
        parent_thread_id: IDS.weather, agent_nickname: nickname,
      } } } : 'cli' }),
    event(-88000, { type: 'task_started', turn_id: `demo-${name}` }),
    codex(-87999, 'turn_context', { turn_id: `demo-${name}`, cwd: WEATHER,
      model: 'gpt-5.4', effort: 'high', sandbox_policy: { type: 'workspace-write' }, approval_policy: 'on-request' }),
    event(-87000, { type: 'user_message', message: title }),
    usage(-5000, name === 'weather' ? 1800 : 650),
  ];
  const initial = {
    notes: [
      claude('notes', -90000, 'custom-title', { customTitle: 'Note search' }),
      claude('notes', -89000, 'user', { message: { content: 'Add search to the demo notebook.' } }),
      ctool(-45000, 'review', 'Agent', { description: 'Review search tests', subagent_type: 'worker' }),
      cresult(-44000, 'review', { toolUseResult: { isAsync: true, agentId: 'demo-reviewer' } }),
      ctool(-30000, 'read-search', 'Read', { file_path: `${NOTES}/src/search.js` }),
      cresult(-29000, 'read-search'),
      ctext('notes', -4000, 'Adding quick search to the notebook.'),
      ctool(-2000, 'edit-search', 'Edit', { file_path: `${NOTES}/src/search.js` }),
    ],
    guide: [
      claude('guide', -75000, 'custom-title', { customTitle: 'Quick-start guide' }),
      claude('guide', -74000, 'user', { message: { content: 'Write a short guide for the demo notebook.' } }),
      ctext('guide', -25000, 'The quick-start guide is ready to review.'),
    ],
    weather: [
      ...base('weather', 'Forecast view'),
      ...plan(-4800, 'plan-initial'),
      call(-4500, 'spawn-tests', 'spawn_agent', { task_name: 'forecast_tests', message: 'Check the forecast fixtures.' }),
      result(-4499, 'spawn-tests', JSON.stringify({ agent_id: IDS.tests, task_name: '/root/forecast_tests' })),
      call(-4400, 'spawn-cards', 'spawn_agent', { task_name: 'forecast_cards', message: 'Refine the forecast cards.' }),
      result(-4399, 'spawn-cards', JSON.stringify({ agent_id: IDS.cards, task_name: '/root/forecast_cards' })),
      message(-1000, 'Cards and tests are moving forward together.'),
    ],
    tests: [...base('tests', 'Forecast tests', 'Tests'),
      call(-3000, 'test-initial', 'exec_command', { cmd: 'pnpm test -- forecast' })],
    cards: [...base('cards', 'Forecast cards', 'Cards'),
      message(-2000, 'Checking clear, cloudy, and rainy states.')],
  };
  await Promise.all(Object.entries(initial).map(([name, records]) => writeFile(files[name], encode(records), { flag: 'wx' })));
  const timeline = [
    [2000, 'notes', [cresult(2000, 'edit-search'), ctext('notes', 2001, 'Search now filters notes as you type.')]],
    [4000, 'tests', [result(4000, 'test-initial'), commandDone('tests', 4001, 'test-result', 'pnpm test -- forecast'),
      message(4002, 'Forecast fixtures pass, including empty days.')]],
    [6000, 'cards', [call(6000, 'edit-cards', 'apply_patch', { path: 'src/ForecastCard.js' })]],
    [8000, 'notes', [ctool(8000, 'test-search', 'Bash', { command: 'pnpm test -- search' })]],
    [10000, 'cards', [result(10000, 'edit-cards'), edits('cards', 10001, 'card-files', {
      'src/ForecastCard.js': { type: 'update' }, 'test/forecast-card.test.js': { type: 'add' },
    }), message(10002, 'Forecast cards now handle every demo state.')]],
    [12000, 'weather', [call(12000, 'check-weather', 'exec_command', { cmd: 'pnpm test' }), usage(12001, 2450)]],
    [14000, 'notes', [cresult(14000, 'test-search'), ctext('notes', 14001, 'Search checks pass. Reviewing the final changes.')]],
    [16000, 'weather', [result(16000, 'check-weather'), commandDone('weather', 16001, 'weather-result', 'pnpm test'),
      message(16002, 'All forecast checks pass. Finishing the review.')]],
    [18000, 'tests', [message(18000, 'All forecast fixtures pass.', 'final'),
      event(18001, { type: 'task_complete', turn_id: 'demo-tests' })]],
    [20000, 'weather', [...plan(20000, 'plan-finished', true),
      message(20002, 'The five-day forecast view is ready to review.', 'final'),
      event(20003, { type: 'task_complete', turn_id: 'demo-weather' })]],
    [22000, 'cards', [message(22000, 'Forecast cards and empty states are ready.', 'final'),
      event(22001, { type: 'task_complete', turn_id: 'demo-cards' })]],
  ];
  let cursor = 0;
  return {
    claudeRoot, codexRoot, expectedIds: Object.values(IDS), ids: { ...IDS },
    projectPaths: [NOTES, WEATHER], durationMs: 24000,
    async advance(elapsedMs) {
      while (cursor < timeline.length && timeline[cursor][0] <= elapsedMs) {
        const [, name, records] = timeline[cursor];
        await appendFile(files[name], encode(records));
        cursor += 1;
      }
    },
  };
}
