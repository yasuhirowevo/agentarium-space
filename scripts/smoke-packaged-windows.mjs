import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const APP_NAME = 'Agentarium Space.exe';
const START_TIMEOUT_MS = 60_000;
const PE_MACHINE_X64 = 0x8664;

function defaultAppPath() {
  return path.resolve('dist', 'win-unpacked', APP_NAME);
}

function waitForOutput(child, pattern, label) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      finish(
        reject,
        new Error(`Packaged ${label} was not ready within ${START_TIMEOUT_MS}ms\n${stderr}`),
      );
    }, START_TIMEOUT_MS);

    function finish(callback, value) {
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.stderr.off('data', onStderr);
      child.off('error', onError);
      child.off('exit', onExit);
      callback(value);
    }

    function onStdout(chunk) {
      stdout += chunk.toString();
      const match = stdout.match(pattern);
      if (match) finish(resolve, match[1]);
    }

    function onStderr(chunk) {
      stderr += chunk.toString();
    }

    function onError(error) {
      finish(reject, error);
    }

    function onExit(code, signal) {
      finish(reject, new Error(
        `Packaged ${label} exited before it was ready (code=${code}, signal=${signal})\n${stderr}`,
      ));
    }

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function waitForListeningUrl(child) {
  return waitForOutput(
    child,
    /Agentarium Space listening on (http:\/\/[^\s]+)/,
    'server',
  );
}

function waitForWindowReady(child) {
  return waitForOutput(child, /(Agentarium Space window ready)/, 'Electron window');
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

function spawnPackaged(executablePath, args, userProfile, extraEnv = {}) {
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...baseEnv } = process.env;
  return spawn(executablePath, args, {
    env: {
      ...baseEnv,
      HOME: userProfile,
      USERPROFILE: userProfile,
      APPDATA: path.join(userProfile, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(userProfile, 'AppData', 'Local'),
      AGENTARIUM_PORT: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function assertAsset(url, expectedContent) {
  const response = await fetch(new URL(url));
  assert.equal(response.status, 200, `${url} should return HTTP 200`);
  const body = await response.text();
  assert.match(body, expectedContent, `${url} should contain packaged application content`);
}

async function readPeMachine(executablePath) {
  const handle = await open(executablePath, 'r');
  try {
    const dosHeader = Buffer.alloc(64);
    await handle.read(dosHeader, 0, dosHeader.length, 0);
    assert.equal(dosHeader.toString('ascii', 0, 2), 'MZ', 'Windows executable must have an MZ header');

    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(6);
    await handle.read(peHeader, 0, peHeader.length, peOffset);
    assert.equal(peHeader.toString('ascii', 0, 4), 'PE\0\0', 'Windows executable must have a PE header');
    return peHeader.readUInt16LE(4);
  } finally {
    await handle.close();
  }
}

async function runServerSmoke(executablePath, serverPath, userProfile) {
  const child = spawnPackaged(executablePath, [serverPath], userProfile, {
    ELECTRON_RUN_AS_NODE: '1',
  });

  try {
    const baseUrl = await waitForListeningUrl(child);
    await assertAsset(baseUrl, /<title>Agentarium Space<\/title>/);
    await assertAsset(new URL('office.css', baseUrl), /\.app-shell\s*\{/);
    await assertAsset(new URL('office.js', baseUrl), /class WSClient/);
  } finally {
    await stopChild(child);
  }
}

async function runElectronSmoke(executablePath, userProfile) {
  const child = spawnPackaged(executablePath, [], userProfile);

  try {
    await waitForWindowReady(child);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    assert.equal(child.exitCode, null, 'Packaged Electron app exited after opening its window');
    assert.equal(child.signalCode, null, 'Packaged Electron app was terminated after opening its window');
  } finally {
    await stopChild(child);
  }
}

async function main() {
  assert.equal(process.platform, 'win32', 'Packaged smoke test only supports Windows');
  const executablePath = path.resolve(process.argv[2] ?? defaultAppPath());
  const expectedArch = process.argv[3] ?? process.arch;
  const resourcesPath = path.join(path.dirname(executablePath), 'resources');
  const asarPath = path.join(resourcesPath, 'app.asar');
  const serverPath = path.join(asarPath, 'src', 'server.js');

  for (const requiredPath of [executablePath, asarPath]) {
    assert.ok(existsSync(requiredPath), `Missing packaged path: ${requiredPath}`);
  }

  const machine = await readPeMachine(executablePath);
  assert.equal(expectedArch, 'x64', 'Windows packaged smoke test currently supports x64 only');
  assert.equal(machine, PE_MACHINE_X64, 'Expected an x64 Windows executable');

  const userProfile = await mkdtemp(path.join(tmpdir(), 'agentarium-space-smoke-'));
  await mkdir(path.join(userProfile, 'AppData', 'Roaming'), { recursive: true });
  await mkdir(path.join(userProfile, 'AppData', 'Local'), { recursive: true });

  try {
    await runServerSmoke(executablePath, serverPath, userProfile);
    await runElectronSmoke(executablePath, userProfile);
    console.log(`Windows packaged smoke test passed: ${executablePath}`);
  } finally {
    await rm(userProfile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
