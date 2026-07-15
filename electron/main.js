import { app, BrowserWindow } from 'electron';
import { startServer } from '../src/server.js';

let serverHandle = null;
let mainWindow = null;
let allowQuit = false;
let shutdownPromise = null;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#101522',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  await mainWindow.loadURL(serverHandle.url);
  return mainWindow;
}

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    if (!serverHandle) return;
    const handle = serverHandle;
    serverHandle = null;
    await handle.close();
  })();
  return shutdownPromise;
}

app.on('before-quit', (event) => {
  if (allowQuit) return;
  event.preventDefault();
  void shutdown().finally(() => {
    allowQuit = true;
    app.quit();
  });
});

app.on('window-all-closed', () => app.quit());

app.whenReady()
  .then(async () => {
    serverHandle = await startServer();
    await createWindow();
  })
  .catch((error) => {
    console.error('Agentarium Space failed to launch:', error);
    allowQuit = true;
    app.quit();
  });
