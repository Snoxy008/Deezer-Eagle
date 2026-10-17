// Deezer Eagle — renderer runtime.
//
// Injected into Deezer's page (main world) before the mods. It exposes the
// global `Eagle` API that every mod receives, adds an "Eagle" entry to
// Deezer's sidebar and renders the Eagle library (installed mods and the
// marketplace). DOM is built without innerHTML and styles go through
// constructable stylesheets so nothing depends on Deezer's CSP.
(function () {
  'use strict';

  const boot = window.__EAGLE_BOOT__ || { version: 'dev', mods: [] };
  delete window.__EAGLE_BOOT__;
  if (window.Eagle) return;

  const PREFIX = '[Deezer Eagle]';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // A stylised eagle in flight, drawn on a 24x24 grid.
  const EAGLE_PATH =
    'M12 6.5c.9 0 1.6.6 1.8 1.4l.5 1.9 5.2-2.6c.9-.4 1.9.4 1.6 1.3-.8 2.6-2.9 4.5-5.4 5.1l-1.2 2.6 1.6 2.2c.3.5 0 1.1-.6 1.1H8.5c-.6 0-.9-.6-.6-1.1l1.6-2.2-1.2-2.6C5.8 13 3.7 11.1 2.9 8.5c-.3-.9.7-1.7 1.6-1.3l5.2 2.6.5-1.9c.2-.8.9-1.4 1.8-1.4z';
  const bridge = window.EagleBridge || null;

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
          reject(new Error(`Eagle.waitFor("${selector}") timed out`));
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

  // ---- UI root ---------------------------------------------------------

  // Deezer's theme variables inherit into the shadow root, so the library
  // follows light/dark mode and custom themes. Fallbacks are Deezer's defaults.
  const UI_CSS = `
    * { box-sizing: border-box; font-family: inherit; }
    button { font: inherit; cursor: pointer; border: 0; }
    button:disabled { cursor: default; opacity: .6; }
    .toasts { position: fixed; right: 24px; bottom: 104px; z-index: 2147483647; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; pointer-events: none; }
    .toast { background: var(--color-bg-inverse, #121216); color: var(--color-text-inverse, #fff); border-radius: 8px; padding: 12px 16px; font-size: 14px; max-width: 380px; box-shadow: 0 8px 24px rgba(0,0,0,.3); }
    .launcher { position: fixed; top: 16px; right: 136px; z-index: 2147483000; width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; background: var(--color-bg-tertiary, #ebe7ee); color: var(--color-text-main, #0f0d13); }
    .launcher:hover { background: var(--color-bg-tertiary-hover, #e1dde4); }
    .library { position: fixed; z-index: 2147483000; display: flex; flex-direction: column; background: var(--color-bg-main, #fdfcfe); color: var(--color-text-main, #0f0d13); font-size: 14px; }
    .scroll { flex: 1; overflow-y: auto; padding: 32px 40px 48px; }
    .head { display: flex; align-items: center; gap: 16px; }
    .logo { width: 56px; height: 56px; border-radius: 14px; display: grid; place-items: center; color: #fff; background: linear-gradient(135deg, var(--color-accent-main, #a238ff), #ff5c8a); }
    h1 { margin: 0; font-size: 36px; line-height: 1.1; font-weight: 800; letter-spacing: -.02em; }
    h2 { margin: 28px 0 12px; font-size: 20px; font-weight: 700; }
    .muted { color: var(--color-text-secondary, #6f6d71); }
    .close { margin-left: auto; width: 40px; height: 40px; border-radius: 50%; font-size: 22px; background: transparent; color: var(--color-text-main, #0f0d13); }
    .close:hover { background: var(--color-bg-tertiary, #ebe7ee); }
    .tabs { display: flex; gap: 8px; margin: 24px 0 8px; }
    .tab { padding: 8px 16px; border-radius: 999px; font-weight: 600; background: var(--color-bg-tertiary, #ebe7ee); color: var(--color-text-main, #0f0d13); }
    .tab:hover { background: var(--color-bg-tertiary-hover, #e1dde4); }
    .tab[aria-selected="true"] { background: var(--color-text-main, #0f0d13); color: var(--color-bg-main, #fdfcfe); }
    .notice { display: flex; align-items: center; gap: 12px; margin: 16px 0 0; padding: 12px 16px; border-radius: 8px; background: var(--color-bg-secondary, #f5f2f8); }
    .notice .button { margin-left: auto; }
    .toolbar { display: flex; align-items: center; gap: 12px; margin: 20px 0 4px; }
    .toolbar .button { margin-left: auto; }
    .search { flex: 1; max-width: 420px; height: 40px; padding: 0 16px; border-radius: 8px; border: 0; font: inherit; color: inherit; background: var(--color-bg-tertiary, #ebe7ee); outline: none; }
    .search:focus { box-shadow: 0 0 0 2px var(--color-accent-main, #a238ff); }
    .list { display: grid; gap: 8px; }
    .card { display: flex; align-items: center; gap: 16px; padding: 12px 16px; border-radius: 8px; background: var(--color-bg-secondary, #f5f2f8); }
    .avatar { flex: none; width: 48px; height: 48px; border-radius: 8px; display: grid; place-items: center; font-size: 20px; font-weight: 800; color: #fff; background: linear-gradient(135deg, var(--color-accent-main, #a238ff), #5c6bff); }
    .info { flex: 1; min-width: 0; }
    .title { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-weight: 700; font-size: 15px; }
    .desc { margin-top: 2px; }
    .meta { margin-top: 2px; font-size: 12px; }
    .badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--color-bg-tertiary, #ebe7ee); color: var(--color-text-secondary, #6f6d71); }
    .badge.accent { color: var(--color-accent-main, #a238ff); }
    .badge.error { color: var(--color-feedback-error, #df3c3c); }
    .error { white-space: pre-wrap; margin: 6px 0 0; font: 12px/1.4 Consolas, monospace; color: var(--color-feedback-error, #df3c3c); max-height: 120px; overflow: auto; }
    .actions { display: flex; align-items: center; gap: 8px; flex: none; }
    .button { padding: 8px 18px; border-radius: 999px; font-weight: 600; background: var(--color-accent-main, #a238ff); color: #fff; white-space: nowrap; }
    .button:hover:not(:disabled) { filter: brightness(1.08); }
    .button.secondary { background: var(--color-bg-tertiary, #ebe7ee); color: var(--color-text-main, #0f0d13); }
    .switch { position: relative; width: 40px; height: 24px; border-radius: 999px; background: var(--color-neutral-main, #d1d1d6); transition: background .15s; }
    .switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform .15s; box-shadow: 0 1px 3px rgba(0,0,0,.3); }
    .switch[aria-checked="true"] { background: var(--color-accent-main, #a238ff); }
    .switch[aria-checked="true"]::after { transform: translateX(16px); }
    .empty { padding: 24px 0; }
    .footer { margin-top: 32px; font-size: 13px; }
    code { font-family: Consolas, monospace; padding: 1px 6px; border-radius: 4px; background: var(--color-bg-tertiary, #ebe7ee); }
  `;

  let ui = null;

  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content != null) node.textContent = content;
    return node;
  }

  function button(className, label, onClick) {
    const node = element('button', className, label);
    node.type = 'button';
    if (onClick) node.addEventListener('click', onClick);
    return node;
  }

  function eagleIcon(size, template) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    if (template) {
      for (const name of ['class', 'width', 'height', 'style', 'aria-hidden', 'focusable']) {
        if (template.hasAttribute(name)) svg.setAttribute(name, template.getAttribute(name));
      }
    }
    if (!svg.hasAttribute('width')) svg.setAttribute('width', size);
    if (!svg.hasAttribute('height')) svg.setAttribute('height', size);
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('data-testid', 'EagleOutlinedIcon');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', EAGLE_PATH);
    svg.append(path);
    return svg;
  }

  function getUi() {
    if (ui && ui.host.isConnected) return ui;
    const host = document.createElement('deezer-eagle');
    const shadow = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(UI_CSS);
    shadow.adoptedStyleSheets = [sheet];
    if (document.body) host.style.fontFamily = getComputedStyle(document.body).fontFamily;
    const toasts = element('div', 'toasts');
    shadow.append(toasts);
    document.documentElement.append(host);
    ui = { host, shadow, toasts };
    return ui;
  }

  function notify(message, options) {
    const toast = element('div', 'toast', String(message));
    getUi().toasts.append(toast);
    setTimeout(() => toast.remove(), (options && options.timeout) || 4000);
  }

  // ---- Library ---------------------------------------------------------

  const library = {
    node: null,
    tab: 'installed',
    query: '',
    installed: null,
    market: null,
    marketLoading: false,
    needsReload: false,
    busy: new Set(),
    observer: null,
  };

  function lastLines(text, count) {
    return String(text || '')
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .slice(-count)
      .join('\n');
  }

  function sourceLabel(mod) {
    if (mod.linked) return 'development link';
    const source = mod.source;
    if (!source) return '';
    if (source.type === 'local') return source.path;
    return [source.repo, source.path].filter(Boolean).join('/');
  }

  function isOfficial(mod) {
    return Boolean(mod.source && mod.source.type === 'github' && /^snoxy008\/deezer-eagle$/i.test(mod.source.repo));
  }

  // The sidebar wins over the content box when they overlap, and a hidden
  // player or top bar does not shrink the page.
  function placeLibrary() {
    const node = library.node;
    if (!node) return;
    const rect = (selector) => {
      const target = document.querySelector(selector);
      const box = target && target.getBoundingClientRect();
      return box && box.width > 0 && box.height > 0 ? box : null;
    };
    const content = rect('#page_content');
    const sidebar = rect('.naboo > div:not([id]):has(a) > div');
    const topbar = rect('#page_topbar');
    const player = rect('#page_player');
    const left = Math.max(content ? content.left : 0, sidebar ? sidebar.right : 0);
    node.style.left = `${left}px`;
    node.style.right = `${content ? Math.max(0, window.innerWidth - content.right) : 0}px`;
    node.style.top = `${topbar ? topbar.bottom : 0}px`;
    node.style.bottom = `${player ? Math.max(0, window.innerHeight - player.top) : 0}px`;
  }

  function openLibrary(tab) {
    if (tab) library.tab = tab;
    const current = getUi();
    if (!library.node) {
      library.node = element('section', 'library');
      library.node.setAttribute('aria-label', 'Deezer Eagle');
      current.shadow.append(library.node);
      library.observer = new ResizeObserver(placeLibrary);
      for (const selector of ['#page_content', '#page_topbar', '#page_player', '.naboo']) {
        const target = document.querySelector(selector);
        if (target) library.observer.observe(target);
      }
      window.addEventListener('resize', placeLibrary);
    }
    placeLibrary();
    renderLibrary();
    markSidebarEntry(true);
    refreshInstalled();
  }

  function closeLibrary() {
    if (!library.node) return;
    library.node.remove();
    library.node = null;
    library.observer.disconnect();
    window.removeEventListener('resize', placeLibrary);
    markSidebarEntry(false);
  }

  function toggleLibrary() {
    if (library.node) closeLibrary();
    else openLibrary();
  }

  function refreshInstalled() {
    if (!bridge) return;
    bridge.list().then(
      (list) => {
        library.installed = list;
        renderLibrary();
      },
      (err) => report(err),
    );
  }

  function loadMarketplace() {
    if (!bridge) return;
    const query = library.query;
    const done = (market) => {
      if (query !== library.query) return;
      library.market = market;
      library.marketLoading = false;
      renderLibrary();
    };
    library.market = null;
    library.marketLoading = true;
    bridge.marketplace(query).then(done, (err) => done({ registry: [], community: [], errors: [String(err.message || err)] }));
    renderLibrary();
  }

  function changed() {
    library.needsReload = true;
    refreshInstalled();
  }

  // Installed mods: what the core says is on disk, plus what ran in this page.
  function installedMods() {
    const list = library.installed || boot.mods.map((info) => Object.assign({ linked: false, source: null }, info));
    return list.map((mod) => {
      const runtime = mods.get(mod.id);
      return Object.assign({}, mod, {
        status: runtime ? runtime.status : 'new',
        error: runtime ? runtime.error : null,
      });
    });
  }

  function renderInstalledCard(mod) {
    const card = element('div', 'card');
    card.dataset.mod = mod.id;
    card.append(element('div', 'avatar', (mod.name || mod.id).charAt(0).toUpperCase()));

    const info = element('div', 'info');
    const title = element('div', 'title');
    title.append(element('span', '', mod.name));
    if (mod.version) title.append(element('span', 'muted', `v${mod.version}`));
    if (isOfficial(mod)) title.append(element('span', 'badge accent', 'Official'));
    if (mod.linked) title.append(element('span', 'badge', 'Dev link'));
    if (mod.enabled && mod.status === 'error') title.append(element('span', 'badge error', 'Error'));
    if (mod.enabled !== (mod.status !== 'disabled' && mod.status !== 'new')) {
      title.append(element('span', 'badge', 'Reload to apply'));
    }
    info.append(title);
    if (mod.description) info.append(element('div', 'desc muted', mod.description));
    const meta = [mod.author && `by ${mod.author}`, sourceLabel(mod)].filter(Boolean).join(' · ');
    if (meta) info.append(element('div', 'meta muted', meta));
    if (mod.enabled && mod.error) info.append(element('pre', 'error', mod.error));
    card.append(info);

    if (bridge) {
      const actions = element('div', 'actions');
      const toggle = button('switch', null, () => {
        toggle.disabled = true;
        bridge.setEnabled(mod.id, !mod.enabled).then(changed, (err) => {
          notify(`Could not change ${mod.name}: ${err.message || err}`);
          toggle.disabled = false;
        });
      });
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-checked', String(Boolean(mod.enabled)));
      toggle.setAttribute('aria-label', `${mod.enabled ? 'Disable' : 'Enable'} ${mod.name}`);
      const remove = button('button secondary', 'Remove', () => {
        if (!window.confirm(`Remove the "${mod.name}" mod?`)) return;
        bridge.remove(mod.id).then(
          () => {
            notify(`${mod.name} removed.`);
            changed();
          },
          (err) => notify(`Could not remove ${mod.name}: ${err.message || err}`),
        );
      });
      remove.setAttribute('aria-label', `Remove ${mod.name}`);
      actions.append(toggle, remove);
      card.append(actions);
    }
    return card;
  }

  function renderInstalled(container) {
    const list = installedMods();
    if (bridge) {
      const toolbar = element('div', 'toolbar');
      toolbar.append(element('span', 'muted', `${list.filter((mod) => mod.enabled).length} of ${list.length} mods enabled`));
      const update = button('button secondary', library.busy.has('update') ? 'Checking...' : 'Check for updates', () => {
        library.busy.add('update');
        renderLibrary();
        bridge.update().then(
          (result) => {
            library.busy.delete('update');
            notify(lastLines(result.output, 3) || 'Mods are up to date.', { timeout: 6000 });
            changed();
          },
          (err) => {
            library.busy.delete('update');
            notify(`Update failed: ${err.message || err}`);
            renderLibrary();
          },
        );
      });
      update.disabled = library.busy.has('update');
      toolbar.append(update);
      container.append(toolbar);
    }
    if (list.length === 0) {
      container.append(element('div', 'empty muted', 'No mods installed yet. Have a look at the Marketplace.'));
      return;
    }
    const grid = element('div', 'list');
    list.forEach((mod) => grid.append(renderInstalledCard(mod)));
    container.append(grid);
  }

  function isInstalledSpec(entry) {
    const list = installedMods();
    if (entry.id) return list.some((mod) => mod.id === entry.id);
    const spec = entry.spec.toLowerCase();
    return list.some((mod) => mod.source && String(mod.source.repo).toLowerCase() === spec);
  }

  function renderMarketCard(entry, official) {
    const card = element('div', 'card');
    card.dataset.spec = entry.spec;
    card.append(element('div', 'avatar', (entry.name || entry.spec).charAt(0).toUpperCase()));
    const info = element('div', 'info');
    const title = element('div', 'title');
    title.append(element('span', '', entry.name));
    if (official) title.append(element('span', 'badge accent', 'Official'));
    if (entry.stars) title.append(element('span', 'muted', `★ ${entry.stars}`));
    info.append(title);
    if (entry.description) info.append(element('div', 'desc muted', entry.description));
    const meta = [entry.author && `by ${entry.author}`, official ? '' : entry.spec].filter(Boolean).join(' · ');
    if (meta) info.append(element('div', 'meta muted', meta));
    card.append(info);

    const actions = element('div', 'actions');
    const installed = isInstalledSpec(entry);
    const busy = library.busy.has(entry.spec);
    const install = button(installed ? 'button secondary' : 'button', installed ? 'Installed' : busy ? 'Installing...' : 'Install', () => {
      library.busy.add(entry.spec);
      renderLibrary();
      bridge.install(entry.spec).then(
        (result) => {
          library.busy.delete(entry.spec);
          if (result.ok) {
            notify(`${entry.name} installed.`);
            changed();
          } else {
            if (!result.cancelled) notify(lastLines(result.output, 2) || `Could not install ${entry.name}.`, { timeout: 8000 });
            renderLibrary();
          }
        },
        (err) => {
          library.busy.delete(entry.spec);
          notify(`Could not install ${entry.name}: ${err.message || err}`, { timeout: 8000 });
          renderLibrary();
        },
      );
    });
    install.disabled = installed || busy;
    actions.append(install);
    card.append(actions);
    return card;
  }

  function renderMarketplace(container) {
    if (!bridge) {
      container.append(element('div', 'empty muted', 'The marketplace is unavailable here: use "eagle search" and "eagle install" in PowerShell.'));
      return;
    }
    const toolbar = element('div', 'toolbar');
    const search = element('input', 'search');
    search.type = 'search';
    search.placeholder = 'Search mods';
    search.value = library.query;
    let timer = 0;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        library.query = search.value.trim();
        loadMarketplace();
      }, 400);
    });
    toolbar.append(search);
    container.append(toolbar);

    const market = library.market;
    if (!market) {
      container.append(element('div', 'empty muted', 'Loading mods...'));
      if (!library.marketLoading) Promise.resolve().then(loadMarketplace);
      return;
    }
    const query = library.query.toLowerCase();
    const official = market.registry.filter(
      (entry) => !query || `${entry.id} ${entry.name} ${entry.description}`.toLowerCase().includes(query),
    );
    const sections = [
      ['Official mods', official, true],
      ['Community mods', market.community, false],
    ];
    for (const [heading, entries, isOfficialSection] of sections) {
      container.append(element('h2', '', heading));
      if (entries.length === 0) {
        container.append(element('div', 'empty muted', isOfficialSection ? 'No official mod matches.' : 'No community mod found.'));
        continue;
      }
      const grid = element('div', 'list');
      entries.forEach((entry) => grid.append(renderMarketCard(entry, isOfficialSection)));
      container.append(grid);
    }
    market.errors.forEach((message) => container.append(element('div', 'meta muted', message)));
    const footer = element('div', 'footer muted');
    footer.append(
      'Make your own: run ',
      element('code', '', 'eagle new my-mod'),
      ' in PowerShell, then publish it on GitHub with the ',
      element('code', '', 'deezer-eagle-mod'),
      ' topic.',
    );
    container.append(footer);
  }

  function renderLibrary() {
    const node = library.node;
    if (!node) return;
    const scroll = node.querySelector('.scroll');
    const scrollTop = scroll ? scroll.scrollTop : 0;
    const focused = node.getRootNode().activeElement;
    const keepSearchFocus = Boolean(focused && focused.classList.contains('search'));
    node.replaceChildren();

    const body = element('div', 'scroll');
    const head = element('div', 'head');
    const logo = element('div', 'logo');
    logo.append(eagleIcon(32));
    const titles = element('div');
    titles.append(element('h1', '', 'Eagle'), element('div', 'muted', `Mods for Deezer · v${boot.version}`));
    const close = button('close', '×', closeLibrary);
    close.title = 'Close (Esc)';
    head.append(logo, titles, close);
    body.append(head);

    const tabs = element('div', 'tabs');
    tabs.setAttribute('role', 'tablist');
    for (const [id, label] of [
      ['installed', `Installed (${installedMods().length})`],
      ['marketplace', 'Marketplace'],
    ]) {
      const tab = button('tab', label, () => {
        library.tab = id;
        renderLibrary();
      });
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(library.tab === id));
      tab.dataset.tab = id;
      tabs.append(tab);
    }
    body.append(tabs);

    if (library.needsReload) {
      const notice = element('div', 'notice');
      notice.append(element('span', '', 'Your changes apply once Deezer reloads.'), button('button', 'Reload now', () => location.reload()));
      body.append(notice);
    }

    if (library.tab === 'marketplace') renderMarketplace(body);
    else renderInstalled(body);
    node.append(body);
    body.scrollTop = scrollTop;
    if (keepSearchFocus) {
      const search = body.querySelector('.search');
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    }
  }

  // ---- Sidebar entry ---------------------------------------------------

  let sidebarEntry = null;

  // Finds Deezer's primary navigation (Home, Explore...) from the Home row,
  // whose icon is HouseFilledIcon or HouseOutlinedIcon, and returns the list
  // and its rows, however deeply each link is wrapped.
  function findNavigation() {
    const home = document.querySelector('a:has(svg[data-testid^="House"])');
    if (!home) return null;
    let row = home;
    for (let depth = 0; depth < 5 && row.parentElement; depth++) {
      const list = row.parentElement;
      const rows = Array.from(list.children).filter((child) => child.querySelector('svg[data-testid$="Icon"]') && (child.matches('a') || child.querySelector('a')));
      if (rows.length >= 2) return { list, rows };
      row = list;
    }
    return null;
  }

  function markSidebarEntry(active) {
    if (!sidebarEntry) return;
    const link = sidebarEntry.matches('a') ? sidebarEntry : sidebarEntry.querySelector('a');
    if (link) link.style.background = active ? 'var(--color-bg-tertiary, #ebe7ee)' : '';
  }

  // Clones a navigation row that is not the current page, so it carries
  // Deezer's own styling (including the collapsed sidebar).
  function installSidebarEntry() {
    if (sidebarEntry && sidebarEntry.isConnected) return true;
    const navigation = findNavigation();
    if (!navigation) return false;
    const template =
      navigation.rows.filter((row) => !row.querySelector('svg[data-testid$="FilledIcon"]')).pop() || navigation.rows[navigation.rows.length - 1];
    const entry = template.cloneNode(true);
    entry.dataset.eagle = 'sidebar-entry';
    const link = entry.matches('a') ? entry : entry.querySelector('a');
    link.removeAttribute('href');
    link.removeAttribute('aria-current');
    link.setAttribute('role', 'link');
    link.setAttribute('tabindex', '0');
    link.setAttribute('aria-label', 'Eagle');
    link.title = 'Eagle';
    const icon = entry.querySelector('svg');
    icon.replaceWith(eagleIcon(24, icon));
    const walker = document.createTreeWalker(link, NodeFilter.SHOW_TEXT);
    let label = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeValue.trim() && (!label || node.nodeValue.trim().length > label.nodeValue.trim().length)) label = node;
    }
    if (label) label.nodeValue = 'Eagle';
    const open = (event) => {
      event.preventDefault();
      event.stopPropagation();
      openLibrary();
    };
    link.addEventListener('click', open);
    link.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') open(event);
    });
    navigation.rows[navigation.rows.length - 1].after(entry);
    sidebarEntry = entry;
    markSidebarEntry(Boolean(library.node));
    return true;
  }

  // React may re-render the sidebar: put the entry back when it disappears.
  // Without a recognisable sidebar, fall back to a round button.
  function keepSidebarEntry() {
    let scheduled = false;
    const check = () => {
      scheduled = false;
      if (installSidebarEntry() && ui && ui.launcher) {
        ui.launcher.remove();
        ui.launcher = null;
      }
    };
    new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(check);
    }).observe(document.documentElement, { childList: true, subtree: true });
    check();
    setTimeout(() => {
      if (sidebarEntry && sidebarEntry.isConnected) return;
      const current = getUi();
      if (current.launcher) return;
      current.launcher = button('launcher', null, toggleLibrary);
      current.launcher.title = 'Deezer Eagle (Ctrl+Shift+E)';
      current.launcher.append(eagleIcon(22));
      current.shadow.append(current.launcher);
    }, 10000);
  }

  // Leaving the library: another sidebar link, a page change or Escape.
  document.addEventListener(
    'click',
    (event) => {
      const link = event.target instanceof Element ? event.target.closest('a') : null;
      if (link && library.node && !(sidebarEntry && sidebarEntry.contains(link))) closeLibrary();
    },
    true,
  );
  onNavigate(() => closeLibrary());

  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && library.node) {
        closeLibrary();
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === 'e') {
        event.preventDefault();
        event.stopPropagation();
        toggleLibrary();
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
    console.error(PREFIX, `mod "${id}" crashed:`, err);
    notify(`The "${info ? info.name : id}" mod crashed. Open Eagle in the sidebar for details.`, { timeout: 6000 });
    renderLibrary();
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
    openLibrary,
    closeLibrary,
    // Internal, used by the injected scripts.
    __load: load,
    __fail: fail,
    __userStyle: addStyle,
  };

  Object.defineProperty(window, 'Eagle', { value: Object.freeze(api), enumerable: false });

  if (document.body) keepSidebarEntry();
  else document.addEventListener('DOMContentLoaded', keepSidebarEntry, { once: true });

  const active = boot.mods.filter((info) => info.enabled).length;
  console.log(PREFIX, `v${boot.version}, ${active} active mod(s). Open Eagle from the sidebar or press Ctrl+Shift+E.`);
})();
