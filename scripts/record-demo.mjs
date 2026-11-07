import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BrowserWindow, session } from 'electron';
import { WebSocket } from 'ws';
import { startServer } from '../src/server.js';
import { isAllowedRendererRequest } from '../electron/network-policy.js';
import { createDemoFixture } from './demo-fixture.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(repository, 'dist', 'demo');
const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const DURATION_SECONDS = 24;
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const work = process.argv[2];
assert.ok(work && path.isAbsolute(work), 'Run through pnpm run demo:capture');
app.setPath('userData', path.join(work, 'profile'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();

let window;
let server;
let encoder;
let encoderDone;
let encoderFailure;
let encoderLog = '';
let monitor;
let auditFailure;
let latestFrame;
let paintCount = 0;
const snapshots = [];
const pageErrors = [];

function auditSnapshot(snapshot, fixture) {
  assert.deepEqual(snapshot.sessions.map(({ id }) => id).sort(), [...fixture.expectedIds].sort());
  for (const item of snapshot.sessions) {
    assert.ok(['C:/demo/orbit-notes', 'C:/demo/atlas-weather'].includes(item.cwd));
    assert.ok(!item.parentId || fixture.expectedIds.includes(item.parentId));
  }
  // Watcher keys are absolute log paths used only as internal UI identity/seed.
  // Keep them out of the saved audit, which covers every displayable field.
  const visible = { ...snapshot, sessions: snapshot.sessions.map(({ key: _key, ...item }) => item) };
  const text = JSON.stringify(visible).replaceAll('\\\\', '/').toLowerCase();
  for (const privatePath of [os.homedir(), repository, work]) {
    assert.ok(!text.includes(privatePath.replaceAll('\\', '/').toLowerCase()),
      'A local filesystem path appeared in demo data');
  }
  snapshots.push(visible);
}

async function capture() {
  const probe = spawnSync(ffmpeg, ['-version'], { windowsHide: true, encoding: 'utf8' });
  assert.equal(probe.status, 0, 'FFmpeg must be available on PATH (or set FFMPEG_PATH)');
  await mkdir(output, { recursive: true });
  const fixture = await createDemoFixture(work);
  server = await startServer({ port: 0, claudeRoot: fixture.claudeRoot, codexRoot: fixture.codexRoot });
  const monitorUrl = new URL('ws', server.url);
  monitorUrl.protocol = 'ws:';
  monitor = new WebSocket(monitorUrl);
  monitor.on('message', (data) => {
    try { auditSnapshot(JSON.parse(data.toString()), fixture); }
    catch (error) { auditFailure = error; }
  });
  monitor.on('error', (error) => { auditFailure = error; });
  await once(monitor, 'open');
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRendererRequest(details.url, server.url) });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window = new BrowserWindow({
    width: WIDTH, height: HEIGHT, useContentSize: true, show: false,
    backgroundColor: '#070b14',
    webPreferences: {
      offscreen: true, backgroundThrottling: false,
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.setFrameRate(FPS);
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') pageErrors.push(details.message);
  });
  window.webContents.on('paint', (_event, _rect, image) => {
    const { width, height } = image.getSize();
    if (width !== WIDTH || height !== HEIGHT) return;
    latestFrame = image.toBitmap();
    paintCount++;
  });
  await window.loadURL(server.url);
  await delay(3500);
  assert.ok(!existsSync(path.join(work, 'cancel')), 'Demo capture cancelled');
  if (auditFailure) throw auditFailure;
  assert.ok(latestFrame, 'Offscreen renderer did not produce a frame');
  const ready = await window.webContents.executeJavaScript(`({
    visible: !document.hidden,
    linked: document.querySelector('#connection').classList.contains('is-connected'),
    width: innerWidth, height: innerHeight,
  })`);
  assert.deepEqual(ready, { visible: true, linked: true, width: WIDTH, height: HEIGHT });

  const videoPath = path.join(output, 'agentarium-space-demo.mp4');
  encoder = spawn(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pixel_format', 'bgra', '-video_size', `${WIDTH}x${HEIGHT}`,
    '-framerate', String(FPS), '-i', 'pipe:0', '-an',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '21', '-pix_fmt', 'yuv420p',
    '-map_metadata', '-1', '-movflags', '+faststart', videoPath,
  ], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  encoder.stderr.on('data', (chunk) => { encoderLog += chunk.toString(); });
  encoderDone = new Promise((resolve) => {
    encoder.once('error', (error) => { encoderFailure = error; resolve(); });
    encoder.once('close', (code) => {
      if (code !== 0) encoderFailure = new Error(`FFmpeg exited with ${code}: ${encoderLog}`);
      resolve();
    });
  });
  encoder.stdin.on('error', (error) => { encoderFailure = error; });
  const started = performance.now();
  const firstPaint = paintCount;
  let previousSecond = -1;
  console.log('Recording fictional sessions at 1920x1080, 30 fps, 24 seconds.');
  for (let frame = 0; frame < FPS * DURATION_SECONDS; frame++) {
    const elapsedMs = frame * 1000 / FPS;
    await delay(Math.max(0, started + elapsedMs - performance.now()));
    if (encoderFailure) throw encoderFailure;
    if (auditFailure) throw auditFailure;
    assert.ok(!existsSync(path.join(work, 'cancel')), 'Demo capture cancelled');
    const second = Math.floor(elapsedMs / 1000);
    if (second !== previousSecond) {
      previousSecond = second;
      await fixture.advance(elapsedMs);
      if (second === 12) {
        await window.webContents.executeJavaScript(`(() => {
          const row = [...document.querySelectorAll('button.overview-session-row')]
            .find(button => button.querySelector('.agent-title')?.textContent === 'Forecast view');
          if (!row) throw new Error('Demo session is missing from the agent tree');
          row.click();
        })()`);
      }
      if (second === 18) {
        await window.webContents.executeJavaScript("document.querySelector('#focus-back').click()");
      }
      if (second === 23) {
        const poster = await window.webContents.capturePage();
        await writeFile(path.join(output, 'agentarium-space-demo.png'), poster.toPNG());
      }
    }
    assert.equal(latestFrame.length, WIDTH * HEIGHT * 4);
    if (!encoder.stdin.write(latestFrame)) await once(encoder.stdin, 'drain');
  }
  encoder.stdin.end();
  await encoderDone;
  if (encoderFailure) throw encoderFailure;
  assert.ok(paintCount - firstPaint > FPS * DURATION_SECONDS / 3, 'Too few animation frames');
  assert.deepEqual(pageErrors, [], 'The demo page reported errors');
  if (auditFailure) throw auditFailure;
  assert.ok(snapshots.length > 5, 'No live demo snapshots received');
  await writeFile(path.join(output, 'snapshots.json'), JSON.stringify(snapshots, null, 2));
  console.log(`Saved ${videoPath}`);
  console.log(`Recorded ${paintCount - firstPaint} rendered updates; all snapshots contain only fictional sessions.`);
}

async function main() {
  try {
    await app.whenReady();
    await capture();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (encoder && encoder.exitCode === null && encoder.signalCode === null) {
      encoder.kill();
      await encoderDone;
    }
    window?.destroy();
    monitor?.terminate();
    await server?.close();
    app.exit(process.exitCode || 0);
  }
}

// Electron emits ready after its entry module has finished evaluating.
void main();
