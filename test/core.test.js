'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const lib = require('../src/core/lib');

function makeHome(mods, config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-test-'));
  fs.mkdirSync(path.join(home, 'core'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../src/core/client.js'), path.join(home, 'core/client.js'));
  for (const [id, files] of Object.entries(mods)) {
    const dir = path.join(home, 'mods', id);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
    }
  }
  if (config) fs.writeFileSync(path.join(home, 'config.json'), '\uFEFF' + JSON.stringify(config));
  return home;
}

test('loadState reads mods, skips invalid ids and honours disabled (config with BOM)', () => {
  const home = makeHome(
    {
      alpha: { 'manifest.json': { id: 'alpha', name: 'Alpha', version: '1.0.0', network: { block: ['ads.example'] } } },
      beta: { 'manifest.json': { id: 'beta', name: 'Beta', version: '1.0.0', network: { block: ['beta.example'] } } },
      'Bad Name': { 'manifest.json': { id: 'bad', name: 'Bad', version: '1' } },
      broken: { 'manifest.json': '{ not json' },
    },
    { disabled: ['beta'] },
  );
  const state = lib.loadState(home);
  assert.deepEqual(
    state.mods.map((mod) => [mod.id, mod.enabled]),
    [
      ['alpha', true],
      ['beta', false],
    ],
  );
  assert.ok(lib.isBlocked(state.rules, 'https://ads.example/x'));
  assert.ok(!lib.isBlocked(state.rules, 'https://beta.example/x'), 'disabled mods do not block');
});

test('loadState tolerates a missing home', () => {
  const state = lib.loadState(path.join(os.tmpdir(), 'eagle-does-not-exist'));
  assert.deepEqual(state.mods, []);
});

test('domain rules match the domain and its subdomains only', () => {
  const rules = lib.compileRules([{ manifest: { network: { block: ['doubleclick.net', ' .Criteo.com. '] } } }]);
  assert.ok(lib.isBlocked(rules, 'https://doubleclick.net/'));
  assert.ok(lib.isBlocked(rules, 'https://ad.g.doubleclick.net/pagead?x=1'));
  assert.ok(lib.isBlocked(rules, 'wss://static.criteo.com/socket'));
  assert.ok(!lib.isBlocked(rules, 'https://notdoubleclick.net/'));
  assert.ok(!lib.isBlocked(rules, 'https://www.deezer.com/doubleclick.net'));
  assert.ok(!lib.isBlocked(rules, 'not a url'));
});

test('glob rules match the full URL', () => {
  const rules = lib.compileRules([{ manifest: { network: { block: ['*://*.deezer.com/ads/*'] } } }]);
  assert.ok(lib.isBlocked(rules, 'https://www.deezer.com/ads/banner.js'));
  assert.ok(!lib.isBlocked(rules, 'https://www.deezer.com/fr/album/1'));
});

test('match patterns follow Chromium semantics', () => {
  const re = (pattern) => lib.matchPatternToRegExp(pattern);
  assert.ok(re('<all_urls>').test('https://anything/'));
  assert.ok(re('*://*.deezer.com/*').test('https://www.deezer.com/fr/'));
  assert.ok(re('*://*.deezer.com/*').test('https://deezer.com/'));
  assert.ok(re('*://*.deezer.com/*').test('http://deezer.com:8080/x'));
  assert.ok(!re('*://*.deezer.com/*').test('https://evildeezer.com/'));
  assert.ok(!re('*://*.deezer.com/*').test('file:///deezer.com/'));
  assert.ok(re('https://api.deezer.com/user/*').test('https://api.deezer.com/user/me?x=1'));
  assert.ok(!re('https://api.deezer.com/user/*').test('https://api.deezer.com/track/1'));
  assert.equal(re('garbage'), null);
});

test('compileFilter handles urls, excludeUrls and types', () => {
  const matches = lib.compileFilter({ urls: ['*://*.deezer.com/*'], excludeUrls: ['*://*.deezer.com/skip/*'], types: ['xhr'] });
  assert.ok(matches({ url: 'https://www.deezer.com/a', resourceType: 'xhr' }));
  assert.ok(!matches({ url: 'https://www.deezer.com/a', resourceType: 'image' }));
  assert.ok(!matches({ url: 'https://www.deezer.com/skip/a', resourceType: 'xhr' }));
  assert.ok(!matches({ url: 'https://example.com/a', resourceType: 'xhr' }));
  assert.ok(lib.compileFilter(null)({ url: 'https://x/', resourceType: 'xhr' }));
  assert.ok(lib.compileFilter({ urls: [] })({ url: 'https://x/', resourceType: 'xhr' }));
});

test('chainBeforeRequest keeps blocking while forwarding to the app listener', () => {
  let registered = null;
  const webRequest = {
    onBeforeRequest(filter, listener) {
      registered = listener || filter;
    },
  };
  lib.chainBeforeRequest(webRequest, (details) => details.url.includes('ads'));
  const run = (url) => {
    let result;
    registered({ url, resourceType: 'xhr' }, (response) => (result = response));
    return result;
  };

  assert.deepEqual(run('https://ads.example/'), { cancel: true });
  assert.deepEqual(run('https://www.deezer.com/'), {});

  webRequest.onBeforeRequest({ urls: ['*://www.deezer.com/*'] }, (details, callback) => callback({ redirectURL: 'https://x/' }));
  assert.deepEqual(run('https://www.deezer.com/'), { redirectURL: 'https://x/' });
  assert.deepEqual(run('https://other.example/'), {}, 'outside the app filter');
  assert.deepEqual(run('https://ads.example/'), { cancel: true }, 'block still wins');

  webRequest.onBeforeRequest((details, callback) => callback({ cancel: false, tag: 1 }));
  assert.deepEqual(run('https://other.example/'), { cancel: false, tag: 1 }, 'listener without filter');

  webRequest.onBeforeRequest(null);
  assert.deepEqual(run('https://www.deezer.com/'), {}, 'listener removed');
});

test('resolveInside refuses paths outside the mod folder', () => {
  const dir = path.join(os.tmpdir(), 'mod');
  assert.equal(lib.resolveInside(dir, 'mod.js'), path.join(dir, 'mod.js'));
  assert.equal(lib.resolveInside(dir, 'lib/x.css'), path.join(dir, 'lib/x.css'));
  assert.throws(() => lib.resolveInside(dir, '../config.json'));
  assert.throws(() => lib.resolveInside(dir, path.join(os.tmpdir(), 'secret.txt')));
  assert.throws(() => lib.resolveInside(dir, '.'));
  assert.throws(() => lib.resolveInside(dir, 42));
});

test('buildScripts wraps each enabled mod and reports broken ones', () => {
  const home = makeHome(
    {
      good: {
        'manifest.json': { id: 'good', name: 'Good', version: '1.0.0', main: 'mod.js', styles: ['a.css', 'b.css'] },
        'mod.js': 'mod.log("hi") // no trailing newline',
        'a.css': '.a{}',
        'b.css': '.b{}',
      },
      escape: { 'manifest.json': { id: 'escape', name: 'Escape', version: '1.0.0', main: '../../config.json' } },
      off: { 'manifest.json': { id: 'off', name: 'Off', version: '1.0.0', main: 'missing.js' } },
    },
    { disabled: ['off'] },
  );
  fs.writeFileSync(path.join(home, 'user.css'), 'body{}');
  const scripts = lib.buildScripts(home, lib.loadState(home), '1.2.3');

  assert.deepEqual(
    scripts.map((script) => script.id),
    [null, 'escape', 'good', null],
  );
  assert.match(scripts[0].code, /"version":"1\.2\.3"/);
  assert.match(scripts[1].code, /__fail\("escape", ".*outside the mod folder"\)/);
  assert.match(scripts[2].code, /__load\("good", "\.a\{\}\\n\.b\{\}", function \(Eagle, mod\) \{mod\.log/);
  assert.match(scripts[3].code, /__userStyle\("body\{\}"\)/);
  for (const script of scripts) new vm.Script(script.code); // every script parses
});

test('buildScripts reports syntax errors with the line of the mod file', () => {
  const home = makeHome({
    typo: {
      'manifest.json': { id: 'typo', name: 'Typo', version: '1.0.0', main: 'mod.js' },
      'mod.js': 'const ok = 1;\nconst broken = (;\n',
    },
  });
  const [, script] = lib.buildScripts(home, lib.loadState(home), '1.0.0');
  assert.equal(script.id, 'typo');
  assert.match(script.code, /__fail\("typo", "SyntaxError: .* \(mod\.js, line 2\)"\)/);
});

test('buildScripts runs mods against the client runtime', () => {
  const home = makeHome({
    demo: {
      'manifest.json': { id: 'demo', name: 'Demo', version: '2.0.0', main: 'mod.js' },
      'mod.js': 'window.ran = [mod.id, mod.version, typeof Eagle.observe];',
    },
    crash: {
      'manifest.json': { id: 'crash', name: 'Crash', version: '1.0.0', main: 'mod.js' },
      'mod.js': 'throw new Error("boom");',
    },
  });
  const notifications = [];
  const window = {
    addEventListener() {},
    console: { log() {}, warn() {}, error() {} },
  };
  window.window = window;
  window.history = { pushState() {}, replaceState() {} };
  window.location = { href: 'https://www.deezer.com/' };
  window.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  window.document = {
    addEventListener() {},
    adoptedStyleSheets: [],
    documentElement: { append() {} },
    createElement: () => ({
      attachShadow: () => ({ append() {}, adoptedStyleSheets: [] }),
      append(child) {
        notifications.push(child.textContent);
      },
      isConnected: true,
    }),
  };
  window.CSSStyleSheet = class {
    replaceSync(css) {
      this.css = css;
    }
  };
  window.setTimeout = () => 0;
  window.setInterval = () => 0;
  window.getComputedStyle = () => ({ length: 0 });
  window.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  window.document.styleSheets = [];
  window.document.querySelector = () => null;
  window.document.querySelectorAll = () => [];
  const context = vm.createContext(window);
  for (const script of lib.buildScripts(home, lib.loadState(home), '1.0.0')) {
    vm.runInContext(script.code, context);
  }
  assert.deepEqual(Array.from(window.ran), ['demo', '2.0.0', 'function']);
  const statuses = Object.fromEntries(vm.runInContext('Eagle.mods', context).map((mod) => [mod.id, mod.status]));
  assert.deepEqual(statuses, { crash: 'error', demo: 'ok' });
  assert.ok(notifications.some((text) => /Crash/.test(text)), 'a crashing mod shows a toast');
});

test('built-in mods have valid manifests and registry entries', () => {
  const root = path.join(__dirname, '..');
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'registry.json'), 'utf8'));
  const ids = new Set();
  for (const entry of registry.mods) {
    assert.ok(lib.MOD_ID.test(entry.id), entry.id);
    assert.ok(!ids.has(entry.id), `duplicate ${entry.id}`);
    ids.add(entry.id);
    assert.match(entry.repo, /^[\w.-]+\/[\w.-]+$/);
    if (entry.repo !== 'Snoxy008/Deezer-Eagle') continue;
    const dir = path.join(root, entry.path);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.id, entry.id);
    assert.ok(manifest.name && manifest.version);
    assert.equal(manifest.type === 'theme', entry.type === 'theme', `${entry.id}: registry and manifest agree on the type`);
    if (manifest.type === 'theme') {
      assert.deepEqual(lib.themeColors(manifest.colors), manifest.colors, `${entry.id}: every colour is valid`);
      for (const key of ['background', 'text', 'accent']) assert.ok(manifest.colors[key], `${entry.id}: ${key}`);
    }
    for (const file of [manifest.main, ...(manifest.styles || [])].filter(Boolean)) {
      assert.ok(fs.existsSync(lib.resolveInside(dir, file)), `${entry.id}: ${file}`);
    }
  }
});

