'use strict';
// Pure helpers of the Deezer Eagle core. Nothing here requires `electron`,
// so the logic can be unit tested with plain Node.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MOD_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OFFICIAL_REPO = 'snoxy008/deezer-eagle';
const DEEZER_HOST = /(^|\.)deezer\.com$/i;
// What a page may ask to install: a registry id, or owner/repo[/path][@ref] on
// GitHub. Local folders stay CLI-only.
const INSTALL_SPEC = /^(?:[a-z0-9][a-z0-9_-]{0,63}|[A-Za-z0-9][\w-]*\/[\w.-]+(?:\/[\w./-]+)?(?:@[\w./-]+)?)$/;

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readText(file));
  } catch {
    return fallback;
  }
}

function toList(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Resolves a file referenced by a manifest, refusing anything outside the mod
// folder: mod code reaches the page, so it must never be able to read other files.
function resolveInside(dir, relative) {
  if (typeof relative !== 'string' || !relative) throw new Error('invalid file reference in manifest');
  const full = path.resolve(dir, relative);
  const rel = path.relative(dir, full);
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error(`"${relative}" points outside the mod folder`);
  }
  return full;
}

// Reads config.json and every mod installed in <home>/mods/<id>/.
function loadState(home) {
  const config = readJson(path.join(home, 'config.json'), null) || {};
  const disabled = new Set(toList(config.disabled));
  const modsDir = path.join(home, 'mods');
  let names = [];
  try {
    names = fs.readdirSync(modsDir).sort();
  } catch {
    // No mods folder yet.
  }
  const mods = [];
  for (const id of names) {
    if (!MOD_ID.test(id)) continue;
    const dir = path.join(modsDir, id);
    const manifest = readJson(path.join(dir, 'manifest.json'), null);
    if (!manifest || typeof manifest !== 'object') continue;
    mods.push({ id, dir, manifest, enabled: !disabled.has(id) });
  }
  return { config, mods, rules: compileRules(mods.filter((mod) => mod.enabled)) };
}

// A rule is either a bare domain ("doubleclick.net", also matches subdomains)
// or a URL glob where `*` matches anything ("*://*.example.com/ads/*").
function compileRules(mods) {
  const domains = new Set();
  const patterns = [];
  for (const mod of mods) {
    const network = mod.manifest.network || {};
    for (const rule of toList(network.block)) {
      if (typeof rule !== 'string' || !rule.trim()) continue;
      const value = rule.trim().toLowerCase();
      if (/[*/:]/.test(value)) {
        patterns.push(new RegExp(`^${value.split('*').map(escapeRegExp).join('.*')}$`, 'i'));
      } else {
        domains.add(value.replace(/^\.+|\.+$/g, ''));
      }
    }
  }
  return { domains, patterns };
}

function isBlocked(rules, url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  while (host) {
    if (rules.domains.has(host)) return true;
    const dot = host.indexOf('.');
    if (dot < 0) break;
    host = host.slice(dot + 1);
  }
  return rules.patterns.some((pattern) => pattern.test(url));
}

