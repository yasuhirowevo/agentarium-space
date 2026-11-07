import assert from 'node:assert/strict';
import test from 'node:test';
import { activityMotionFor } from '../ui/activity-motion.js';

test('classifies the explicitly supported tool names', () => {
  const categories = {
    reading: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
    writing: ['Edit', 'Write', 'NotebookEdit', 'apply_patch', 'functions.apply_patch'],
    command: ['Bash', 'shell', 'exec_command', 'functions.shell', 'functions.exec_command'],
  };

  for (const [motion, names] of Object.entries(categories)) {
    for (const activity of names) {
      assert.equal(activityMotionFor({ status: 'tool', activity }), motion, activity);
      assert.equal(
        activityMotionFor({ status: 'tool', activity: ` \t${activity.toUpperCase()}\n` }),
        motion,
        `normalized ${activity}`,
      );
    }
  }
});

test('keeps lifecycle status ahead of a stale tool name', () => {
  for (const status of ['thinking', 'waiting', 'idle']) {
    for (const activity of ['Read', 'Write', 'Bash', 'Agent', null]) {
      assert.equal(activityMotionFor({ status, activity }), status, `${status}: ${activity}`);
    }
  }

  for (const status of [undefined, null, '', 'unknown', 'TOOL', ' tool ', 1, {}, []]) {
    assert.equal(activityMotionFor({ status, activity: 'Read' }), 'idle');
  }
});

test('falls back safely for missing sessions and malformed tool names', () => {
  for (const session of [undefined, null, {}, [], true, 1, 'tool']) {
    assert.equal(activityMotionFor(session), 'idle');
  }

  for (const activity of [undefined, null, '', ' \t\n', true, 1, {}, ['Read']]) {
    assert.equal(activityMotionFor({ status: 'tool', activity }), 'generic');
  }
});

test('leaves opaque wrappers and delegation tools generic regardless of details', () => {
  for (const activity of ['exec', 'functions.exec', 'Agent', 'Task', 'unknown']) {
    for (const activityDetail of ['Read', 'functions.apply_patch', 'shell', 'Write: sample.js']) {
      const session = Object.freeze({ status: 'tool', activity, activityDetail });
      assert.equal(activityMotionFor(session), 'generic', `${activity}: ${activityDetail}`);
    }
  }

  assert.equal(activityMotionFor({ status: 'tool', activityDetail: 'Read' }), 'generic');
  assert.equal(
    activityMotionFor({ status: 'tool', activity: 'shell', activityDetail: 'Read sample.js' }),
    'command',
  );
});

test('does not infer categories from substrings or arbitrary namespaces', () => {
  for (const activity of [
    'ReadFile', 'reader', 'pread', 'GrepSearch', 'WebSearchPreview',
    'EditFile', 'rewrite', 'apply_patch_extra', 'NotebookEditTool',
    'BashOutput', 'shell_command', 'exec_command_extra',
    'functions.Read', 'functions.Edit', 'functions.Bash',
    'tools.Read', 'tools.apply_patch', 'tools.shell', 'tools.exec_command',
    'functions.functions.exec_command', '__proto__', 'constructor',
  ]) {
    assert.equal(activityMotionFor({ status: 'tool', activity }), 'generic', activity);
  }
});
