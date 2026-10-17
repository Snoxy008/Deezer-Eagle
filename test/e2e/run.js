'use strict';
// End-to-end test. Builds a fake Deezer install (Electron + a stand-in app
// shaped like Deezer Desktop, packed as resources/app.asar), installs Deezer
// Eagle into it with the real CLI and launches it: mods must be injected, the
// Eagle library must work from the sidebar, a pending Deezer update must be
// patched again automatically, and `eagle restore` must give back the
// original archive.
//
// Requirements: `npm install` in test/e2e, PowerShell (pwsh, or set $PWSH),
// network access to GitHub (the marketplace installs a real mod), and on
// Linux a display or xvfb-run. $E2E_ELECTRON runs another Electron binary.

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const asar = require('@electron/asar');

const electronBinary = process.env.E2E_ELECTRON || require('electron');
const root = path.resolve(__dirname, '../..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-e2e-'));
const deezerDir = path.join(work, 'deezer');
const home = path.join(work, 'home');
const resources = path.join(deezerDir, 'resources');
const pristine = path.join(work, 'app.asar');
const localAppData = path.join(work, 'localappdata');
const shell = process.env.PWSH || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');
const env = {
  ...process.env,
  DEEZER_EAGLE_HOME: home,
  DEEZER_EAGLE_DEEZER_PATH: deezerDir,
  DEEZER_EAGLE_REGISTRY: path.join(root, 'registry.json'),
  LOCALAPPDATA: localAppData,
};
delete env.ELECTRON_RUN_AS_NODE;

function powershell(script, ...args) {
  execFileSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { env, stdio: 'inherit' });
}

function eagle(...args) {
  powershell(path.join(home, 'cli', 'eagle.ps1'), ...args);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// @electron/asar caches headers by path: drop it, the file may have been replaced.
function isStub(file) {
  asar.uncache(file);
  return asar.listPackage(file).some((entry) => entry.replace(/^[\\/]/, '') === 'eagle.json');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let launches = 0;

function launch(mode) {
  const resultFile = path.join(work, `result-${++launches}.json`);
  const exe = path.join(deezerDir, path.basename(electronBinary));
  const runEnv = {
    ...env,
    E2E_RESULT: resultFile,
    E2E_DRIVER: path.join(__dirname, 'driver.js'),
    E2E_MODE: mode,
    E2E_PORT: String(20000 + Math.floor(Math.random() * 20000)),
  };
  const [command, args] =
    process.platform === 'linux' && !process.env.DISPLAY ? ['xvfb-run', ['-a', exe, '--no-sandbox']] : [exe, ['--no-sandbox']];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: runEnv, stdio: 'inherit' });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('the fake Deezer did not finish within 180s'));
    }, 180000);
    child.on('error', reject);
    child.on('exit', () => {
      clearTimeout(timer);
      const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      console.log(`--- launch ${launches} (${mode}) ---\n${JSON.stringify(result, null, 2)}`);
      resolve(result);
    });
  });
}

