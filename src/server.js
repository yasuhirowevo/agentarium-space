import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { createClaudeWatcher } from './watchers/claude.js';
import { createCodexWatcher } from './watchers/codex.js';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 41414;
const ACCESS_TOKEN_BYTES = 32;
const FALLBACK_TEXT = 'UI ファイルが見つかりません';
const PRIVATE_RESPONSE_HEADERS = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const defaultUiRoot = path.resolve(sourceDir, '..', 'ui');

function requestedPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULT_PORT;
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function isAllowedHostname(hostname) {
  return hostname === HOST || hostname === 'localhost';
}

function isAllowedHttpHost(host) {
  if (typeof host !== 'string') return false;
  try {
    const parsed = new URL(`http://${host}`);
    return isAllowedHostname(parsed.hostname)
      && parsed.username === ''
      && parsed.password === ''
      && parsed.pathname === '/'
      && parsed.search === ''
      && parsed.hash === '';
  } catch {
    return false;
  }
}

function isAllowedWsOrigin(origin, actualPort) {
  if (origin === undefined) return true;
  if (typeof origin !== 'string') return false;
  return origin === `http://${HOST}:${actualPort}`
    || origin === `http://localhost:${actualPort}`;
}

function accessPath(pathname, accessToken) {
  const parts = pathname.split('/');
  const candidate = parts[1] ?? '';
  const candidateBuffer = Buffer.from(candidate);
  const tokenBuffer = Buffer.from(accessToken);
  if (candidateBuffer.length !== tokenBuffer.length
    || !timingSafeEqual(candidateBuffer, tokenBuffer)) return null;

  return {
    rootWithoutSlash: parts.length === 2,
    relative: parts.slice(2).join('/'),
  };
}

function requestPathname(request) {
  try {
    return decodeURIComponent(new URL(request.url, `http://${HOST}`).pathname);
  } catch {
    return null;
  }
}

function writeResponse(response, status, body, headers = {}) {
  response.writeHead(status, {
    ...PRIVATE_RESPONSE_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    ...headers,
  });
  response.end(body);
}

function rejectUpgrade(socket, status = 403, message = 'Forbidden') {
  const body = `${message}\n`;
  socket.write([
    `HTTP/1.1 ${status} ${message}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n'));
  socket.destroy();
}

function createHttpHandler(uiRoot, accessToken) {
  const normalizedRoot = path.resolve(uiRoot);
  return async (request, response) => {
    if (!isAllowedHttpHost(request.headers.host)) {
      writeResponse(response, 403, 'Forbidden');
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      writeResponse(response, 405, 'Method Not Allowed');
      return;
    }

    const pathname = requestPathname(request);
    if (pathname === null) {
      writeResponse(response, 400, 'Bad Request');
      return;
    }

    const access = accessPath(pathname, accessToken);
    if (!access) {
      writeResponse(response, 403, 'Forbidden');
      return;
    }
    if (access.rootWithoutSlash) {
      writeResponse(response, 308, '', { Location: `${pathname}/` });
      return;
    }

    const relative = access.relative || 'index.html';
    const candidate = path.resolve(normalizedRoot, relative);
    if (!isInside(normalizedRoot, candidate)) {
      writeResponse(response, 403, 'Forbidden');
      return;
    }

    try {
      const info = await stat(candidate);
      if (!info.isFile()) throw new Error('not a file');
      const content = await readFile(candidate);
      response.writeHead(200, {
        ...PRIVATE_RESPONSE_HEADERS,
        'Content-Type': CONTENT_TYPES[path.extname(candidate).toLowerCase()] ?? 'application/octet-stream',
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch {
      if (relative === 'index.html') {
        response.writeHead(200, {
          ...PRIVATE_RESPONSE_HEADERS,
          'Content-Type': 'text/plain; charset=utf-8',
        });
        response.end(request.method === 'HEAD' ? undefined : FALLBACK_TEXT);
      } else {
        writeResponse(response, 404, 'Not Found');
      }
    }
  };
}

/** @param {{ port?: number, uiRoot?: string, claudeRoot?: string, codexRoot?: string }} [options] */
export async function startServer({
  port = requestedPort(process.env.AGENTARIUM_PORT ?? DEFAULT_PORT),
  uiRoot = defaultUiRoot,
  claudeRoot,
  codexRoot,
} = {}) {
  let debounceTimer = null;
  let heartbeatTimer = null;
  let closed = false;
  const accessToken = randomBytes(ACCESS_TOKEN_BYTES).toString('base64url');
  const websocketPath = `/${accessToken}/ws`;
  const server = createServer(createHttpHandler(uiRoot, accessToken));
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const pathname = requestPathname(request);
    if (request.method !== 'GET'
      || !isAllowedHttpHost(request.headers.host)
      || !isAllowedWsOrigin(request.headers.origin, request.socket.localPort)
      || pathname !== websocketPath) {
      rejectUpgrade(socket);
      return;
    }

    wss.handleUpgrade(request, socket, head, (websocket) => {
      wss.emit('connection', websocket, request);
    });
  });

  function sessions(now = Date.now()) {
    return claude.getSessions(now)
      .concat(codex.getSessions(now))
      .sort((left, right) => right.lastActivity - left.lastActivity);
  }

  function snapshot() {
    const at = Date.now();
    return { type: 'snapshot', at, sessions: sessions(at) };
  }

  function broadcast() {
    if (closed) return;
    const payload = JSON.stringify(snapshot());
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  function scheduleBroadcast() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(broadcast, 1000);
  }

  const claude = createClaudeWatcher({
    onUpdate: scheduleBroadcast,
    ...(claudeRoot === undefined ? {} : { root: claudeRoot }),
  });
  const codex = createCodexWatcher({
    onUpdate: scheduleBroadcast,
    ...(codexRoot === undefined ? {} : { root: codexRoot }),
  });

  wss.on('connection', (socket) => {
    socket.send(JSON.stringify(snapshot()));
  });
  wss.on('error', (error) => {
    if (process.env.AGENTARIUM_DEBUG) console.error('[server] WebSocket error', error);
  });

  try {
    await Promise.all([claude.start(), codex.start()]);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, HOST, () => {
        server.off('error', reject);
        resolve(undefined);
      });
    });
  } catch (error) {
    await Promise.allSettled([claude.close(), codex.close()]);
    wss.close();
    throw error;
  }

  heartbeatTimer = setInterval(broadcast, 15_000);
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  async function close() {
    if (closed) return;
    closed = true;
    clearTimeout(debounceTimer);
    clearInterval(heartbeatTimer);
    await Promise.allSettled([claude.close(), codex.close()]);
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve(undefined)));
  }

  return {
    server,
    wss,
    host: HOST,
    port: actualPort,
    url: `http://${HOST}:${actualPort}/${accessToken}/`,
    getSnapshot: snapshot,
    close,
  };
}

const isDirectRun = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  startServer()
    .then(({ url }) => console.log(`Agentarium Space listening on ${url}`))
    .catch((error) => {
      console.error('Agentarium Space failed to start:', error);
      process.exitCode = 1;
    });
}
