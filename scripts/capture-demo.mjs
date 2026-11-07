import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const work = await mkdtemp(path.join(os.tmpdir(), 'agentarium-demo-'));
const entry = fileURLToPath(new URL('record-demo.mjs', import.meta.url));
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env;
try {
  const child = spawn(electron, [entry, work], { env, windowsHide: true, stdio: 'inherit' });
  let stopping = false;
  let forcedStop;
  const stop = () => {
    if (stopping || child.exitCode !== null || child.signalCode !== null) return;
    stopping = true;
    void writeFile(path.join(work, 'cancel'), '').catch(() => {});
    forcedStop = setTimeout(() => {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        child.kill('SIGKILL');
      }
    }, 5000);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const timeout = setTimeout(stop, 120_000);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
  } finally {
    clearTimeout(timeout);
    clearTimeout(forcedStop);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
} finally {
  // Chromium releases its profile files only after the Electron process exits.
  assert.equal(path.dirname(work), path.resolve(os.tmpdir()));
  assert.ok(path.basename(work).startsWith('agentarium-demo-'));
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