test('isAppUrl accepts Deezer pages only', () => {
  assert.ok(lib.isAppUrl('file:///C:/Program%20Files/Deezer/resources/_app.asar/build/index.html'));
  assert.ok(lib.isAppUrl('https://www.deezer.com/fr/'));
  assert.ok(lib.isAppUrl('https://deezer.com/'));
  assert.ok(!lib.isAppUrl('https://accounts.google.com/o/oauth2'));
  assert.ok(!lib.isAppUrl('https://evil-deezer.com/'));
  assert.ok(!lib.isAppUrl('devtools://devtools/bundled/inspector.html'));
  assert.ok(!lib.isAppUrl('about:blank'));
  assert.ok(!lib.isAppUrl('data:text/html,hi'));
  assert.ok(!lib.isAppUrl('not a url'));
});

test('listMods, setModEnabled and removeMod manage mods on disk', () => {
  const home = makeHome({
    alpha: {
      'manifest.json': { id: 'alpha', name: 'Alpha', version: '1.0.0', author: 'me' },
      '.eagle-source.json': { type: 'github', repo: 'Snoxy008/Deezer-Eagle', path: 'mods/alpha' },
    },
  });
  const devSources = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-dev-'));
  fs.writeFileSync(path.join(devSources, 'manifest.json'), JSON.stringify({ id: 'dev', name: 'Dev', version: '0.1.0' }));
  fs.symlinkSync(devSources, path.join(home, 'mods', 'dev'), 'junction');

  const byId = () => Object.fromEntries(lib.listMods(home).map((mod) => [mod.id, mod]));
  assert.equal(byId().alpha.source.repo, 'Snoxy008/Deezer-Eagle');
  assert.equal(byId().alpha.linked, false);
  assert.equal(byId().dev.linked, true);
  assert.equal(byId().dev.source, null);

  lib.setModEnabled(home, 'alpha', false);
  lib.setModEnabled(home, 'alpha', false);
  assert.deepEqual(lib.readJson(path.join(home, 'config.json')).disabled, ['alpha']);
  assert.equal(byId().alpha.enabled, false);
  lib.setModEnabled(home, 'alpha', true);
  assert.equal(byId().alpha.enabled, true);

  lib.removeMod(home, 'dev');
  assert.ok(fs.existsSync(path.join(devSources, 'manifest.json')), 'a linked mod keeps its sources');
  lib.setModEnabled(home, 'alpha', false);
  lib.removeMod(home, 'alpha');
  assert.deepEqual(Object.keys(byId()), []);
  assert.deepEqual(lib.readJson(path.join(home, 'config.json')).disabled, [], 'removed mods leave the disabled list');
  assert.throws(() => lib.removeMod(home, '../config.json'));
});

