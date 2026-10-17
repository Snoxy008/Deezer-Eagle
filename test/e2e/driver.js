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
  result.modRan = document.documentElement.dataset.e2eMod || '';
  const probe = getComputedStyle(document.getElementById('probe'));
  result.probeColor = probe.color;
  result.probeBackground = probe.backgroundColor;
  result.adblock = await tryFetch('http://ads.doubleclick.net/pixel');
  result.modBlock = await tryFetch('http://tracker.e2e-blocked.test/x');
  result.allowed = await tryFetch('http://cdn.e2e-allowed.test/x');
  result.appHook = await tryFetch('http://www.deezer.com/app-hook');
  if (mode === 'installed' || mode === 'marketplace') {
    // Screenshot modes: leave the library open on one tab.
    Eagle.openLibrary(mode);
    const shadow = document.querySelector('deezer-eagle').shadowRoot;
    await until(() => shadow.querySelector(mode === 'installed' ? '.card[data-mod]' : '.card[data-spec]'), 10000);
    await sleep(300);
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

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  result.closedByEscape = !shadow().querySelector('.library');
  history.pushState({}, '', '#album/1');
  result.navigated = document.documentElement.dataset.e2eNav || '';
  return result;
})();
