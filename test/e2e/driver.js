// Runs inside the fake Deezer page (main world) and drives Deezer Eagle the
// way a user would. Evaluates to a promise of what it observed.
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const until = async (read, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
      const value = read();
      if (value) return value;
    }
    return null;
  };
  const tryFetch = (url) => fetch(url, { mode: 'no-cors' }).then(() => 'ok', () => 'blocked');
  const round = (box) => ({ left: Math.round(box.left), top: Math.round(box.top), right: Math.round(box.right), bottom: Math.round(box.bottom) });
  const mode = window.E2E_MODE || 'full';
  const result = {};

  await until(() => window.Eagle);
  result.eagle = typeof window.Eagle;
  result.bridge = typeof window.EagleBridge;
  if (!window.Eagle) return result;
  await until(() => document.getElementById('probe'));
  await sleep(200);
  result.mods = Eagle.mods.map((mod) => `${mod.id}:${mod.status}`).sort();
  result.theme = Eagle.theme;
  result.themedContent = getComputedStyle(document.getElementById('probe').parentElement).backgroundColor;
  result.modRan = document.documentElement.dataset.e2eMod || '';
  const probe = getComputedStyle(document.getElementById('probe'));
  result.probeColor = probe.color;
  result.probeBackground = probe.backgroundColor;
  result.adblock = await tryFetch('http://ads.doubleclick.net/pixel');
  result.modBlock = await tryFetch('http://tracker.e2e-blocked.test/x');
  result.allowed = await tryFetch('http://cdn.e2e-allowed.test/x');
  result.appHook = await tryFetch('http://www.deezer.com/app-hook');
  if (['installed', 'themes', 'marketplace', 'settings'].includes(mode)) {
    // Screenshot modes: leave the library open on one tab.
    Eagle.openLibrary(mode);
    const shadow = document.querySelector('deezer-eagle').shadowRoot;
    const ready = { installed: '.card[data-mod]', themes: '.theme[data-theme]', marketplace: '.card[data-spec]', settings: '.panel' }[mode];
    await until(() => shadow.querySelector(ready), 10000);
    await sleep(1500);
    return result;
  }
  if (mode === 'mods') {
    // The official mods, used through their own interface.
    const visible = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
    result.offlineBanner = visible('offline-alert');
    result.promo = visible('promo');
    result.navStillVisible = getComputedStyle(document.querySelector('.nav')).display !== 'none';

    const key = (name) => window.dispatchEvent(new KeyboardEvent('keydown', { key: name, ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
    key('ArrowRight');
    await sleep(100);
    result.shortcutTrack = Eagle.player.getTrack().title;
    const before = Eagle.player.getVolume();
    key('ArrowUp');
    result.shortcutVolume = Math.round((Eagle.player.getVolume() - before) * 100);

    const moon = await until(() => document.querySelector('#page_player .eagle-sleep'));
    result.moonBeforeVolume = Boolean(moon && moon.nextElementSibling && moon.nextElementSibling.id === 'volume-button');
    moon.click();
    const items = Array.from(document.querySelectorAll('.eagle-sleep-menu button'), (item) => item.textContent);
    result.sleepChoices = items;
    Array.from(document.querySelectorAll('.eagle-sleep-menu button')).find((item) => item.textContent === 'End of this track').click();
    Eagle.player.setVolume(0.8);
    Eagle.player.play();
    Eagle.player.seek(Eagle.player.getDuration() - 15);
    await until(() => Eagle.player.getVolume() < 0.8, 4000);
    result.fading = Eagle.player.getVolume() < 0.8;
    Eagle.player.seek(Eagle.player.getDuration() - 0.5);
    result.pausedBySleepTimer = Boolean(await until(() => !Eagle.player.isPlaying(), 4000));
    result.volumeRestored = Boolean(await until(() => Eagle.player.getVolume() === 0.8, 4000));
    return result;
  }
  if (mode !== 'full') return result;

  // Sidebar entry, cloned from Deezer's own navigation rows.
  const entry = await until(() => document.querySelector('[data-eagle="sidebar-entry"]'));
  const link = entry && (entry.matches('a') ? entry : entry.querySelector('a'));
  result.sidebar = entry && {
    text: entry.textContent.trim(),
    index: Array.from(entry.parentElement.children).indexOf(entry),
    rowClass: entry.className,
    icon: Boolean(entry.querySelector('svg[data-testid="EagleOutlinedIcon"].nav-icon')),
    href: link.hasAttribute('href'),
  };
  if (!entry) return result;

  // The sidebar is re-rendered: the entry comes back.
  entry.remove();
  result.sidebarRestored = Boolean(await until(() => document.querySelector('[data-eagle="sidebar-entry"]')));

  // Library, opened from the sidebar.
  document.querySelector('[data-eagle="sidebar-entry"] a, a[data-eagle="sidebar-entry"]').click();
  const shadow = () => document.querySelector('deezer-eagle').shadowRoot;
  const library = await until(() => shadow().querySelector('.library'));
  result.libraryOpened = Boolean(library);
  if (!library) return result;
  await until(() => shadow().querySelectorAll('.card[data-mod]').length >= 4);
  result.installedCards = Array.from(shadow().querySelectorAll('.card[data-mod]'), (card) => card.dataset.mod).sort();
  result.libraryBox = round(library.getBoundingClientRect());
  result.contentBox = round(document.getElementById('page_content').getBoundingClientRect());
  result.brokenError = (shadow().querySelector('.card[data-mod="e2e-broken"] pre.error') || {}).textContent || '';
  result.libraryBackground = getComputedStyle(library).backgroundColor;

  // Turn a mod off from its switch.
  shadow().querySelector('.card[data-mod="e2e-mod"] .switch').click();
  result.switchedOff = Boolean(await until(() => shadow().querySelector('.card[data-mod="e2e-mod"] .switch[aria-checked="false"]')));
  result.reloadNotice = Boolean(shadow().querySelector('.notice'));

  // Marketplace: install an official mod with one click.
  shadow().querySelector('.tab[data-tab="marketplace"]').click();
  await until(() => shadow().querySelector('.card[data-spec="copy-link"]'), 10000);
  result.marketplace = Array.from(shadow().querySelectorAll('.card[data-spec]'), (card) => card.dataset.spec).sort();
  const installButton = shadow().querySelector('.card[data-spec="copy-link"] .button');
  result.installButton = installButton ? installButton.textContent : '';
  if (installButton) installButton.click();
  const installed = await until(() => {
    const button = shadow().querySelector('.card[data-spec="copy-link"] .button');
    return button && button.textContent === 'Installed';
  }, 90000);
  result.installedFromMarketplace = Boolean(installed);

  // Mods from elsewhere need the native confirmation (answered "Cancel" here),
  // and the page cannot install local folders or reach the bridge from iframes.
  result.communityInstall = await window.EagleBridge.install('someone/not-official');
  result.localInstall = await window.EagleBridge.install('C:\\Windows').then(() => 'accepted', () => 'refused');
  const frame = document.createElement('iframe');
  frame.srcdoc = '<p>frame</p>';
  document.body.append(frame);
  await sleep(500);
  result.iframeBridge = typeof frame.contentWindow.EagleBridge;
  await window.EagleBridge.remove('e2e-broken');
  result.afterRemove = (await window.EagleBridge.list()).map((mod) => `${mod.id}:${mod.enabled}`).sort();

  // Player API, on Deezer's dzPlayer.
  result.track = Eagle.player.getTrack().title;
  result.cover = Eagle.player.getTrack().cover;
  const heard = [];
  Eagle.player.on('track', (track) => heard.push(`track:${track.title}`));
  Eagle.player.on('playing', (playing) => heard.push(`playing:${playing}`));
  Eagle.player.next();
  Eagle.player.togglePlay();
  await until(() => heard.length >= 2, 3000);
  result.playerEvents = heard.slice().sort();
  result.isPlaying = Eagle.player.isPlaying();

  // Mod settings, edited in the library, read live by the mod.
  const tab = (name) => shadow().querySelector(`.tab[data-tab="${name}"]`).click();
  tab('installed');
  await until(() => shadow().querySelector('.card[data-mod="volume-wheel"] [data-action="settings"]'));
  shadow().querySelector('.card[data-mod="volume-wheel"] [data-action="settings"]').click();
  const stepInput = await until(() => shadow().querySelector('.card[data-mod="volume-wheel"] .settings input[type="number"]'));
  result.stepDefault = stepInput ? stepInput.value : '';
  if (stepInput) {
    stepInput.value = '20';
    stepInput.dispatchEvent(new Event('change'));
  }
  document.getElementById('volume-button').dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
  result.volumeAfterWheel = window.dzPlayer.volume;

  // A CSS-only mod (adblock) switches off and on without reloading, network rules included.
  const adblockSwitch = () => shadow().querySelector('.card[data-mod="adblock"] .switch');
  adblockSwitch().click();
  await until(() => shadow().querySelector('.card[data-mod="adblock"] .switch[aria-checked="false"]'));
  result.adblockOff = await tryFetch('http://ads.doubleclick.net/pixel');
  result.adblockOffBadge = Boolean(shadow().querySelector('.card[data-mod="adblock"] .badge:not(.accent):not(.update)'));
  adblockSwitch().click();
  await until(() => shadow().querySelector('.card[data-mod="adblock"] .switch[aria-checked="true"]'));
  result.adblockOn = await tryFetch('http://ads.doubleclick.net/pixel');

  // Updates announced by the (fake) GitHub.
  await until(() => shadow().querySelector('.badge.update'), 10000);
  result.updateBadges = shadow().querySelectorAll('.badge.update').length;
  result.sidebarDot = Boolean(document.querySelector('[data-eagle="update-dot"]'));
  tab('settings');
  result.eagleUpdate = (await until(() => Array.from(shadow().querySelectorAll('.button')).find((node) => /^Update to/.test(node.textContent)))) || {};
  result.eagleUpdate = result.eagleUpdate.textContent || '';

  // Themes switch live, including the tokens the app writes at runtime.
  tab('themes');
  result.themeCards = Array.from(shadow().querySelectorAll('.theme[data-theme]'), (card) => card.dataset.theme);
  shadow().querySelector('.theme[data-theme="nord"] .button').click();
  await sleep(100);
  result.themedContent = getComputedStyle(document.getElementById('page_content')).backgroundColor;
  result.themedIcon = getComputedStyle(document.getElementById('icon-probe')).color;
  result.themedLibrary = getComputedStyle(shadow().querySelector('.library')).backgroundColor;
  result.activeTheme = Eagle.theme;

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  result.closedByEscape = !shadow().querySelector('.library');
  history.pushState({}, '', '#album/1');
  result.navigated = document.documentElement.dataset.e2eNav || '';
  return result;
})();
