'use strict';
// Deezer Eagle — main-process core.
//
// Loaded by the stub in resources/app.asar right before Deezer's own entry
// point. Mods never run here: this file reads them from disk, injects their
// renderer code into Deezer's page, applies their network block lists and
// answers the Eagle library through the preload bridge.

const { app, session, ipcMain, dialog, net, shell, BrowserWindow } = require('electron');
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('./lib');

const HOME = path.resolve(__dirname, '..');
const CLI = path.join(HOME, 'cli', 'eagle.ps1');
const PRELOAD = path.join(__dirname, 'preload.js');
const LOG_FILE = path.join(HOME, 'logs', 'main.log');
const SHELL = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
// Raw GitHub files (registry, manifests, VERSION); overridable for tests.
const REMOTE = (process.env.DEEZER_EAGLE_REMOTE || 'https://raw.githubusercontent.com').replace(/\/+$/, '');
const REGISTRY_URL = `${REMOTE}/Snoxy008/Deezer-Eagle/main/registry.json`;
const TOPIC = 'deezer-eagle-mod';

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

// ---- Injection --------------------------------------------------------------

// Local pages qualify only if they are Deezer's app shell, not a splash screen.
async function isDeezerPage(wc) {
  const url = wc.getURL();
  if (!lib.isAppUrl(url)) return false;
  if (/^https?:/i.test(url)) return true;
  return wc.executeJavaScript('Boolean(document.getElementById("dzr-app"))').catch(() => false);
}

async function inject(wc) {
  if (!(await isDeezerPage(wc))) return;
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
  log(`injected into ${wc.getURL()} (${state.mods.filter((mod) => mod.enabled).length} active mod(s))`);
}

// ---- Sessions: network rules and the preload bridge -------------------------

// Never cancel a page navigation: a bad rule must not blank Deezer's window.
function shouldBlock(details) {
  return details.resourceType !== 'mainFrame' && lib.isBlocked(state.rules, details.url);
}

function registerPreload(ses) {
  try {
    if (typeof ses.registerPreloadScript === 'function') {
      ses.registerPreloadScript({ type: 'frame', id: 'deezer-eagle', filePath: PRELOAD });
    } else {
      ses.setPreloads(ses.getPreloads().concat(PRELOAD));
    }
  } catch (err) {
    log('could not register the preload, the library will be read-only:', err && err.message);
  }
}

const hookedSessions = new WeakSet();

function hookSession(ses) {
  if (!ses || hookedSessions.has(ses)) return;
  hookedSessions.add(ses);
  lib.chainBeforeRequest(ses.webRequest, shouldBlock);
  registerPreload(ses);
}

// ---- Library requests ---------------------------------------------------------

let cliQueue = Promise.resolve();

// Installs and updates go through the CLI so there is a single implementation.
function runCli(args) {
  const run = () =>
    new Promise((resolve) => {
      let output = '';
      const child = spawn(SHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CLI, ...args], {
        cwd: HOME,
        windowsHide: true,
        env: Object.assign({}, process.env, { DEEZER_EAGLE_HOME: HOME }),
      });
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      child.on('error', (err) => resolve({ ok: false, output: String(err.message) }));
      child.on('close', (code) => resolve({ ok: code === 0, output: output.trim() }));
    });
  cliQueue = cliQueue.then(run, run);
  return cliQueue;
}

function fetchText(url) {
  const doFetch = typeof net.fetch === 'function' ? net.fetch.bind(net) : fetch;
  return doFetch(url, { headers: { 'user-agent': 'Deezer-Eagle', accept: 'application/vnd.github+json' } }).then((response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.text();
  });
}

function fetchJson(url) {
  return fetchText(url).then((body) => JSON.parse(body));
}