test('install specs from the page are restricted to the registry and GitHub', () => {
  for (const spec of ['copy-link', 'someone/repo', 'someone/repo/themes/dark', 'someone/repo@v1.2', 'some-one/re_po/x@feature/y']) {
    assert.ok(lib.isInstallSpec(spec), spec);
  }
  for (const spec of ['C:\\Windows', '/etc', './mod', 'someone/../etc', 'https://evil.example/x', '', 42, 'a b']) {
    assert.ok(!lib.isInstallSpec(spec), String(spec));
  }
  const registry = { mods: [{ id: 'adblock', repo: 'Snoxy008/Deezer-Eagle' }, { id: 'theme', repo: 'someone/theme' }] };
  assert.ok(lib.isOfficialSpec('adblock', registry));
  assert.ok(lib.isOfficialSpec('Snoxy008/Deezer-Eagle/mods/copy-link', null));
  assert.ok(!lib.isOfficialSpec('theme', registry), 'registry entries from other repos are not official');
  assert.ok(!lib.isOfficialSpec('someone/repo', registry));
  assert.ok(!lib.isOfficialSpec('snoxy008/deezer-eagle-fork/x', registry));
});

test('pending Deezer updates are found in the electron-updater cache', () => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-res-'));
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'eagle-local-'));
  assert.equal(lib.pendingUpdateDir(resources, 'Deezer-Desktop', local), path.join(local, 'deezer-desktop-updater', 'pending'));
  fs.writeFileSync(path.join(resources, 'app-update.yml'), 'provider: generic\nupdaterCacheDirName: custom-updater\r\n');
  const pending = lib.pendingUpdateDir(resources, 'deezer-desktop', local);
  assert.equal(pending, path.join(local, 'custom-updater', 'pending'));
  assert.ok(!lib.hasPendingUpdate(pending));
  fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(path.join(pending, 'update-info.json'), '{}');
  assert.ok(!lib.hasPendingUpdate(pending), 'no installer yet');
  fs.writeFileSync(path.join(pending, 'DeezerDesktopSetup_7.1.341.exe'), '');
  assert.ok(lib.hasPendingUpdate(pending));
});

