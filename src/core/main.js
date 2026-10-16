'use strict';
// Deezer Eagle — main-process core.
//
// Loaded by the stub in resources/app.asar right before Deezer's own entry
// point. Mods never run here: this file only reads them from disk, injects
// their renderer code into Deezer's pages and applies their network block lists.

const { app, session } = require('electron');
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const HOME = path.resolve(__dirname, '..');
const LOG_FILE = path.join(HOME, 'logs', 'main.log');
const DEEZER_HOST = /(^|\.)deezer\.com$/i;

let VERSION = 'dev';
try {
  VERSION = lib.readText(path.join(HOME, 'VERSION')).trim();
} catch {
  // Running from a checkout without VERSION.
}

try {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.writeFileSync(LOG_FILE, '');
} catch {
  // Logging is best effort.
}

function log(...parts) {
  const line = parts.join(' ');
  console.log('[Deezer Eagle]', line);
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // Logging is best effort.
  }
}

let state = lib.loadState(HOME);

function isDeezerPage(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return (protocol === 'https:' || protocol === 'http:') && DEEZER_HOST.test(hostname);
  } catch {
    return false;
  }
}

// Never cancel a page navigation: a bad rule must not blank Deezer's window.
function shouldBlock(details) {
  return details.resourceType !== 'mainFrame' && lib.isBlocked(state.rules, details.url);
}

const hookedSessions = new WeakSet();

function hookSession(ses) {
  if (!ses || hookedSessions.has(ses)) return;
  hookedSessions.add(ses);
  lib.chainBeforeRequest(ses.webRequest, shouldBlock);
}

async function inject(wc) {
  const url = wc.getURL();
  if (!isDeezerPage(url)) return;
  // Re-read mods on every page load: reloading Deezer picks up changes.
  state = lib.loadState(HOME);
  for (const script of lib.buildScripts(HOME, state, VERSION)) {
    try {
      await wc.executeJavaScript(script.code);
    } catch (err) {
      log(`${script.id ? `mod "${script.id}"` : 'core script'} failed: ${err && err.message}`);
      if (script.id) await wc.executeJavaScript(lib.failScript(script.id, err)).catch(() => {});
    }
  }
  log(`injected into ${url} (${state.mods.filter((mod) => mod.enabled).length} active mod(s))`);
}

app.on('session-created', hookSession);
app.once('ready', () => hookSession(session.defaultSession));

app.on('web-contents-created', (_event, wc) => {
  wc.on('dom-ready', () => {
    inject(wc).catch((err) => log('injection failed:', err && err.stack));
  });
  wc.on('before-input-event', (event, input) => {
    if (
      input.type === 'keyDown' &&
      state.config.devtools === true &&
      (input.control || input.meta) &&
      input.shift &&
      input.key.toLowerCase() === 'i'
    ) {
      event.preventDefault();
      wc.toggleDevTools();
    }
  });
});

log(`Deezer Eagle ${VERSION} loaded, ${state.mods.length} mod(s) installed`);