// Starts the CLI in a process that outlives Deezer (post-update patch, Eagle
// upgrade). A detached console program gets no console on Windows and may
// never start, so there PowerShell's Start-Process launches it in its own
// hidden console; this waits for that (about a second).
function startDetached(cliArgs, logName) {
  const env = Object.assign({}, process.env, {
    DEEZER_EAGLE_HOME: HOME,
    DEEZER_EAGLE_DEEZER_PATH: path.dirname(process.execPath),
  });
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CLI, ...cliArgs];
  if (process.platform === 'win32') {
    const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
    const argumentList = args.map((arg) => (arg === CLI ? `"${arg}"` : arg)).join(' ');
    const command =
      `Start-Process -FilePath powershell.exe -WindowStyle Hidden ` +
      `-WorkingDirectory ${quote(HOME)} -ArgumentList ${quote(argumentList)}`;
    execFileSync(SHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      env,
      windowsHide: true,
      timeout: 20000,
    });
    return;
  }
  const output = fs.openSync(path.join(HOME, 'logs', logName), 'w');
  const child = spawn(SHELL, args, { cwd: HOME, detached: true, stdio: ['ignore', output, output], env });
  fs.closeSync(output);
  child.on('error', (err) => log(`${cliArgs[0]} did not start:`, err.message));
  child.unref();
}

let registryCache = null;