test('themes and CSS-only mods reach the page as data, not as scripts', () => {
  const home = makeHome(
    {
      nord: {
        'manifest.json': {
          id: 'nord',
          type: 'theme',
          name: 'Nord',
          version: '1.0.0',
          dark: true,
          colors: { background: '#2e3440', accent: 'rgb(136, 192, 208)', text: 'red; } body { display: none' },
          styles: ['extra.css'],
        },
        'extra.css': '.extra{}',
      },
      sober: { 'manifest.json': { id: 'sober', type: 'theme', name: 'Sober', version: '1.0.0', network: { block: ['theme.example'] } } },
      plain: { 'manifest.json': { id: 'plain', name: 'Plain', version: '1.0.0', styles: ['a.css'], network: { block: ['css.example'] } }, 'a.css': '.a{}' },
      scripted: {
        'manifest.json': {
          id: 'scripted',
          name: 'Scripted',
          version: '1.0.0',
          main: 'mod.js',
          settings: [
            { key: 'step', type: 'number', label: 'Step', default: 5, min: 1 },
            { key: 'mode', type: 'select', default: 'a', options: [{ value: 'a', label: 'A' }, { value: {} }, 'b'] },
            { key: 'bad key', type: 'number' },
            { key: 'kind', type: 'unknown' },
          ],
        },
        'mod.js': '',
      },
    },
    { theme: 'nord' },
  );
  const state = lib.loadState(home);
  assert.equal(state.theme, 'nord');
  assert.ok(lib.isBlocked(state.rules, 'https://css.example/'));
  assert.ok(!lib.isBlocked(state.rules, 'https://theme.example/'), 'themes cannot block requests');

  const scripts = lib.buildScripts(home, state, '1.0.0');
  assert.deepEqual(scripts.map((script) => script.id), [null, 'scripted'], 'only mods with a script get one');
  const boot = JSON.parse(/window.__EAGLE_BOOT__ = (.*);\n/.exec(scripts[0].code)[1]);
  assert.equal(boot.theme, 'nord');
  assert.deepEqual(boot.themes.map((theme) => theme.id), ['nord', 'sober']);
  assert.deepEqual(boot.themes[0].colors, { background: '#2e3440', accent: 'rgb(136, 192, 208)' }, 'unsafe colours are dropped');
  assert.equal(boot.themes[0].css, '.extra{}');
  assert.equal(boot.themes[0].dark, true);
  const plain = boot.mods.find((mod) => mod.id === 'plain');
  assert.deepEqual([plain.css, plain.hasScript, plain.type], ['.a{}', false, 'mod']);
  const scripted = boot.mods.find((mod) => mod.id === 'scripted');
  assert.equal(scripted.css, undefined);
  assert.deepEqual(scripted.settings.map((setting) => setting.key), ['step', 'mode']);
  assert.deepEqual([scripted.settings[0].min, scripted.settings[0].max], [1, null]);
  assert.deepEqual(scripted.settings[1].options, [{ value: 'a', label: 'A' }]);
  assert.equal(scripted.settings[1].label, 'mode', 'the key is the default label');
});

