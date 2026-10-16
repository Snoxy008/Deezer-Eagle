// Deezer Eagle — renderer runtime.
//
// Injected into Deezer's page (main world) before the mods. It exposes the
// global `Eagle` API that every mod receives, plus the Eagle panel
// (Ctrl+Shift+E). DOM is built without innerHTML and styles go through
// constructable stylesheets so nothing depends on Deezer's CSP.
(function () {
  'use strict';

  const boot = window.__EAGLE_BOOT__ || { version: 'dev', mods: [] };
  delete window.__EAGLE_BOOT__;
  if (window.Eagle) return;

  const PREFIX = '[Deezer Eagle]';
  const STATUS_LABELS = { loading: 'chargement', ok: 'actif', error: 'erreur', disabled: 'désactivé' };

  const mods = new Map();
  for (const info of boot.mods) {
    mods.set(info.id, Object.assign({}, info, { status: info.enabled ? 'loading' : 'disabled', error: null }));
  }

  function report(err) {
    console.error(PREFIX, err);
  }

  // ---- Styles ----------------------------------------------------------

  function addStyle(css) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(String(css));
    document.adoptedStyleSheets = document.adoptedStyleSheets.concat(sheet);
    return function remove() {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((other) => other !== sheet);
    };
  }

  // ---- DOM helpers -----------------------------------------------------

  // Calls `callback` once for every element matching `selector`, now and later.
  function observe(selector, callback, root) {
    root = root || document;
    const seen = new WeakSet();
    const handle = (element) => {
      if (seen.has(element)) return;
      seen.add(element);
      try {
        callback(element);
      } catch (err) {
        report(err);
      }
    };
    const visit = (node) => {
      if (node.nodeType !== 1) return;
      if (node.matches(selector)) handle(node);
      node.querySelectorAll(selector).forEach(handle);
    };
    root.querySelectorAll(selector).forEach(handle);
    const observer = new MutationObserver((records) => {
      for (const record of records) record.addedNodes.forEach(visit);
    });
    observer.observe(root, { childList: true, subtree: true });
    return function disconnect() {
      observer.disconnect();
    };
  }

  // Resolves with the first element matching `selector`.
  function waitFor(selector, options) {
    const timeout = (options && options.timeout) || 0;
    const root = (options && options.root) || document;
    return new Promise((resolve, reject) => {
      const existing = root.querySelector(selector);
      if (existing) return resolve(existing);
      let timer = 0;
      const observer = new MutationObserver(() => {
        const element = root.querySelector(selector);
        if (!element) return;
        observer.disconnect();
        clearTimeout(timer);
        resolve(element);
      });
      observer.observe(root, { childList: true, subtree: true });
      if (timeout > 0) {
        timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error(`Eagle.waitFor("${selector}") : délai dépassé`));
        }, timeout);
      }
    });
  }

  // ---- Navigation (Deezer is a single-page app) --------------------------

  const navigationListeners = new Set();
  let lastUrl = location.href;

  function emitNavigation() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    navigationListeners.forEach((listener) => {
      try {
        listener(location.href);
      } catch (err) {
        report(err);
      }
    });
  }

  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function () {
      const result = original.apply(this, arguments);
      emitNavigation();
      return result;
    };
  }
  window.addEventListener('popstate', emitNavigation);

  function onNavigate(listener) {
    navigationListeners.add(listener);
    return function unsubscribe() {
      navigationListeners.delete(listener);
    };
  }

  // ---- Per-mod storage -------------------------------------------------

  function createStorage(id) {
    const key = (name) => `eagle:${id}:${name}`;
    return Object.freeze({
      get(name, fallback) {
        try {
          const raw = localStorage.getItem(key(name));
          return raw === null ? fallback : JSON.parse(raw);
        } catch {
          return fallback;
        }
      },
      set(name, value) {
        localStorage.setItem(key(name), JSON.stringify(value));
      },
      remove(name) {
        localStorage.removeItem(key(name));
      },
    });
  }

  // ---- UI: toasts and the Eagle panel ----------------------------------

  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Segoe UI", system-ui, sans-serif; }
    .toasts { position: fixed; right: 20px; bottom: 100px; z-index: 2147483647; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; pointer-events: none; }
    .toast { background: #191922; color: #fff; border-left: 4px solid #a238ff; border-radius: 8px; padding: 10px 14px; font-size: 13px; max-width: 360px; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
    .panel { position: fixed; top: 60px; right: 20px; z-index: 2147483647; width: 380px; max-height: 70vh; display: flex; flex-direction: column; background: #121216; color: #f2f2f5; border: 1px solid #2c2c36; border-radius: 12px; box-shadow: 0 16px 48px rgba(0,0,0,.55); overflow: hidden; font-size: 13px; }
    .header { display: flex; align-items: baseline; gap: 8px; padding: 14px 16px; border-bottom: 1px solid #2c2c36; }
    .header strong { font-size: 15px; color: #c58bff; }
    .header .close { margin-left: auto; }
    .mods { list-style: none; margin: 0; padding: 8px 0; overflow-y: auto; }
    .mod { padding: 8px 16px; }
    .mod + .mod { border-top: 1px solid #1f1f27; }
    .title { display: flex; align-items: center; gap: 6px; }
    .name { font-weight: 600; }
    .muted { color: #9a9aa8; }
    .status { margin-left: auto; font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #2c2c36; }
    .status.ok { background: #183d2a; color: #7ee2a8; }
    .status.error { background: #4a1c22; color: #ff9aa5; }
    .status.disabled { color: #9a9aa8; }
    .error { white-space: pre-wrap; color: #ff9aa5; font: 11px/1.4 Consolas, monospace; margin: 6px 0 0; max-height: 120px; overflow: auto; }
    .empty { padding: 8px 16px; }
    .footer { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-top: 1px solid #2c2c36; }
    button { cursor: pointer; border: 0; border-radius: 999px; background: #2c2c36; color: #fff; padding: 6px 12px; font-size: 12px; }
    button:hover { background: #3a3a46; }
    .footer button { margin-left: auto; background: #a238ff; }
    .footer button:hover { background: #b45cff; }
  `;

  let ui = null;

  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content != null) node.textContent = content;
    return node;
  }

  function getUi() {
    if (ui && ui.host.isConnected) return ui;
    const host = document.createElement('deezer-eagle');
    const shadow = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(UI_CSS);
    shadow.adoptedStyleSheets = [sheet];
    const toasts = element('div', 'toasts');
    shadow.append(toasts);
    document.documentElement.append(host);
    ui = { host, shadow, toasts, panel: null };
    return ui;
  }

  function notify(message, options) {
    const toast = element('div', 'toast', String(message));
    getUi().toasts.append(toast);
    setTimeout(() => toast.remove(), (options && options.timeout) || 4000);
  }

  function renderPanel() {
    const panel = element('div', 'panel');

    const header = element('div', 'header');
    const close = element('button', 'close', '×');
    close.title = 'Fermer';
    close.addEventListener('click', togglePanel);
    header.append(element('strong', '', 'Deezer Eagle'), element('span', 'muted', `v${boot.version}`), close);

    const list = element('ul', 'mods');
    if (mods.size === 0) {
      list.append(element('li', 'empty muted', 'Aucun mod installé. Tape « eagle search » dans PowerShell pour en trouver.'));
    }
    for (const info of mods.values()) {
      const item = element('li', 'mod');
      const title = element('div', 'title');
      title.append(
        element('span', 'name', info.name),
        element('span', 'muted', info.version ? `v${info.version}` : ''),
        element('span', `status ${info.status}`, STATUS_LABELS[info.status] || info.status),
      );
      item.append(title);
      if (info.description) item.append(element('div', 'muted', info.description));
      if (info.error) item.append(element('pre', 'error', info.error));
      list.append(item);
    }

    const footer = element('div', 'footer');
    const reload = element('button', '', 'Recharger');
    reload.title = 'Ctrl+Shift+R';
    reload.addEventListener('click', () => location.reload());
    footer.append(element('span', 'muted', 'Gère tes mods avec « eagle » dans PowerShell.'), reload);

    panel.append(header, list, footer);
    return panel;
  }

  function togglePanel() {
    const current = getUi();
    if (current.panel) {
      current.panel.remove();
      current.panel = null;
      return;
    }
    current.panel = renderPanel();
    current.shadow.append(current.panel);
  }

  window.addEventListener(
    'keydown',
    (event) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === 'e') {
        event.preventDefault();
        event.stopPropagation();
        togglePanel();
      } else if (key === 'r') {
        event.preventDefault();
        event.stopPropagation();
        location.reload();
      }
    },
    true,
  );

  // ---- Mod loading (called by the scripts the core injects) --------------

  function fail(id, err) {
    const info = mods.get(id);
    const message = err && err.stack ? String(err.stack) : String(err);
    if (info) {
      info.status = 'error';
      info.error = message;
    }
    console.error(PREFIX, `le mod "${id}" a planté :`, err);
    notify(`Le mod « ${info ? info.name : id} » a planté. Ctrl+Shift+E pour les détails.`, { timeout: 6000 });
  }

  function createContext(info) {
    const tag = `[${info.name}]`;
    return Object.freeze({
      id: info.id,
      name: info.name,
      version: info.version,
      log: (...args) => console.log(PREFIX, tag, ...args),
      warn: (...args) => console.warn(PREFIX, tag, ...args),
      error: (...args) => console.error(PREFIX, tag, ...args),
      storage: createStorage(info.id),
      addStyle,
    });
  }

  function load(id, css, factory) {
    const info = mods.get(id);
    if (!info) return;
    try {
      if (css) addStyle(css);
      const result = factory.call(window, api, createContext(info));
      info.status = 'ok';
      if (result && typeof result.then === 'function') result.then(null, (err) => fail(id, err));
    } catch (err) {
      fail(id, err);
    }
  }

  const api = {
    version: boot.version,
    get mods() {
      return Array.from(mods.values(), (info) => Object.assign({}, info));
    },
    addStyle,
    observe,
    waitFor,
    onNavigate,
    notify,
    togglePanel,
    // Internal, used by the injected scripts.
    __load: load,
    __fail: fail,
    __userStyle: addStyle,
  };

  Object.defineProperty(window, 'Eagle', { value: Object.freeze(api), enumerable: false });

  const active = boot.mods.filter((info) => info.enabled).length;
  console.log(PREFIX, `v${boot.version} — ${active} mod(s) actif(s). Ctrl+Shift+E pour ouvrir le panneau.`);
})();
