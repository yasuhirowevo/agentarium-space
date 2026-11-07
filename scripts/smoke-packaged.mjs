import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const APP_NAME = 'Agentarium Space.app';
const APP_ID = 'io.github.yasuhirowevo.agentarium-space';
// Rosetta can take more than 20 seconds on the first x64 launch.
const START_TIMEOUT_MS = 60_000;

function defaultAppPath() {
  const directory = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
  return path.resolve('dist', directory, APP_NAME);
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
  return waitForOutput(
    child,
    /(Agentarium Space window ready)/,
    'Electron window',
  );
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function readPlist(plistPath) {
  const { stdout } = await execFileAsync('plutil', [
    '-convert', 'json', '-o', '-', plistPath,
  ]);
  return JSON.parse(stdout);
}

async function assertAsset(url, expectedContent) {
  const response = await fetch(new URL(url));
  assert.equal(response.status, 200, `${url} should return HTTP 200`);
  const body = await response.text();
  assert.match(body, expectedContent, `${url} should contain packaged application content`);
}

function spawnPackaged(executablePath, args, home, extraEnv = {}) {
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...baseEnv } = process.env;
  return spawn(executablePath, args, {
    env: {
      ...baseEnv,
      HOME: home,
      AGENTARIUM_PORT: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function runServerSmoke(executablePath, serverPath, home) {
  const child = spawnPackaged(executablePath, [serverPath], home, {
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

async function runElectronSmoke(executablePath, home) {
  const child = spawnPackaged(executablePath, [], home);

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
  assert.equal(process.platform, 'darwin', 'Packaged smoke test only supports macOS');
  const appPath = path.resolve(process.argv[2] ?? defaultAppPath());
  const expectedArch = process.argv[3] ?? process.arch;
  const contentsPath = path.join(appPath, 'Contents');
  const executablePath = path.join(contentsPath, 'MacOS', 'Agentarium Space');
  const resourcesPath = path.join(contentsPath, 'Resources');
  const asarPath = path.join(resourcesPath, 'app.asar');
  const serverPath = path.join(asarPath, 'src', 'server.js');
  const plistPath = path.join(contentsPath, 'Info.plist');

  for (const requiredPath of [appPath, executablePath, asarPath, plistPath]) {
    assert.ok(existsSync(requiredPath), `Missing packaged path: ${requiredPath}`);
  }

  const infoPlist = await readPlist(plistPath);
  assert.equal(infoPlist.CFBundleIdentifier, APP_ID);
  assert.equal(infoPlist.LSMinimumSystemVersion, '12.0');
  assert.equal(infoPlist.NSAppTransportSecurity?.NSAllowsArbitraryLoads, false);
  assert.equal(infoPlist.NSAppTransportSecurity?.NSAllowsLocalNetworking, true);
  assert.ok(infoPlist.NSAppTransportSecurity?.NSExceptionDomains?.['127.0.0.1']);
  for (const forbiddenKey of [
    'NSAudioCaptureUsageDescription',
    'NSBluetoothAlwaysUsageDescription',
    'NSBluetoothPeripheralUsageDescription',
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription',
  ]) {
    assert.equal(forbiddenKey in infoPlist, false, `${forbiddenKey} must not be packaged`);
  }

  const { stdout: archOutput } = await execFileAsync('lipo', ['-archs', executablePath]);
  const expectedLipoArch = expectedArch === 'x64' ? 'x86_64' : expectedArch;
  assert.ok(
    archOutput.trim().split(/\s+/).includes(expectedLipoArch),
    `Expected ${expectedLipoArch} executable, received: ${archOutput.trim()}`,
  );

  const smokeHome = await mkdtemp(path.join(tmpdir(), 'agentarium-space-smoke-'));

  try {
    await runServerSmoke(executablePath, serverPath, smokeHome);
    await runElectronSmoke(executablePath, smokeHome);
    console.log(`Packaged smoke test passed: ${appPath}`);
  } finally {
    await rm(smokeHome, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
