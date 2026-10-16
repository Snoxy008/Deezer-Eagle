'use strict';
// Stand-in for Deezer's main process: serves a "www.deezer.com" page with a
// strict CSP, registers its own webRequest listener (like a real app could),
// then reports what the page and the app observed to $E2E_RESULT.

const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const http = require('http');

const port = Number(process.env.E2E_PORT);
app.commandLine.appendSwitch('host-resolver-rules', `MAP * 127.0.0.1:${port}`);
app.commandLine.appendSwitch('no-proxy-server');

const PAGE = '<!doctype html><title>Deezer</title><div id="probe">probe</div><script src="/page.js"></script>';
const PAGE_JS = `
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let i = 0; i < 200 && !window.Eagle; i++) await sleep(25);
  await sleep(200);
  const tryFetch = (url) => fetch(url, { mode: 'no-cors' }).then(() => 'ok', () => 'blocked');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'E', ctrlKey: true, shiftKey: true }));
  const host = document.querySelector('deezer-eagle');
  const panel = host && host.shadowRoot.querySelector('.panel');
  const probe = getComputedStyle(document.getElementById('probe'));
  history.pushState({}, '', '/fr/album/1');
  window.__e2e = {
    eagle: typeof window.Eagle,
    mods: window.Eagle ? Eagle.mods.map((mod) => mod.id + ':' + mod.status) : [],
    modRan: document.documentElement.dataset.e2eMod || '',
    navigated: document.documentElement.dataset.e2eNav || '',
    probeColor: probe.color,
    probeBackground: probe.backgroundColor,
    panel: panel ? panel.textContent : '',
    adblock: await tryFetch('http://ads.doubleclick.net/pixel'),
    modBlock: await tryFetch('http://tracker.e2e-blocked.test/x'),
    allowed: await tryFetch('http://cdn.e2e-allowed.test/x'),
    appHook: await tryFetch('http://www.deezer.com/app-hook'),
  };
})();
`;

const hits = [];
const server = http.createServer((req, res) => {
  hits.push(`${req.headers.host}${req.url}`);
  if (req.url === '/') {
    res.setHeader('content-type', 'text/html');
    res.setHeader('content-security-policy', "script-src 'self'; style-src 'self'");
    return res.end(PAGE);
  }
  if (req.url === '/page.js') {
    res.setHeader('content-type', 'text/javascript');
    return res.end(PAGE_JS);
  }
  return res.end('ok');
});

app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  let appListenerCalls = 0;
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://www.deezer.com/app-hook*'] }, (details, callback) => {
    appListenerCalls++;
    callback({ cancel: true });
  });

  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadURL('http://www.deezer.com/');
  let page = null;
  for (let i = 0; i < 300 && !page; i++) {
    page = await win.webContents.executeJavaScript('window.__e2e || null');
    if (!page) await new Promise((resolve) => setTimeout(resolve, 50));
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
      hits,
    }),
  );
  app.quit();
});