// Converts a Chromium match pattern ("*://*.deezer.com/*", "<all_urls>") to a RegExp.
function matchPatternToRegExp(pattern) {
  if (pattern === '<all_urls>') return /^/;
  const match = /^(\*|[a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(String(pattern));
  if (!match) return null;
  const [, scheme, host, pathname = '/*'] = match;
  let source = scheme === '*' ? '(?:https?|wss?)' : escapeRegExp(scheme);
  source += ':\\/\\/';
  if (host === '*') {
    source += '[^/]*';
  } else if (host.startsWith('*.')) {
    source += `(?:[^/]*\\.)?${escapeRegExp(host.slice(2))}(?::\\d+)?`;
  } else {
    source += escapeRegExp(host) + (host.includes(':') ? '' : '(?::\\d+)?');
  }
  source += pathname.split('*').map(escapeRegExp).join('.*');
  return new RegExp(`^${source}$`, 'i');
}

// Compiles an Electron WebRequestFilter ({ urls, excludeUrls, types }) to a predicate.
function compileFilter(filter) {
  if (!filter || typeof filter !== 'object') return () => true;
  const urls = toList(filter.urls).map(matchPatternToRegExp).filter(Boolean);
  const excluded = toList(filter.excludeUrls).map(matchPatternToRegExp).filter(Boolean);
  const types = toList(filter.types);
  return (details) =>
    (urls.length === 0 || urls.some((re) => re.test(details.url))) &&
    !excluded.some((re) => re.test(details.url)) &&
    (types.length === 0 || types.includes(details.resourceType));
}

// Electron keeps a single onBeforeRequest listener per session, so whoever
// registers last wins. Register ours, then replace the method so the listener
// Deezer registers later runs behind our block check instead of replacing it.
function chainBeforeRequest(webRequest, shouldBlock) {
  const register = webRequest.onBeforeRequest.bind(webRequest);
  let appListener = null;
  let appMatches = null;
  register((details, callback) => {
    if (shouldBlock(details)) return callback({ cancel: true });
    if (appListener && appMatches(details)) return appListener(details, callback);
    return callback({});
  });
  webRequest.onBeforeRequest = function onBeforeRequest(filter, listener) {
    if (arguments.length < 2) {
      listener = filter;
      filter = null;
    }
    appListener = typeof listener === 'function' ? listener : null;
    appMatches = compileFilter(filter);
  };
}

function text(value) {
  return typeof value === 'string' ? value : '';
}

function modInfo(mod) {
  const manifest = mod.manifest;
  return {
    id: mod.id,
    name: text(manifest.name) || mod.id,
    version: text(manifest.version),
    description: text(manifest.description),
    author: text(manifest.author),
    enabled: mod.enabled,
  };
}

function failScript(id, err) {
  const message = String((err && err.message) || err);
  return `window.Eagle && window.Eagle.__fail(${JSON.stringify(id)}, ${JSON.stringify(message)});\nvoid 0;`;
}

// Builds the scripts injected into a Deezer page, in order: the runtime, one
// script per enabled mod (so a syntax error only breaks that mod), then user.css.
function buildScripts(home, state, version) {
  const boot = { version, mods: state.mods.map(modInfo) };
  const client = readText(path.join(home, 'core', 'client.js'));
  const scripts = [
    {
      id: null,
      code: `window.__EAGLE_BOOT__ = ${JSON.stringify(boot)};\n${client}\nvoid 0;\n//# sourceURL=eagle://core/client.js`,
    },
  ];
  for (const mod of state.mods) {
    if (!mod.enabled) continue;
    try {
      const manifest = mod.manifest;
      const css = toList(manifest.styles)
        .map((file) => readText(resolveInside(mod.dir, file)))
        .join('\n');
      const js = manifest.main ? readText(resolveInside(mod.dir, manifest.main)) : '';
      const file = String(manifest.main || 'manifest.json').replace(/[^\w./-]/g, '_');
      const url = `eagle://mods/${mod.id}/${file}`;
      // The mod's first line shares the wrapper's line so error line numbers match its file.
      const code =
        `window.Eagle.__load(${JSON.stringify(mod.id)}, ${JSON.stringify(css)}, function (Eagle, mod) {${js}\n});\n` +
        `void 0;\n//# sourceURL=${url}`;
      // Chromium only says "Script failed to execute"; V8 here gives the real syntax error.
      try {
        new vm.Script(code, { filename: url });
      } catch (err) {
        const line = /:(\d+)\n/.exec(String(err.stack));
        throw new Error(`${err.name}: ${err.message}${line ? ` (${file}, line ${line[1]})` : ''}`);
      }
      scripts.push({ id: mod.id, code });
    } catch (err) {
      scripts.push({ id: mod.id, code: failScript(mod.id, err) });
    }
  }
  let userCss = '';
  try {
    userCss = readText(path.join(home, 'user.css'));
  } catch {
    // No user.css.
  }
  if (userCss.trim()) {
    scripts.push({ id: null, code: `window.Eagle.__userStyle(${JSON.stringify(userCss)});\nvoid 0;` });
  }
  return scripts;
}

// Deezer Desktop renders its UI from a local index.html; the web player lives
// on deezer.com. Remote pages such as login popups are left alone.
function isAppUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return DEEZER_HOST.test(parsed.hostname);
  return !['about:', 'blob:', 'chrome:', 'chrome-extension:', 'data:', 'devtools:', 'javascript:'].includes(parsed.protocol);
}

function isLink(dir) {
  try {
    return fs.lstatSync(dir).isSymbolicLink();
  } catch {
    return false;
  }
}

// What the library shows: loadState's view plus where each mod comes from.
function listMods(home) {
  return loadState(home).mods.map((mod) => {
    const linked = isLink(mod.dir);
    const source = linked ? null : readJson(path.join(mod.dir, '.eagle-source.json'), null);
    return Object.assign(modInfo(mod), { linked, source });
  });
}

function setModEnabled(home, id, enabled) {
  const file = path.join(home, 'config.json');
  const config = readJson(file, null) || {};
  const disabled = toList(config.disabled).filter((other) => other !== id);
  if (!enabled) disabled.push(id);
  config.disabled = disabled;
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

// Removes an installed mod. A linked dev mod only loses its link, never its files.
function removeMod(home, id) {
  if (!MOD_ID.test(String(id))) throw new Error(`invalid mod id "${id}"`);
  const dir = path.join(home, 'mods', id);
  if (isLink(dir)) {
    try {
      fs.unlinkSync(dir);
    } catch {
      fs.rmdirSync(dir); // Windows junction
    }
  } else {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  setModEnabled(home, id, true);
}

function isInstallSpec(spec) {
  return typeof spec === 'string' && INSTALL_SPEC.test(spec) && !spec.includes('..');
}

// Official mods install without a confirmation, like in the CLI.
function isOfficialSpec(spec, registry) {
  if (spec.toLowerCase().startsWith(`${OFFICIAL_REPO}/`)) return true;
  const entry = toList(registry && registry.mods).find((mod) => mod && mod.id === spec);
  return Boolean(entry && String(entry.repo).toLowerCase() === OFFICIAL_REPO);
}

// electron-updater keeps a downloaded update in <LOCALAPPDATA>/<cache dir>/pending
// until the app quits and runs the installer.
function pendingUpdateDir(resourcesPath, packageName, localAppData) {
  let dirName = `${String(packageName).toLowerCase()}-updater`;
  try {
    const yml = readText(path.join(resourcesPath, 'app-update.yml'));
    const match = /^updaterCacheDirName:\s*['"]?([^'"\r\n]+)/m.exec(yml);
    if (match) dirName = match[1].trim();
  } catch {
    // No app-update.yml: keep electron-builder's default name.
  }
  return path.join(localAppData, dirName, 'pending');
}

function hasPendingUpdate(dir) {
  try {
    return fs.readdirSync(dir).some((file) => /\.exe$/i.test(file));
  } catch {
    return false;
  }
}

module.exports = {
  MOD_ID,
  isAppUrl,
  listMods,
  setModEnabled,
  removeMod,
  isInstallSpec,
  isOfficialSpec,
  pendingUpdateDir,
  hasPendingUpdate,
  readText,
  readJson,
  resolveInside,
  loadState,
  compileRules,
  isBlocked,
  matchPatternToRegExp,
  compileFilter,
  chainBeforeRequest,
  modInfo,
  failScript,
  buildScripts,
};
