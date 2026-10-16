'use strict';
// End-to-end test. Builds a fake Deezer install (Electron + a stand-in app
// packed as resources/app.asar), installs Deezer Eagle into it with the real
// CLI, launches it and checks that mods are injected, network rules apply and
// `eagle restore` gives back the original archive.
//
// Requirements: `npm install` in test/e2e, PowerShell (pwsh, or set $PWSH),
// and on Linux a display or xvfb-run.

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const asar = require('@electron/asar');
const electronBinary = require('electron');

const root = path.resolve(__dirname, '../..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-e2e-'));
const deezerDir = path.join(work, 'deezer');
const home = path.join(work, 'home');
const resources = path.join(deezerDir, 'resources');
const shell = process.env.PWSH || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');
const env = {
  ...process.env,
  DEEZER_EAGLE_HOME: home,
  DEEZER_EAGLE_DEEZER_PATH: deezerDir,
  DEEZER_EAGLE_REGISTRY: path.join(root, 'registry.json'),
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

function launch(resultFile) {
  const exe = path.join(deezerDir, path.basename(electronBinary));
  const runEnv = { ...env, E2E_RESULT: resultFile, E2E_PORT: String(20000 + Math.floor(Math.random() * 20000)) };
  const [command, args] =
    process.platform === 'linux' && !process.env.DISPLAY ? ['xvfb-run', ['-a', exe, '--no-sandbox']] : [exe, ['--no-sandbox']];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: runEnv, stdio: 'inherit' });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('the fake Deezer did not finish within 90s'));
    }, 90000);
    child.on('error', reject);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(JSON.parse(fs.readFileSync(resultFile, 'utf8')));
    });
  });
}

async function main() {
  console.log(`work dir: ${work}`);
  fs.cpSync(path.dirname(electronBinary), deezerDir, { recursive: true, verbatimSymlinks: true });
  fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });
  // createPackage resolves before its write stream closes; a child process exits only once it has.
  execFileSync(process.execPath, ['-e', 'require("@electron/asar").createPackage(process.argv[1], process.argv[2])', path.join(__dirname, 'fake-deezer'), path.join(resources, 'app.asar')], { cwd: __dirname });
  const originalHash = sha256(path.join(resources, 'app.asar'));

  powershell(path.join(root, 'src/cli/eagle.ps1'), 'setup', root);
  eagle('install', path.join(__dirname, 'fixture-mod'), path.join(__dirname, 'broken-mod'), '-y');
  fs.writeFileSync(path.join(home, 'user.css'), '#probe { background-color: rgb(4, 5, 6); }');

  assert.ok(asar.listPackage(path.join(resources, 'app.asar')).some((file) => file.endsWith('eagle.json')), 'stub in place');
  assert.equal(sha256(path.join(resources, '_app.asar')), originalHash, 'original archive kept intact');

  const result = await launch(path.join(work, 'result.json'));
  console.log(JSON.stringify(result, null, 2));
  const { page } = result;

  assert.equal(result.name, 'Deezer E2E', 'app name preserved');
  assert.equal(result.version, '7.0.0', 'app version preserved');
  assert.equal(result.appPath, path.join(resources, '_app.asar'), 'app path points to the original archive');
  assert.equal(path.basename(result.userData), 'Deezer E2E', 'user data folder unchanged');

  assert.ok(page, 'the page reported back');
  assert.equal(page.eagle, 'object', 'Eagle runtime injected');
  assert.deepEqual(page.mods.sort(), ['adblock:ok', 'e2e-broken:error', 'e2e-mod:ok', 'no-tracking:ok']);
  assert.equal(page.modRan, 'e2e-mod:function:function', 'mod script ran with the API');
  assert.equal(page.navigated, '/fr/album/1', 'onNavigate fires on pushState');
  assert.equal(page.probeColor, 'rgb(1, 2, 3)', 'mod CSS applied despite the CSP');
  assert.equal(page.probeBackground, 'rgb(4, 5, 6)', 'user.css applied');
  assert.match(page.panel, /E2E Mod.*active/s, 'Ctrl+Shift+E panel lists mods');
  assert.match(page.panel, /E2E Broken.*error.*SyntaxError.*line 1/s, 'panel shows why the broken mod failed');

  assert.equal(page.adblock, 'blocked', 'adblock blocks ad servers');
  assert.equal(page.modBlock, 'blocked', 'mod network rule applied');
  assert.equal(page.allowed, 'ok', 'other requests go through');
  assert.equal(page.appHook, 'blocked', "the app's own webRequest listener still runs");
  assert.ok(result.appListenerCalls >= 1, "the app's listener was called");
  assert.ok(!result.hits.some((hit) => /doubleclick|e2e-blocked/.test(hit)), 'blocked requests never reached the network');

  eagle('disable', 'e2e-mod');
  const second = await launch(path.join(work, 'result-2.json'));
  assert.equal(second.page.modRan, '', 'disabled mod does not run');
  assert.equal(second.page.modBlock, 'ok', 'disabled mod rules are lifted');
  assert.equal(second.page.adblock, 'blocked', 'other mods still active');

  const core = path.join(home, 'core');
  fs.renameSync(core, `${core}.off`);
  const third = await launch(path.join(work, 'result-3.json'));
  fs.renameSync(`${core}.off`, core);
  assert.equal(third.name, 'Deezer E2E', 'Deezer starts even if Eagle is missing');
  assert.equal(third.page.eagle, 'undefined', 'no injection without the core');

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
