// Deezer Eagle — renderer runtime.
//
// Injected into Deezer's page (main world) before the mods. It exposes the
// global `Eagle` API that every mod receives (DOM helpers, player, storage,
// settings), applies themes and CSS-only mods, adds an "Eagle" entry to
// Deezer's sidebar and renders the Eagle library. DOM is built without
// innerHTML and styles go through constructable stylesheets so nothing
// depends on Deezer's CSP.
(function () {
  'use strict';

  const boot = window.__EAGLE_BOOT__ || { version: 'dev', mods: [], themes: [], theme: null };
  delete window.__EAGLE_BOOT__;
  if (window.Eagle) return;

  const PREFIX = '[Deezer Eagle]';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // A stylised eagle in flight, drawn on a 24x24 grid.
  const EAGLE_PATH =
    'M12 6.5c.9 0 1.6.6 1.8 1.4l.5 1.9 5.2-2.6c.9-.4 1.9.4 1.6 1.3-.8 2.6-2.9 4.5-5.4 5.1l-1.2 2.6 1.6 2.2c.3.5 0 1.1-.6 1.1H8.5c-.6 0-.9-.6-.6-1.1l1.6-2.2-1.2-2.6C5.8 13 3.7 11.1 2.9 8.5c-.3-.9.7-1.7 1.6-1.3l5.2 2.6.5-1.9c.2-.8.9-1.4 1.8-1.4z';
  const bridge = window.EagleBridge || null;

  function report(err) {
    console.error(PREFIX, err);
  }

  function safely(fn, fallback) {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }

  // Mods as this page knows them; `status` says what actually ran here.
  const mods = new Map();
  for (const info of boot.mods) {
    mods.set(info.id, Object.assign({}, info, { status: info.enabled ? 'loading' : 'disabled', error: info.error || null }));
  }
  const themes = new Map((boot.themes || []).map((theme) => [theme.id, theme]));

  // ---- Styles ----------------------------------------------------------

  // Sheets added later go before user.css, which always comes last.
  let userSheet = null;

  function insertSheet(css) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(String(css));
    const sheets = document.adoptedStyleSheets.slice();
    const index = userSheet ? sheets.indexOf(userSheet) : -1;
    if (index >= 0) sheets.splice(index, 0, sheet);
    else sheets.push(sheet);
    document.adoptedStyleSheets = sheets;
    return function remove() {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((other) => other !== sheet);
    };
  }

  function addStyle(css) {
    return insertSheet(css);
  }

  function addUserStyle(css) {
    insertSheet(css);
    userSheet = document.adoptedStyleSheets[document.adoptedStyleSheets.length - 1];
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

  // ---- Per-mod storage and settings ----------------------------------------

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

  // Settings declared in a manifest. The library writes them, mods read them
  // with mod.settings and hear about changes right away.
  const settingListeners = new Map();

  function readSetting(id, definition) {
    try {
      const raw = localStorage.getItem(`eagle:${id}:setting:${definition.key}`);
      return raw === null ? definition.default : JSON.parse(raw);
    } catch {
      return definition.default;
    }
  }

  function writeSetting(id, key, value) {
    localStorage.setItem(`eagle:${id}:setting:${key}`, JSON.stringify(value));
    (settingListeners.get(id) || new Set()).forEach((listener) => {
      try {
        listener(key, value);
      } catch (err) {
        report(err);
      }
    });
  }

  function createSettings(info) {
    const definitions = new Map((info.settings || []).map((definition) => [definition.key, definition]));
    return Object.freeze({
      get(key) {
        const definition = definitions.get(key);
        return definition ? readSetting(info.id, definition) : undefined;
      },
      set(key, value) {
        if (!definitions.has(key)) throw new Error(`"${key}" is not a setting of ${info.name}`);
        writeSetting(info.id, key, value);
      },
      all() {
        return Object.fromEntries(Array.from(definitions.values(), (definition) => [definition.key, readSetting(info.id, definition)]));
      },
      onChange(listener) {
        if (!settingListeners.has(info.id)) settingListeners.set(info.id, new Set());
        settingListeners.get(info.id).add(listener);
        return function unsubscribe() {
          settingListeners.get(info.id).delete(listener);
        };
      },
    });
  }

  // ---- Player ----------------------------------------------------------

  // Deezer's web player is window.dzPlayer; the app also posts
  // "player-…-changed" messages to the window. Events come from both, with a
  // once-a-second check as a safety net.
  const player = (function () {
    const listeners = { track: new Set(), playing: new Set(), volume: new Set() };
    const known = { track: undefined, playing: undefined, volume: undefined };
    const dz = () => window.dzPlayer || null;
    const slider = () => document.querySelector('#page_player .slider-track-input, .slider-track .slider-track-input');

    function toTrack(song) {
      if (!song || typeof song !== 'object') return null;
      const picture = song.ALB_PICTURE || song.SHOW_ART_MD5 || song.LIVESTREAM_IMAGE_MD5 || '';
      return Object.freeze({
        id: String(song.SNG_ID || song.EPISODE_ID || song.LIVESTREAM_ID || ''),
        title: song.SNG_TITLE || song.EPISODE_TITLE || song.LIVESTREAM_TITLE || '',
        artist: song.ART_NAME || song.SHOW_NAME || song.LIVESTREAM_TITLE || '',
        album: song.ALB_TITLE || '',
        duration: Number(song.DURATION) || 0,
        cover: picture ? `https://images.deezer.com/images/${song.SHOW_ART_MD5 ? 'talk' : 'cover'}/${picture}/500x500.jpg` : '',
        url: song.SNG_ID ? `https://www.deezer.com/track/${song.SNG_ID}` : '',
        raw: song,
      });
    }

    function getTrack() {
      return toTrack(safely(() => dz().getCurrentSong(), null));
    }

    function control(names, ...args) {
      const controls = safely(() => dz().control, null);
      for (const name of names) {
        if (controls && typeof controls[name] === 'function') return controls[name](...args);
      }
      throw new Error(`Eagle.player: "${names[0]}" is not available in this version of Deezer`);
    }

    function isPlaying() {
      const instance = dz();
      if (instance && typeof instance.isPlaying === 'function') return Boolean(safely(() => instance.isPlaying(), known.playing));
      return Boolean(known.playing);
    }

    function getVolume() {
      const volume = safely(() => dz().volume, null);
      if (typeof volume === 'number') return volume;
      return typeof known.volume === 'number' ? known.volume : 1;
    }

    function getDuration() {
      const instance = dz();
      const value = safely(() => (typeof instance.getDuration === 'function' ? instance.getDuration() : instance.duration), null);
      if (Number(value) > 0) return Number(value);
      const max = Number(slider() && slider().getAttribute('max'));
      if (max > 0) return max;
      const track = getTrack();
      return track ? track.duration : 0;
    }

    function getPosition() {
      const instance = dz();
      const value = safely(() => (typeof instance.getPosition === 'function' ? instance.getPosition() : instance.position), null);
      if (typeof value === 'number') return value;
      return Number(slider() && slider().getAttribute('value')) || 0;
    }

    function emit(event, value) {
      if (known[event] === value || (event === 'track' && known.track === (value ? value.id : null))) return;
      known[event] = event === 'track' ? (value ? value.id : null) : value;
      if (event === 'track' && !value) return;
      listeners[event].forEach((listener) => {
        try {
          listener(value);
        } catch (err) {
          report(err);
        }
      });
    }

    function sync() {
      if (!dz()) return;
      emit('track', getTrack());
      emit('playing', isPlaying());
      emit('volume', getVolume());
    }

    window.addEventListener('message', (event) => {
      const data = event.data;
      if (event.source !== window || !data || typeof data.type !== 'string' || !data.type.startsWith('player-')) return;
      if (data.type === 'player-playing-changed' && typeof data.isPlaying === 'boolean') emit('playing', data.isPlaying);
      if (data.type === 'player-volume-changed' && data.player && typeof data.player.volume === 'number') emit('volume', data.player.volume);
      setTimeout(sync, 0);
    });
    setInterval(sync, 1000);

    const clamp = (value) => Math.max(0, Math.min(1, Number(value) || 0));

    return Object.freeze({
      get available() {
        return Boolean(dz());
      },
      getTrack,
      isPlaying,
      getVolume,
      getPosition,
      getDuration,
      setVolume: (volume) => control(['setVolume'], clamp(volume)),
      seek(seconds) {
        const duration = getDuration();
        if (!duration) throw new Error('Eagle.player.seek: nothing is playing');
        control(['seek'], clamp(seconds / duration));
      },
      play: () => control(['play']),
      pause: () => control(['pause']),
      togglePlay() {
        const controls = safely(() => dz().control, null);
        if (controls && typeof controls.togglePause === 'function') return controls.togglePause();
        return isPlaying() ? control(['pause']) : control(['play']);
      },
      next: () => control(['nextSong', 'next']),
      previous: () => control(['prevSong', 'previous', 'prev']),
      on(event, listener) {
        if (!listeners[event]) throw new Error(`Eagle.player: unknown event "${event}" (track, playing, volume)`);
        listeners[event].add(listener);
        return function unsubscribe() {
          listeners[event].delete(listener);
        };
      },
    });
  })();

  // ---- Themes ----------------------------------------------------------

  // A theme is a palette. Eagle turns it into Deezer's colour variables and
  // into the "tempo" design tokens the app's components read, found live in
  // the page so new tokens are themed too.
  const TEMPO = '--tempo-colors-';
  const TOKEN_STATES = new Set(['default', 'hovered', 'pressed', 'selected', 'disabled', 'focused']);
  const DEEZER_PALETTE = {
    '--color-bg-main': 'bg',
    '--color-bg-secondary': 'surface',
    '--color-bg-tertiary': 'surface-hover',
    '--color-bg-tertiary-hover': 'surface-pressed',
    '--color-bg-tertiary-pressed': 'surface-pressed',
    '--color-bg-contrast': 'surface-hover',
    '--color-bg-inverse': 'text',
    '--color-text-main': 'text',
    '--color-text-secondary': 'text-secondary',
    '--color-text-disabled': 'text-disabled',
    '--color-text-inverse': 'bg',
    '--color-border-neutral-primary': 'border',
    '--color-border-neutral-secondary': 'text',
    '--color-divider-main': 'border',
    '--color-neutral-main': 'border',
    '--color-neutral-strong': 'text-disabled',
    '--color-neutral-weak': 'surface-hover',
    '--color-accent-main': 'accent',
    '--color-accent-strong': 'accent-strong',
    '--color-accent-weak': 'accent-weak',
    '--color-accent-light': 'accent-weak',
    '--color-feedback-error': 'error',
    '--color-feedback-success': 'success',
    '--color-feedback-warning': 'warning',
  };

  // --tempo-colors-<kind>-<family>-<variant…>-<state> to a palette entry.
  function tempoTarget(name) {
    const parts = name.slice(TEMPO.length).split('-');
    const kind = parts[0];
    const state = TOKEN_STATES.has(parts[parts.length - 1]) ? parts.pop() : 'default';
    const family = parts[1];
    const variant = parts.slice(2).join('').toLowerCase();
    const active = state === 'hovered' || state === 'pressed' || state === 'selected';
    if (family === 'feedback') return ['error', 'success', 'warning'].includes(parts[2]) ? `--eagle-${parts[2]}` : null;
    if (family === 'accent') {
      if (variant.includes('onaccent')) return '--eagle-on-accent';
      if (state === 'disabled') return '--eagle-accent-weak';
      return active ? '--eagle-accent-strong' : '--eagle-accent';
    }
    if (family === 'cover' || kind === 'divider') return '--eagle-border';
    if (family === 'color' && variant === 'secondary') return '--eagle-text-secondary';
    if (family !== 'neutral') return null;
    if (variant === 'inverse') return kind === 'background' ? '--eagle-text' : '--eagle-bg';
    if (kind === 'background') {
      if (variant === 'primary') {
        if (state === 'default') return '--eagle-bg';
        if (state === 'disabled') return '--eagle-surface';
        return state === 'hovered' ? '--eagle-surface-hover' : '--eagle-surface-pressed';
      }
      if (variant === 'secondary') {
        if (state === 'default' || state === 'disabled') return '--eagle-surface';
        return state === 'hovered' ? '--eagle-surface-hover' : '--eagle-surface-pressed';
      }
      if (variant === 'tertiary') return state === 'default' || state === 'disabled' ? '--eagle-surface-hover' : '--eagle-surface-pressed';
      return null; // onDark/onLight sit on top of artwork: leave them alone.
    }
    if (kind === 'border') return state === 'default' || state === 'disabled' ? '--eagle-border' : '--eagle-text-secondary';
    if (kind === 'text' || kind === 'icon') {
      if (state === 'disabled' || variant === 'tertiary') return '--eagle-text-disabled';
      if (variant === 'primary') return '--eagle-text';
      if (variant === 'secondary') return '--eagle-text-secondary';
    }
    return null;
  }

  function tempoTokens() {
    const names = new Set();
    const collect = (style) => {
      for (let i = 0; i < style.length; i++) if (style[i].startsWith(TEMPO)) names.add(style[i]);
    };
    for (const target of [document.documentElement, document.body]) if (target) collect(getComputedStyle(target));
    for (const sheet of Array.from(document.styleSheets)) {
      const rules = safely(() => Array.from(sheet.cssRules), []);
      rules.forEach((rule) => rule.style && collect(rule.style));
    }
    return Array.from(names);
  }

  function themePalette(theme) {
    const colors = theme.colors || {};
    const mix = (a, b, percent) => `color-mix(in srgb, ${a} ${percent}%, ${b})`;
    const bg = colors.background || '#121216';
    const text = colors.text || '#f2f2f5';
    const accent = colors.accent || '#a238ff';
    return {
      '--eagle-bg': bg,
      '--eagle-surface': colors.surface || mix(bg, text, 94),
      '--eagle-surface-hover': colors.surfaceHover || mix(bg, text, 86),
      '--eagle-surface-pressed': mix('var(--eagle-surface-hover)', text, 88),
      '--eagle-text': text,
      '--eagle-text-secondary': colors.textSecondary || mix(text, bg, 68),
      '--eagle-text-disabled': mix(text, bg, 40),
      '--eagle-accent': accent,
      '--eagle-accent-strong': colors.accentHover || mix(accent, text, 82),
      '--eagle-accent-weak': mix(accent, bg, 50),
      '--eagle-on-accent': colors.onAccent || '#ffffff',
      '--eagle-border': colors.border || mix(text, bg, 16),
      '--eagle-error': colors.error || '#df3c3c',
      '--eagle-success': colors.success || '#00b23d',
      '--eagle-warning': colors.warning || '#ec7f11',
    };
  }

  function themeCss(theme) {
    const declarations = [`color-scheme: ${theme.dark === false ? 'light' : 'dark'};`];
    for (const [name, value] of Object.entries(themePalette(theme))) declarations.push(`${name}: ${value};`);
    for (const [name, target] of Object.entries(DEEZER_PALETTE)) declarations.push(`${name}: var(--eagle-${target}) !important;`);
    for (const name of tempoTokens()) {
      const target = tempoTarget(name);
      if (target) declarations.push(`${name}: var(${target}) !important;`);
    }
    return `:root, :root[data-theme], body {\n  ${declarations.join('\n  ')}\n}\n${theme.css || ''}`;
  }

  let activeTheme = null;
  let removeTheme = null;

  function applyTheme(id) {
    if (removeTheme) removeTheme();
    removeTheme = null;
    activeTheme = id && themes.has(id) ? id : null;
    if (activeTheme) removeTheme = insertSheet(themeCss(themes.get(activeTheme)));
  }

  applyTheme(boot.theme);
  // The app defines more tokens once it has rendered: theme those too.
  waitFor('#page_content', { timeout: 60000 }).then(
    () => setTimeout(() => activeTheme && applyTheme(activeTheme), 500),
    () => {},
  );

  // ---- CSS-only mods ---------------------------------------------------

  // Mods without a script are just CSS: they switch on and off live.
  const modSheets = new Map();

  function setModCss(info, enabled) {
    if (enabled && info.css && !modSheets.has(info.id)) modSheets.set(info.id, insertSheet(info.css));
    if (!enabled && modSheets.has(info.id)) {
      modSheets.get(info.id)();
      modSheets.delete(info.id);
    }
  }

  for (const info of mods.values()) {
    if (info.hasScript) continue;
    if (info.error) {
      info.status = 'error';
    } else if (info.enabled) {
      safely(() => setModCss(info, true));
      info.status = 'ok';
    }
  }

  // ---- UI root ---------------------------------------------------------

  // Deezer's colour variables inherit into the shadow root, so the library
  // follows light/dark mode and themes. Fallbacks are Deezer's defaults.
  const UI_CSS = `
    * { box-sizing: border-box; font-family: inherit; }
    button, input, select { font: inherit; color: inherit; }
    button { cursor: pointer; border: 0; }
    button:disabled { cursor: default; opacity: .6; }
    .toasts { position: fixed; right: 24px; bottom: 104px; z-index: 2147483647; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; pointer-events: none; }
    .toast { background: var(--color-bg-inverse, #121216); color: var(--color-text-inverse, #fff); border-radius: 8px; padding: 12px 16px; font-size: 14px; max-width: 380px; box-shadow: 0 8px 24px rgba(0,0,0,.3); }
    .launcher { position: fixed; top: 16px; right: 136px; z-index: 2147483000; width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; background: var(--color-bg-tertiary, #ebe7ee); color: var(--color-text-main, #0f0d13); }
    .library { position: fixed; z-index: 2147483000; display: flex; flex-direction: column; background: var(--color-bg-main, #fdfcfe); color: var(--color-text-main, #0f0d13); font-size: 14px; }
    .scroll { flex: 1; overflow-y: auto; padding: 32px 40px 48px; }
    .head { display: flex; align-items: center; gap: 16px; }
    .logo { width: 56px; height: 56px; border-radius: 14px; display: grid; place-items: center; color: #fff; background: linear-gradient(135deg, var(--color-accent-main, #a238ff), #ff5c8a); }
    h1 { margin: 0; font-size: 36px; line-height: 1.1; font-weight: 800; letter-spacing: -.02em; }
    h2 { margin: 28px 0 12px; font-size: 20px; font-weight: 700; }
    .muted { color: var(--color-text-secondary, #6f6d71); }
    .close { margin-left: auto; width: 40px; height: 40px; border-radius: 50%; font-size: 22px; background: transparent; }
    .close:hover { background: var(--color-bg-tertiary, #ebe7ee); }
    .tabs { display: flex; flex-wrap: wrap; gap: 8px; margin: 24px 0 8px; }
    .tab { padding: 8px 16px; border-radius: 999px; font-weight: 600; background: var(--color-bg-tertiary, #ebe7ee); }
    .tab:hover { background: var(--color-bg-tertiary-hover, #e1dde4); }
    .tab[aria-selected="true"] { background: var(--color-text-main, #0f0d13); color: var(--color-bg-main, #fdfcfe); }
    .notice { display: flex; align-items: center; gap: 12px; margin: 16px 0 0; padding: 12px 16px; border-radius: 8px; background: var(--color-bg-secondary, #f5f2f8); }
    .notice .button { margin-left: auto; }
    .toolbar { display: flex; align-items: center; gap: 12px; margin: 20px 0 4px; }
    .toolbar .button { margin-left: auto; }
    .search, .field { height: 40px; padding: 0 14px; border-radius: 8px; border: 0; background: var(--color-bg-tertiary, #ebe7ee); outline: none; }
    .search { flex: 1; max-width: 420px; }
    .search:focus, .field:focus { box-shadow: 0 0 0 2px var(--color-accent-main, #a238ff); }
    .list { display: grid; gap: 8px; }
    .card { border-radius: 8px; background: var(--color-bg-secondary, #f5f2f8); }
    .row { display: flex; align-items: center; gap: 16px; padding: 12px 16px; }
    .avatar { flex: none; width: 48px; height: 48px; border-radius: 8px; display: grid; place-items: center; font-size: 20px; font-weight: 800; color: #fff; background: linear-gradient(135deg, var(--color-accent-main, #a238ff), #5c6bff); }
    .info { flex: 1; min-width: 0; }
    .title { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-weight: 700; font-size: 15px; }
    .desc { margin-top: 2px; }
    .meta { margin-top: 2px; font-size: 12px; }
    .badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--color-bg-tertiary, #ebe7ee); color: var(--color-text-secondary, #6f6d71); }
    .badge.accent { color: var(--color-accent-main, #a238ff); }
    .badge.update { background: var(--color-accent-main, #a238ff); color: var(--eagle-on-accent, #fff); }
    .badge.error { color: var(--color-feedback-error, #df3c3c); }
    .error { white-space: pre-wrap; margin: 6px 0 0; font: 12px/1.4 Consolas, monospace; color: var(--color-feedback-error, #df3c3c); max-height: 120px; overflow: auto; }
    .actions { display: flex; align-items: center; gap: 8px; flex: none; }
    .button { padding: 8px 18px; border-radius: 999px; font-weight: 600; background: var(--color-accent-main, #a238ff); color: var(--eagle-on-accent, #fff); white-space: nowrap; }
    .button:hover:not(:disabled) { filter: brightness(1.08); }
    .button.secondary { background: var(--color-bg-tertiary, #ebe7ee); color: var(--color-text-main, #0f0d13); }
    .icon-button { width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; background: transparent; font-size: 18px; }
    .icon-button:hover, .icon-button[aria-expanded="true"] { background: var(--color-bg-tertiary, #ebe7ee); }
    .switch { position: relative; flex: none; width: 40px; height: 24px; border-radius: 999px; background: var(--color-neutral-main, #d1d1d6); transition: background .15s; }
    .switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform .15s; box-shadow: 0 1px 3px rgba(0,0,0,.3); }
    .switch[aria-checked="true"] { background: var(--color-accent-main, #a238ff); }
    .switch[aria-checked="true"]::after { transform: translateX(16px); }
    .settings { display: grid; gap: 12px; padding: 4px 16px 16px 80px; }
    .setting { display: flex; align-items: center; gap: 16px; }
    .setting .info { font-size: 13px; }
    .setting .field { width: 200px; height: 36px; }
    .setting input[type="color"] { width: 56px; padding: 2px 4px; }
    .setting input[type="number"] { width: 96px; }
    .empty { padding: 24px 0; }
    .footer { margin-top: 32px; font-size: 13px; }
    code { font-family: Consolas, monospace; padding: 1px 6px; border-radius: 4px; background: var(--color-bg-tertiary, #ebe7ee); }
    .themes { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
    .theme { display: flex; flex-direction: column; border-radius: 12px; overflow: hidden; background: var(--color-bg-secondary, #f5f2f8); outline: 2px solid transparent; }
    .theme.active { outline-color: var(--color-accent-main, #a238ff); }
    .theme .body { display: flex; align-items: center; gap: 8px; padding: 12px 14px; }
    .theme .body .info { font-weight: 700; }
    .theme .body .info > div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .preview .remove { position: absolute; top: 8px; right: 8px; width: 28px; height: 28px; border-radius: 50%; background: rgba(0,0,0,.5); color: #fff; font-size: 12px; opacity: 0; transition: opacity .15s; }
    .theme:hover .remove, .preview .remove:focus-visible { opacity: 1; }
    .preview { position: relative; height: 112px; display: flex; }
    .preview .side { width: 30%; padding: 12px 8px; display: grid; align-content: start; gap: 6px; }
    .preview .main { flex: 1; padding: 14px 12px; display: grid; align-content: start; gap: 8px; }
    .preview .line { height: 8px; border-radius: 4px; }
    .preview .pill { width: 44px; height: 16px; border-radius: 999px; margin-top: 4px; }
    .swatches { display: flex; gap: 4px; }
    .swatch { width: 16px; height: 16px; border-radius: 50%; box-shadow: inset 0 0 0 1px rgba(127,127,127,.3); }
    .panel { display: grid; gap: 4px; margin-top: 20px; }
    .panel .row { border-radius: 8px; background: var(--color-bg-secondary, #f5f2f8); }
    .keys { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; padding: 12px 16px; }
    kbd { font-family: Consolas, monospace; font-size: 12px; padding: 2px 6px; border-radius: 4px; background: var(--color-bg-tertiary, #ebe7ee); }
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

  function switchButton(checked, label, onToggle) {
    const node = button('switch', null, onToggle);
    node.setAttribute('role', 'switch');
    node.setAttribute('aria-checked', String(Boolean(checked)));
    node.setAttribute('aria-label', label);
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

  // ---- Library state ---------------------------------------------------

  const library = {
    node: null,
    tab: 'installed',
    query: '',
    installed: null,
    market: null,
    marketLoading: false,
    updates: null,
    settings: null,
    needsReload: false,
    busy: new Set(),
    expanded: new Set(),
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

  // Everything installed, as the core lists it (or as this page booted).
  function installedEntries() {
    return library.installed || boot.mods.concat(boot.themes || []).map((info) => Object.assign({ linked: false, source: null }, info));
  }

  function installedMods() {
    return installedEntries()
      .filter((entry) => entry.type !== 'theme')
      .map((entry) => {
        const runtime = mods.get(entry.id);
        return Object.assign({}, entry, {
          status: runtime ? runtime.status : 'new',
          error: runtime ? runtime.error : null,
        });
      });
  }

  function installedThemes() {
    return installedEntries()
      .filter((entry) => entry.type === 'theme')
      .map((entry) => Object.assign({}, entry, themes.get(entry.id) || {}));
  }

  function updateFor(id) {
    return library.updates && library.updates.mods[id];
  }

  function eagleUpdate() {
    const updates = library.updates;
    return updates && updates.eagle.latest && compareVersions(updates.eagle.latest, updates.eagle.current) > 0 ? updates.eagle.latest : null;
  }

  function compareVersions(a, b) {
    const parts = (version) => String(version || '').split(/[.+-]/).slice(0, 3).map((part) => parseInt(part, 10) || 0);
    const [left, right] = [parts(a), parts(b)];
    for (let i = 0; i < 3; i++) if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) > (right[i] || 0) ? 1 : -1;
    return 0;
  }

  function changed(needsReload) {
    if (needsReload) library.needsReload = true;
    refreshInstalled();
  }

  function refreshInstalled() {
    if (!bridge) return renderLibrary();
    bridge.list().then(
      (list) => {
        library.installed = list;
        for (const entry of list) {
          if (entry.type === 'theme' && !themes.has(entry.id)) themes.set(entry.id, entry);
        }
        renderLibrary();
      },
      (err) => report(err),
    );
  }

  function checkUpdates() {
    if (!bridge) return;
    bridge.checkUpdates().then(
      (updates) => {
        library.updates = updates;
        markSidebarUpdates(Boolean(eagleUpdate()) || Object.keys(updates.mods).length > 0);
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

  // ---- Library: Mods tab -------------------------------------------------

  function settingControl(mod, definition) {
    const value = readSetting(mod.id, definition);
    const save = (next) => writeSetting(mod.id, definition.key, next);
    if (definition.type === 'toggle') {
      const toggle = switchButton(value, definition.label, () => {
        const next = toggle.getAttribute('aria-checked') !== 'true';
        toggle.setAttribute('aria-checked', String(next));
        save(next);
      });
      return toggle;
    }
    if (definition.type === 'select') {
      const select = element('select', 'field');
      for (const option of definition.options || []) {
        const node = element('option', null, option.label);
        node.value = String(option.value);
        node.selected = String(option.value) === String(value);
        select.append(node);
      }
      select.addEventListener('change', () => {
        const option = (definition.options || []).find((candidate) => String(candidate.value) === select.value);
        save(option ? option.value : select.value);
      });
      return select;
    }
    const input = element('input', 'field');
    input.type = definition.type === 'number' ? 'number' : definition.type === 'color' ? 'color' : 'text';
    for (const name of ['min', 'max', 'step']) if (definition[name] != null) input[name] = String(definition[name]);
    input.value = value == null ? '' : String(value);
    input.addEventListener('change', () => {
      if (definition.type !== 'number') return save(input.value);
      let next = Number(input.value);
      if (!Number.isFinite(next)) next = definition.default;
      if (definition.min != null) next = Math.max(definition.min, next);
      if (definition.max != null) next = Math.min(definition.max, next);
      input.value = String(next);
      save(next);
    });
    return input;
  }

  function renderSettings(mod) {
    const panel = element('div', 'settings');
    for (const definition of mod.settings) {
      const row = element('div', 'setting');
      const info = element('div', 'info');
      info.append(element('div', '', definition.label));
      if (definition.description) info.append(element('div', 'muted', definition.description));
      row.append(info, settingControl(mod, definition));
      panel.append(row);
    }
    return panel;
  }

  function toggleMod(mod, enabled) {
    return bridge.setEnabled(mod.id, enabled).then(
      () => {
        const runtime = mods.get(mod.id);
        if (runtime && !mod.hasScript) {
          setModCss(runtime, enabled);
          runtime.status = enabled ? 'ok' : 'disabled';
          return changed(false);
        }
        return changed(true);
      },
      (err) => {
        notify(`Could not change ${mod.name}: ${err.message || err}`);
        renderLibrary();
      },
    );
  }

  function updateMod(mod) {
    library.busy.add(`update:${mod.id}`);
    renderLibrary();
    bridge.update(mod.id).then(
      (result) => {
        library.busy.delete(`update:${mod.id}`);
        notify(result.ok ? `${mod.name} updated.` : lastLines(result.output, 2) || `Could not update ${mod.name}.`, { timeout: 6000 });
        if (library.updates) delete library.updates.mods[mod.id];
        changed(true);
      },
      (err) => {
        library.busy.delete(`update:${mod.id}`);
        notify(`Could not update ${mod.name}: ${err.message || err}`);
        renderLibrary();
      },
    );
  }

  function removeEntry(entry) {
    if (!window.confirm(`Remove "${entry.name}"?`)) return;
    bridge.remove(entry.id).then(
      () => {
        notify(`${entry.name} removed.`);
        if (entry.type === 'theme') {
          if (activeTheme === entry.id) applyTheme(null);
          themes.delete(entry.id);
          return changed(false);
        }
        const runtime = mods.get(entry.id);
        if (runtime && !entry.hasScript) setModCss(runtime, false);
        return changed(Boolean(entry.hasScript && runtime && runtime.status !== 'disabled'));
      },
      (err) => notify(`Could not remove ${entry.name}: ${err.message || err}`),
    );
  }

  function renderModCard(mod) {
    const card = element('div', 'card');
    card.dataset.mod = mod.id;
    const row = element('div', 'row');
    row.append(element('div', 'avatar', (mod.name || mod.id).charAt(0).toUpperCase()));

    const info = element('div', 'info');
    const title = element('div', 'title');
    title.append(element('span', '', mod.name));
    if (mod.version) title.append(element('span', 'muted', `v${mod.version}`));
    if (isOfficial(mod)) title.append(element('span', 'badge accent', 'Official'));
    if (mod.linked) title.append(element('span', 'badge', 'Dev link'));
    if (updateFor(mod.id)) title.append(element('span', 'badge update', `Update: v${updateFor(mod.id)}`));
    if (mod.enabled && mod.status === 'error') title.append(element('span', 'badge error', 'Error'));
    const running = mod.status === 'ok' || mod.status === 'error' || mod.status === 'loading';
    if (Boolean(mod.enabled) !== running && (mod.hasScript || mod.status === 'new')) title.append(element('span', 'badge', 'Reload to apply'));
    info.append(title);
    if (mod.description) info.append(element('div', 'desc muted', mod.description));
    const meta = [mod.author && `by ${mod.author}`, sourceLabel(mod)].filter(Boolean).join(' · ');
    if (meta) info.append(element('div', 'meta muted', meta));
    if (mod.enabled && mod.error) info.append(element('pre', 'error', mod.error));
    row.append(info);

    if (bridge) {
      const actions = element('div', 'actions');
      if ((mod.settings || []).length > 0) {
        const gear = button('icon-button', '⚙', () => {
          if (library.expanded.has(mod.id)) library.expanded.delete(mod.id);
          else library.expanded.add(mod.id);
          renderLibrary();
        });
        gear.dataset.action = 'settings';
        gear.setAttribute('aria-expanded', String(library.expanded.has(mod.id)));
        gear.setAttribute('aria-label', `Settings of ${mod.name}`);
        gear.title = 'Settings';
        actions.append(gear);
      }
      if (updateFor(mod.id)) {
        const busy = library.busy.has(`update:${mod.id}`);
        const update = button('button', busy ? 'Updating...' : 'Update', () => updateMod(mod));
        update.disabled = busy;
        actions.append(update);
      }
      const toggle = switchButton(mod.enabled, `${mod.enabled ? 'Disable' : 'Enable'} ${mod.name}`, () => {
        toggle.disabled = true;
        toggleMod(mod, !mod.enabled);
      });
      const remove = button('button secondary', 'Remove', () => removeEntry(mod));
      remove.setAttribute('aria-label', `Remove ${mod.name}`);
      actions.append(toggle, remove);
      row.append(actions);
    }
    card.append(row);
    if (library.expanded.has(mod.id) && (mod.settings || []).length > 0) card.append(renderSettings(mod));
    return card;
  }

  function renderMods(container) {
    const list = installedMods();
    if (bridge) {
      const toolbar = element('div', 'toolbar');
      toolbar.append(element('span', 'muted', `${list.filter((mod) => mod.enabled).length} of ${list.length} mods enabled`));
      const busy = library.busy.has('update');
      const update = button('button secondary', busy ? 'Updating...' : 'Update all', () => {
        library.busy.add('update');
        renderLibrary();
        bridge.update().then(
          (result) => {
            library.busy.delete('update');
            notify(lastLines(result.output, 3) || 'Mods are up to date.', { timeout: 6000 });
            if (library.updates) library.updates.mods = {};
            changed(true);
          },
          (err) => {
            library.busy.delete('update');
            notify(`Update failed: ${err.message || err}`);
            renderLibrary();
          },
        );
      });
      update.disabled = busy;
      toolbar.append(update);
      container.append(toolbar);
    }
    if (list.length === 0) {
      container.append(element('div', 'empty muted', 'No mods installed yet. Have a look at the Marketplace.'));
      return;
    }
    const grid = element('div', 'list');
    list.forEach((mod) => grid.append(renderModCard(mod)));
    container.append(grid);
  }

  // ---- Library: Themes tab -----------------------------------------------

  const DEEZER_LIGHT = { background: '#fdfcfe', surface: '#f5f2f8', text: '#0f0d13', textSecondary: '#6f6d71', accent: '#a238ff' };
  const DEEZER_DARK = { background: '#0f0d13', surface: '#1b191f', text: '#fdfcfe', textSecondary: '#a9a6aa', accent: '#a238ff' };

  // A tiny Deezer window in the theme's colours.
  function themePreview(colors, darkHalf) {
    const palette = Object.assign({}, DEEZER_DARK, colors || {});
    const preview = element('div', 'preview');
    preview.style.background = darkHalf
      ? `linear-gradient(135deg, ${DEEZER_LIGHT.background} 50%, ${DEEZER_DARK.background} 50%)`
      : palette.background;
    const side = element('div', 'side');
    side.style.background = darkHalf ? 'transparent' : palette.surface || palette.background;
    for (const width of ['80%', '60%', '70%']) {
      const line = element('div', 'line');
      line.style.width = width;
      line.style.background = darkHalf ? '#a2a2ad' : palette.textSecondary || palette.text;
      side.append(line);
    }
    const main = element('div', 'main');
    [
      ['70%', darkHalf ? '#6f6d71' : palette.text],
      ['90%', darkHalf ? '#a2a2ad' : palette.textSecondary || palette.text],
      ['55%', darkHalf ? '#a2a2ad' : palette.textSecondary || palette.text],
    ].forEach(([width, color]) => {
      const line = element('div', 'line');
      line.style.width = width;
      line.style.background = color;
      main.append(line);
    });
    const pill = element('div', 'pill');
    pill.style.background = palette.accent;
    main.append(pill);
    preview.append(side, main);
    return preview;
  }

  function chooseTheme(id) {
    const previous = activeTheme;
    applyTheme(id);
    renderLibrary();
    if (!bridge) return;
    bridge.setTheme(id).catch((err) => {
      applyTheme(previous);
      notify(`Could not change the theme: ${err.message || err}`);
      renderLibrary();
    });
  }

  function renderThemeCard(theme) {
    const isDefault = theme === null;
    const id = isDefault ? null : theme.id;
    const active = activeTheme === id;
    const card = element('div', active ? 'theme active' : 'theme');
    card.dataset.theme = isDefault ? 'default' : theme.id;
    const preview = themePreview(isDefault ? null : theme.colors, isDefault);
    if (!isDefault && bridge && !active) {
      const remove = button('remove', '✕', () => removeEntry(theme));
      remove.title = 'Remove';
      remove.setAttribute('aria-label', `Remove ${theme.name}`);
      preview.append(remove);
    }
    card.append(preview);
    const body = element('div', 'body');
    const info = element('div', 'info');
    info.append(element('div', '', isDefault ? 'Deezer' : theme.name));
    info.append(element('div', 'meta muted', isDefault ? 'Original colours' : theme.author ? `by ${theme.author}` : ''));
    body.append(info);
    const apply = button(active ? 'button secondary' : 'button', active ? 'Active' : 'Apply', () => chooseTheme(id));
    apply.disabled = active;
    body.append(apply);
    card.append(body);
    return card;
  }

  function renderThemes(container) {
    const list = installedThemes();
    container.append(element('div', 'toolbar muted', 'Themes apply instantly and follow Deezer everywhere, including the Eagle library.'));
    const grid = element('div', 'themes');
    grid.append(renderThemeCard(null));
    list.forEach((theme) => grid.append(renderThemeCard(theme)));
    container.append(grid);
    const footer = element('div', 'footer muted');
    footer.append(
      'More themes in the Marketplace. Make your own: a theme is a ',
      element('code', '', 'manifest.json'),
      ' with a colour palette.',
    );
    container.append(footer);
  }

  // ---- Library: Marketplace tab ------------------------------------------

  function isInstalledSpec(entry) {
    const list = installedEntries();
    if (entry.id) return list.some((mod) => mod.id === entry.id);
    const spec = entry.spec.toLowerCase();
    return list.some((mod) => mod.source && String(mod.source.repo).toLowerCase() === spec);
  }

  function installEntry(entry) {
    library.busy.add(entry.spec);
    renderLibrary();
    bridge.install(entry.spec).then(
      (result) => {
        library.busy.delete(entry.spec);
        if (result.ok) {
          notify(`${entry.name} installed.`);
          changed(entry.type !== 'theme');
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
  }

  function renderMarketCard(entry, official) {
    const card = element('div', 'card');
    card.dataset.spec = entry.spec;
    const row = element('div', 'row');
    if (entry.type === 'theme' && entry.colors && entry.colors.background) {
      const swatches = element('div', 'avatar');
      swatches.style.background = `linear-gradient(135deg, ${entry.colors.background} 55%, ${entry.colors.accent || entry.colors.text} 55%)`;
      row.append(swatches);
    } else {
      row.append(element('div', 'avatar', (entry.name || entry.spec).charAt(0).toUpperCase()));
    }
    const info = element('div', 'info');
    const title = element('div', 'title');
    title.append(element('span', '', entry.name));
    if (official) title.append(element('span', 'badge accent', 'Official'));
    if (entry.type === 'theme') title.append(element('span', 'badge', 'Theme'));
    if (entry.stars) title.append(element('span', 'muted', `★ ${entry.stars}`));
    info.append(title);
    if (entry.description) info.append(element('div', 'desc muted', entry.description));
    const meta = [entry.author && `by ${entry.author}`, official ? '' : entry.spec].filter(Boolean).join(' · ');
    if (meta) info.append(element('div', 'meta muted', meta));
    row.append(info);

    const actions = element('div', 'actions');
    const installed = isInstalledSpec(entry);
    const busy = library.busy.has(entry.spec);
    const install = button(installed ? 'button secondary' : 'button', installed ? 'Installed' : busy ? 'Installing...' : 'Install', () => installEntry(entry));
    install.disabled = installed || busy;
    actions.append(install);
    row.append(actions);
    card.append(row);
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
    search.placeholder = 'Search mods and themes';
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
      ['Official mods', official.filter((entry) => entry.type !== 'theme'), true],
      ['Official themes', official.filter((entry) => entry.type === 'theme'), true],
      ['Community', market.community, false],
    ];
    for (const [heading, entries, isOfficialSection] of sections) {
      container.append(element('h2', '', heading));
      if (entries.length === 0) {
        container.append(element('div', 'empty muted', isOfficialSection ? 'Nothing matches.' : 'No community mod found.'));
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

  // ---- Library: Settings tab ---------------------------------------------

  function settingRow(title, description, control) {
    const row = element('div', 'row');
    const info = element('div', 'info');
    info.append(element('div', 'title', title));
    if (description) info.append(element('div', 'desc muted', description));
    row.append(info, control);
    return row;
  }

  function renderEagleSettings(container) {
    const panel = element('div', 'panel');
    const latest = eagleUpdate();
    let versionControl;
    if (latest && bridge) {
      versionControl = button('button', library.busy.has('upgrade') ? 'Updating...' : `Update to v${latest}`, () => {
        library.busy.add('upgrade');
        renderLibrary();
        notify('Updating Deezer Eagle: Deezer will restart in a moment.', { timeout: 10000 });
        bridge.upgrade().catch((err) => {
          library.busy.delete('upgrade');
          notify(`Update failed: ${err.message || err}`);
          renderLibrary();
        });
      });
      versionControl.disabled = library.busy.has('upgrade');
    } else {
      versionControl = element('span', 'badge', library.updates ? 'Up to date' : 'Checking...');
    }
    panel.append(settingRow(`Deezer Eagle v${boot.version}`, 'Mods and themes for Deezer Desktop.', versionControl));

    if (bridge) {
      const settings = library.settings;
      const devtools = switchButton(settings && settings.devtools, 'Developer tools', () => {
        const next = devtools.getAttribute('aria-checked') !== 'true';
        devtools.setAttribute('aria-checked', String(next));
        bridge.setDevtools(next).then(
          () => notify(next ? 'Developer tools: press Ctrl+Shift+I.' : 'Developer tools turned off.'),
          (err) => notify(`Could not change it: ${err.message || err}`),
        );
      });
      devtools.disabled = !settings;
      panel.append(settingRow('Developer tools', 'Ctrl+Shift+I opens the inspector and console, to build mods.', devtools));
      panel.append(
        settingRow(
          'Your CSS',
          'user.css is applied after every mod and theme. Reload Deezer after saving it.',
          button('button secondary', 'Edit user.css', () => bridge.open('user-css')),
        ),
      );
      panel.append(
        settingRow(
          'Eagle folder',
          settings ? settings.home : 'Mods, logs and configuration.',
          button('button secondary', 'Open', () => bridge.open('folder')),
        ),
      );
    }
    panel.append(settingRow('Reload Deezer', 'Applies mod changes.', button('button secondary', 'Reload', () => location.reload())));
    container.append(panel);

    container.append(element('h2', '', 'Shortcuts'));
    const keys = element('div', 'card keys');
    [
      ['Ctrl+Shift+E', 'Open or close Eagle'],
      ['Ctrl+Shift+R', 'Reload Deezer'],
      ['Esc', 'Close Eagle'],
      ['Ctrl+Shift+I', 'Developer tools (when enabled)'],
    ].forEach(([key, label]) => keys.append(element('kbd', '', key), element('span', '', label)));
    container.append(keys);
  }

  // ---- Library: frame ----------------------------------------------------

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
    const playerBar = rect('#page_player');
    const left = Math.max(content ? content.left : 0, sidebar ? sidebar.right : 0);
    node.style.left = `${left}px`;
    node.style.right = `${content ? Math.max(0, window.innerWidth - content.right) : 0}px`;
    node.style.top = `${topbar ? topbar.bottom : 0}px`;
    node.style.bottom = `${playerBar ? Math.max(0, window.innerHeight - playerBar.top) : 0}px`;
  }

  const TABS = [
    ['installed', () => `Mods (${installedMods().length})`],
    ['themes', () => 'Themes'],
    ['marketplace', () => 'Marketplace'],
    ['settings', () => 'Settings'],
  ];

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
    for (const [id, label] of TABS) {
      const tab = button('tab', label(), () => {
        library.tab = id;
        renderLibrary();
      });
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(library.tab === id));
      tab.dataset.tab = id;
      if (id === 'settings' && eagleUpdate()) tab.textContent += ' •';
      tabs.append(tab);
    }
    body.append(tabs);

    if (library.needsReload) {
      const notice = element('div', 'notice');
      notice.append(element('span', '', 'Some changes apply once Deezer reloads.'), button('button', 'Reload now', () => location.reload()));
      body.append(notice);
    }

    if (library.tab === 'themes') renderThemes(body);
    else if (library.tab === 'marketplace') renderMarketplace(body);
    else if (library.tab === 'settings') renderEagleSettings(body);
    else renderMods(body);
    node.append(body);
    body.scrollTop = scrollTop;
    if (keepSearchFocus) {
      const search = body.querySelector('.search');
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    }
  }

  function openLibrary(tab) {
    if (tab) library.tab = tab === 'mods' ? 'installed' : tab;
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
      if (bridge) {
        bridge.settings().then(
          (settings) => {
            library.settings = settings;
            renderLibrary();
          },
          (err) => report(err),
        );
        if (!library.updates) checkUpdates();
      }
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

  // ---- Sidebar entry ---------------------------------------------------

  let sidebarEntry = null;
  let sidebarHasUpdates = false;

  // Finds Deezer's primary navigation (Home, Explore...) from the Home row,
  // whose icon is HouseFilledIcon or HouseOutlinedIcon, and returns the list
  // and its rows, however deeply each link is wrapped.
  function findNavigation() {
    const home = document.querySelector('a:has(svg[data-testid^="House"])');
    if (!home) return null;
    let row = home;
    for (let depth = 0; depth < 5 && row.parentElement; depth++) {
      const list = row.parentElement;
      const rows = Array.from(list.children).filter(
        (child) => child.querySelector('svg[data-testid$="Icon"]') && (child.matches('a') || child.querySelector('a')),
      );
      if (rows.length >= 2) return { list, rows };
      row = list;
    }
    return null;
  }

  function entryLink() {
    return sidebarEntry && (sidebarEntry.matches('a') ? sidebarEntry : sidebarEntry.querySelector('a'));
  }

  function markSidebarEntry(active) {
    const link = entryLink();
    if (link) link.style.background = active ? 'var(--color-bg-tertiary, #ebe7ee)' : '';
  }

  // A small accent dot on the entry when updates are waiting.
  function markSidebarUpdates(hasUpdates) {
    sidebarHasUpdates = hasUpdates;
    const link = entryLink();
    if (!link) return;
    let dot = link.querySelector('[data-eagle="update-dot"]');
    if (hasUpdates && !dot) {
      dot = element('span');
      dot.dataset.eagle = 'update-dot';
      dot.title = 'Updates available';
      Object.assign(dot.style, { display: 'inline-block', width: '8px', height: '8px', marginLeft: '6px', borderRadius: '50%', background: 'var(--color-accent-main, #a238ff)', flex: 'none' });
      link.append(dot);
    } else if (!hasUpdates && dot) {
      dot.remove();
    }
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
    markSidebarUpdates(sidebarHasUpdates);
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
      settings: createSettings(info),
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
    get theme() {
      return activeTheme;
    },
    player,
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
    __userStyle: addUserStyle,
  };

  Object.defineProperty(window, 'Eagle', { value: Object.freeze(api), enumerable: false });

  if (document.body) keepSidebarEntry();
  else document.addEventListener('DOMContentLoaded', keepSidebarEntry, { once: true });
  // Look for updates a little after start-up, to show the sidebar dot.
  if (bridge) setTimeout(checkUpdates, 15000);

  const active = boot.mods.filter((info) => info.enabled).length;
  console.log(PREFIX, `v${boot.version}, ${active} active mod(s). Open Eagle from the sidebar or press Ctrl+Shift+E.`);
})();
