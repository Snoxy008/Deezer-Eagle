'use strict';
// Stand-in for Deezer Desktop's main process, shaped like the real one: a
// window loading a local build/index.html with a non-sandboxed preload, its
// own webRequest listener, and no network of its own (every host is mapped to
// a local test server). It runs the test driver ($E2E_DRIVER) in the page and
// writes what the page and the app observed to $E2E_RESULT.

const { app, BrowserWindow, dialog, session } = require('electron');
const fs = require('fs');
const http = require('http');
const path = require('path');

const port = Number(process.env.E2E_PORT);
app.commandLine.appendSwitch('host-resolver-rules', `MAP * 127.0.0.1:${port}`);
app.commandLine.appendSwitch('no-proxy-server');

// Native dialogs cannot be clicked in a test: record them and answer "Cancel".
const dialogs = [];
dialog.showMessageBox = async (...args) => {
  const options = args.find((arg) => arg && Array.isArray(arg.buttons));
  dialogs.push(options.message);
  return { response: options.cancelId };
};

const hits = [];
const server = http.createServer((req, res) => {
  hits.push(`${req.headers.host}${req.url}`);
  res.setHeader('access-control-allow-origin', '*');
  res.end('ok');
});

app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  let appListenerCalls = 0;
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://www.deezer.com/app-hook*'] }, (details, callback) => {
    appListenerCalls++;
    callback({ cancel: true });
  });

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  await win.loadFile(path.join(__dirname, 'index.html'));
  let page = null;
  try {
    const mode = `window.E2E_MODE = ${JSON.stringify(process.env.E2E_MODE || 'full')};\n`;
    page = await win.webContents.executeJavaScript(mode + fs.readFileSync(process.env.E2E_DRIVER, 'utf8'));
  } catch (err) {
    page = { driverError: String(err && err.message) };
  }
  // E2E_SCREENSHOT=file.png saves what the window shows, to eyeball the UI.
  // Hidden windows are not repainted, so show it first.
  if (process.env.E2E_SCREENSHOT) {
    win.showInactive();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    fs.writeFileSync(process.env.E2E_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
  }
  fs.writeFileSync(
    process.env.E2E_RESULT,
    JSON.stringify({
      page,
      name: app.getName(),
      version: app.getVersion(),
      appPath: app.getAppPath(),
      userData: app.getPath('userData'),
      appListenerCalls,
      dialogs,
      hits,
    }),
  );
  app.quit();
});