async function main() {
  console.log(`work dir: ${work}`);
  fs.cpSync(path.dirname(electronBinary), deezerDir, { recursive: true, verbatimSymlinks: true });
  fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });
  // createPackage resolves before its write stream closes; a child process exits only once it has.
  execFileSync(process.execPath, ['-e', 'require("@electron/asar").createPackage(process.argv[1], process.argv[2])', path.join(__dirname, 'fake-deezer'), pristine], { cwd: __dirname });
  fs.copyFileSync(pristine, path.join(resources, 'app.asar'));
  const originalHash = sha256(pristine);

  powershell(path.join(root, 'src/cli/eagle.ps1'), 'setup', root);
  eagle('install', path.join(__dirname, 'fixture-mod'), path.join(__dirname, 'broken-mod'), '-y');
  fs.writeFileSync(path.join(home, 'user.css'), '#probe { background-color: rgb(4, 5, 6); }');
  assert.ok(isStub(path.join(resources, 'app.asar')), 'stub in place');
  assert.equal(sha256(path.join(resources, '_app.asar')), originalHash, 'original archive kept intact');

  // 1. Everything a user does in one session.
  const first = await launch('full');
  const { page } = first;
  assert.equal(first.name, 'Deezer E2E', 'app name preserved');
  assert.equal(first.version, '7.1.340', 'app version preserved');
  assert.equal(first.appPath, path.join(resources, '_app.asar'), 'app path points to the original archive');
  assert.equal(path.basename(first.userData), 'Deezer E2E', 'user data folder unchanged');

  assert.equal(page.eagle, 'object', 'Eagle runtime injected into the local index.html');
  assert.equal(page.bridge, 'object', 'library bridge exposed');
  assert.deepEqual(page.mods, ['adblock:ok', 'e2e-broken:error', 'e2e-mod:ok', 'no-tracking:ok']);
  assert.equal(page.modRan, 'e2e-mod:function:function', 'mod script ran with the API');
  assert.equal(page.probeColor, 'rgb(1, 2, 3)', 'mod CSS applied despite the CSP');
  assert.equal(page.probeBackground, 'rgb(4, 5, 6)', 'user.css applied');
  assert.equal(page.adblock, 'blocked', 'adblock blocks ad servers');
  assert.equal(page.modBlock, 'blocked', 'mod network rule applied');
  assert.equal(page.allowed, 'ok', 'other requests go through');
  assert.equal(page.appHook, 'blocked', "the app's own webRequest listener still runs");
  assert.ok(first.appListenerCalls >= 1, "the app's listener was called");
  assert.ok(!first.hits.some((hit) => /doubleclick|e2e-blocked/.test(hit)), 'blocked requests never reached the network');

  assert.deepEqual(page.sidebar, { text: 'Eagle', index: 2, rowClass: 'nav-row', icon: true, href: false }, 'Eagle sidebar entry');
  assert.ok(page.sidebarRestored, 'sidebar entry comes back after a re-render');
  assert.ok(page.libraryOpened, 'library opens from the sidebar');
  assert.deepEqual(page.installedCards, ['adblock', 'e2e-broken', 'e2e-mod', 'no-tracking']);
  assert.deepEqual(page.libraryBox, page.contentBox, 'library covers the content area only');
  assert.equal(page.libraryBox.left, 243, 'library leaves the sidebar visible');
  assert.equal(page.libraryBackground, 'rgb(253, 252, 254)', "library uses Deezer's theme colours");
  assert.match(page.brokenError, /SyntaxError.*line 1/, 'library shows why a mod failed');
  assert.ok(page.switchedOff && page.reloadNotice, 'mod switched off from the library');
  assert.ok(page.marketplace.includes('copy-link'), 'marketplace lists the registry');
  assert.equal(page.installButton, 'Install');
  assert.ok(page.installedFromMarketplace, 'official mod installed from the marketplace');
  assert.deepEqual(page.communityInstall, { ok: false, cancelled: true, output: 'Installation cancelled.' }, 'other mods need confirmation');
  assert.deepEqual(first.dialogs, ['Install the mod "someone/not-official"?'], 'native confirmation shown once');
  assert.equal(page.localInstall, 'refused', 'the page cannot install local folders');
  assert.equal(page.iframeBridge, 'undefined', 'iframes do not get the bridge');
  assert.deepEqual(page.afterRemove, ['adblock:true', 'copy-link:true', 'e2e-mod:false', 'no-tracking:true'], 'mod removed from the library');
  assert.ok(page.closedByEscape, 'Escape closes the library');
  assert.equal(page.navigated, '#album/1', 'onNavigate fires on pushState');

  // 2. The library changes are on disk and apply on the next start.
  const second = await launch('basic');
  assert.deepEqual(second.page.mods, ['adblock:ok', 'copy-link:ok', 'e2e-mod:disabled', 'no-tracking:ok']);
  assert.equal(second.page.modRan, '', 'disabled mod does not run');
  assert.equal(second.page.modBlock, 'ok', 'disabled mod rules are lifted');
  assert.equal(second.page.adblock, 'blocked', 'other mods still active');

  // 3. Without Eagle's files Deezer still starts, untouched.
  const core = path.join(home, 'core');
  fs.renameSync(core, `${core}.off`);
  const third = await launch('basic');
  fs.renameSync(`${core}.off`, core);
  assert.equal(third.name, 'Deezer E2E', 'Deezer starts even if Eagle is missing');
  assert.equal(third.page.eagle, 'undefined', 'no injection without the core');

  // 4. A Deezer update pending on quit: once the installer replaces app.asar,
  //    Eagle patches it again by itself.
  const pending = path.join(localAppData, 'deezer-desktop-updater', 'pending');
  fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(path.join(pending, 'DeezerDesktopSetup_7.1.341.exe'), 'installer');
  await launch('basic');
  fs.rmSync(path.join(resources, 'app.asar'));
  await sleep(1000);
  fs.copyFileSync(pristine, path.join(resources, 'app.asar'));
  assert.ok(!isStub(path.join(resources, 'app.asar')), 'update simulated');
  let repatched = false;
  for (let i = 0; i < 60 && !repatched; i++) {
    await sleep(1000);
    repatched = isStub(path.join(resources, 'app.asar'));
  }
  const readLog = (name) => (fs.existsSync(path.join(home, 'logs', name)) ? fs.readFileSync(path.join(home, 'logs', name), 'utf8') : `(no ${name})`);
  const updateLog = readLog('update.log');
  console.log(`${readLog('main.log')}\n${readLog('update-watcher.log')}\n${updateLog}`);
  assert.ok(repatched, 'Deezer patched again after its update');
  assert.equal(sha256(path.join(resources, '_app.asar')), originalHash, 'the updated archive became the original');
  assert.match(updateLog, /patched again/);
  fs.rmSync(pending, { recursive: true });

  eagle('restore');
  assert.equal(sha256(path.join(resources, 'app.asar')), originalHash, 'restore gives back the original archive');
  assert.ok(!fs.existsSync(path.join(resources, '_app.asar')), 'no leftover backup');

  fs.rmSync(work, { recursive: true, force: true });
  console.log('\nE2E OK');
}

main().catch((err) => {
  console.error(err);
  console.error(`\nE2E FAILED (work dir kept: ${work})`);
  process.exit(1);
});