test('the selected theme survives only while it is installed', () => {
  const home = makeHome({ nord: { 'manifest.json': { id: 'nord', type: 'theme', name: 'Nord', version: '1.0.0' } } }, { theme: 'gone' });
  assert.equal(lib.loadState(home).theme, null, 'unknown theme: Deezer colours');
  lib.setTheme(home, 'nord');
  assert.equal(lib.loadState(home).theme, 'nord');
  lib.removeMod(home, 'nord');
  assert.equal(lib.readJson(path.join(home, 'config.json')).theme, null, 'removing the theme resets it');
});

test('versions compare numerically and updates are read from raw manifests', () => {
  assert.equal(lib.compareVersions('1.10.0', '1.9.2'), 1);
  assert.equal(lib.compareVersions('2.0.0', '10.0.0'), -1);
  assert.equal(lib.compareVersions('1.0', '1.0.0'), 0);
  assert.equal(lib.compareVersions('1.2.0-beta', '1.2.0'), 0);
  assert.equal(lib.compareVersions(undefined, '0.0.1'), -1);
  assert.equal(
    lib.remoteManifestUrl('https://raw.githubusercontent.com', { repo: 'someone/mods', path: '/themes/dark/', ref: '' }),
    'https://raw.githubusercontent.com/someone/mods/HEAD/themes/dark/manifest.json',
  );
  assert.equal(lib.remoteManifestUrl('http://raw.test', { repo: 'a/b', ref: 'v1' }), 'http://raw.test/a/b/v1/manifest.json');
});