async function getRegistry() {
  const location = process.env.DEEZER_EAGLE_REGISTRY || REGISTRY_URL;
  if (!/^https?:\/\//i.test(location)) return lib.readJson(location, { mods: [] });
  if (registryCache && Date.now() - registryCache.time < 5 * 60 * 1000) return registryCache.value;
  const value = await fetchJson(location);
  registryCache = { time: Date.now(), value };
  return value;
}

async function marketplace(query) {
  const result = { registry: [], community: [], errors: [] };
  try {
    result.registry = ((await getRegistry()).mods || []).map((mod) => ({
      spec: mod.id,
      id: mod.id,
      name: mod.name || mod.id,
      description: mod.description || '',
      author: mod.author || '',
      type: mod.type === 'theme' ? 'theme' : 'mod',
      colors: lib.themeColors(mod.colors),
    }));
  } catch (err) {
    result.errors.push(`Registry unavailable (${err.message})`);
  }
  try {
    const q = `${query ? `${query} ` : ''}topic:${TOPIC}`;
    const body = await fetchJson(`https://api.github.com/search/repositories?sort=stars&per_page=50&q=${encodeURIComponent(q)}`);
    result.community = (body.items || [])
      .filter((item) => item.full_name.toLowerCase() !== 'snoxy008/deezer-eagle')
      .map((item) => ({
        spec: item.full_name,
        name: item.name,
        description: item.description || '',
        author: item.owner ? item.owner.login : '',
        stars: item.stargazers_count,
      }));
  } catch (err) {
    result.errors.push(`GitHub search unavailable (${err.message})`);
  }
  return result;
}

async function confirmInstall(event, spec) {
  const options = {
    type: 'warning',
    buttons: ['Install', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: 'Deezer Eagle',
    message: `Install the mod "${spec}"?`,
    detail:
      'This mod is not part of Deezer Eagle itself. Mods run code inside Deezer, with access to your ' +
      'Deezer account: only install mods from authors you trust.',
  };
  const win = BrowserWindow.fromWebContents(event.sender);
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return response === 0;
}

function assertModId(id) {
  if (!lib.MOD_ID.test(String(id))) throw new Error(`invalid mod id "${id}"`);
}

// Only the top frame of a Deezer page may talk to the core.
function handle(channel, handler) {
  ipcMain.handle(`eagle:${channel}`, (event, ...args) => {
    const frame = event.senderFrame;
    if (!frame || frame.parent || !lib.isAppUrl(frame.url)) throw new Error('Deezer Eagle: request refused');
    return handler(event, ...args);
  });
}

handle('list', () => lib.listMods(HOME));

// Changes apply to network rules at once; the page applies CSS by itself.
handle('set-enabled', (_event, id, enabled) => {
  assertModId(id);
  lib.setModEnabled(HOME, id, Boolean(enabled));
  state = lib.loadState(HOME);
});

handle('set-theme', (_event, id) => {
  if (id !== null) {
    assertModId(id);
    if (!state.mods.some((mod) => mod.id === id && lib.isTheme(mod))) throw new Error(`no theme "${id}"`);
  }
  lib.setTheme(HOME, id);
  state = lib.loadState(HOME);
});

handle('remove', (_event, id) => {
  assertModId(id);
  lib.removeMod(HOME, id);
  state = lib.loadState(HOME);
});

handle('settings', () => ({ version: VERSION, home: HOME, devtools: state.config.devtools === true }));

handle('set-devtools', (_event, enabled) => {
  lib.updateConfig(HOME, (config) => {
    config.devtools = Boolean(enabled);
  });
  state = lib.loadState(HOME);
});

handle('open', (_event, what) => {
  if (what === 'user-css') {
    const file = path.join(HOME, 'user.css');
    if (!fs.existsSync(file)) fs.writeFileSync(file, '/* Your own CSS, applied after every mod. */\n');
    return shell.openPath(file);
  }
  if (what === 'folder') return shell.openPath(HOME);
  throw new Error(`cannot open "${what}"`);
});

let updatesCache = null;

// Latest versions of Eagle and of every mod installed from GitHub.
async function checkUpdates() {
  if (updatesCache && Date.now() - updatesCache.time < 30 * 60 * 1000) return updatesCache.value;
  const value = { eagle: { current: VERSION, latest: null }, mods: {} };
  const jobs = [
    fetchText(`${REMOTE}/Snoxy008/Deezer-Eagle/main/VERSION`).then((latest) => {
      value.eagle.latest = latest.trim();
    }),
  ];
  for (const mod of lib.listMods(HOME)) {
    if (!mod.source || mod.source.type !== 'github') continue;
    jobs.push(
      fetchJson(lib.remoteManifestUrl(REMOTE, mod.source)).then((manifest) => {
        if (lib.compareVersions(manifest.version, mod.version) > 0) value.mods[mod.id] = String(manifest.version);
      }),
    );
  }
  await Promise.all(jobs.map((job) => job.catch(() => {})));
  updatesCache = { time: Date.now(), value };
  return value;
}

handle('check-updates', () => checkUpdates());

handle('marketplace', (_event, query) => marketplace(typeof query === 'string' ? query.slice(0, 100) : ''));

handle('install', async (event, spec) => {
  if (!lib.isInstallSpec(spec)) throw new Error(`invalid mod source "${spec}"`);
  let registry = null;
  try {
    registry = await getRegistry();
  } catch {
    // Unknown registry: the confirmation below still protects the user.
  }
  if (!lib.isOfficialSpec(spec, registry) && !(await confirmInstall(event, spec))) {
    return { ok: false, cancelled: true, output: 'Installation cancelled.' };
  }
  return runCli(['install', spec, '-y', '--remote']);
});

handle('update', async (_event, id) => {
  if (id != null) assertModId(id);
  const result = await runCli(id == null ? ['update'] : ['update', id]);
  updatesCache = null;
  return result;
});

// The upgrade re-patches and restarts Deezer, so it must outlive this process.
handle('upgrade', () => {
  log('upgrading Deezer Eagle from the library');
  startDetached(['upgrade'], 'upgrade.log');
});

// ---- Deezer updates -------------------------------------------------------------

// A Deezer update replaces app.asar and so removes Eagle. When one is waiting
// to be installed on quit, start a watcher that patches Deezer again after it.
function scheduleReapplyAfterUpdate() {
  try {
    const pkg = lib.readJson(path.join(app.getAppPath(), 'package.json'), {});
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const pending = lib.pendingUpdateDir(process.resourcesPath, pkg.name || app.getName(), localAppData);
    if (!lib.hasPendingUpdate(pending)) return;
    log('a Deezer update is about to be installed, Eagle will patch it again afterwards');
    startDetached(['reapply-after-update'], 'update-watcher.log');
    log('post-update watcher started');
  } catch (err) {
    log('could not schedule the post-update patch:', err && err.message);
  }
}

// ---- Wiring ---------------------------------------------------------------------

app.on('session-created', hookSession);
app.once('ready', () => hookSession(session.defaultSession));
app.on('will-quit', scheduleReapplyAfterUpdate);

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
