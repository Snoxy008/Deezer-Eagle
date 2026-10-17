// Sleep timer: a moon button in the player bar stops the music after a while,
// fading the volume out at the end, then gives the volume back for next time.
const MOON = 'M20.5 14.1A8.5 8.5 0 1 1 9.9 3.5a6.6 6.6 0 0 0 10.6 10.6z';
const CHOICES = [
  [15, '15 minutes'],
  [30, '30 minutes'],
  [45, '45 minutes'],
  [60, '1 hour'],
  [90, '1 h 30'],
  ['track', 'End of this track'],
];
const FADE_SECONDS = 30;

mod.addStyle(`
  .eagle-sleep { display: inline-flex; align-items: center; gap: 4px; height: 32px; min-width: 32px; padding: 0 6px; margin: 0 4px; border: 0; border-radius: 999px; background: transparent; color: inherit; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; justify-content: center; }
  .eagle-sleep:hover { background: var(--color-bg-tertiary, #ebe7ee); }
  .eagle-sleep[data-active] { color: var(--color-accent-main, #a238ff); }
  .eagle-sleep-menu { position: fixed; z-index: 2147483000; min-width: 220px; padding: 6px; border-radius: 8px; background: var(--color-bg-main, #fdfcfe); color: var(--color-text-main, #0f0d13); box-shadow: 0 8px 32px rgba(0, 0, 0, .25); }
  .eagle-sleep-menu button { display: block; width: 100%; padding: 8px 12px; border: 0; border-radius: 6px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .eagle-sleep-menu button:hover { background: var(--color-bg-tertiary, #ebe7ee); }
  .eagle-sleep-menu div { padding: 8px 12px 4px; font-size: 12px; color: var(--color-text-secondary, #6f6d71); }
`);

let timer = null; // { end: timestamp or 'track', volume: volume before the fade }
let control = null;
let menu = null;

function remainingSeconds() {
  if (timer.end !== 'track') return Math.max(0, (timer.end - Date.now()) / 1000);
  const duration = Eagle.player.getDuration();
  return duration ? Math.max(0, duration - Eagle.player.getPosition()) : Infinity;
}

function render() {
  if (!control) return;
  control.toggleAttribute('data-active', Boolean(timer));
  let label = '';
  if (timer) label = timer.end === 'track' ? 'track' : `${Math.ceil(remainingSeconds() / 60)} min`;
  control.lastChild.textContent = label;
  control.title = timer ? `Sleep timer: ${timer.end === 'track' ? 'end of this track' : `${label} left`}` : 'Sleep timer';
}

function restoreVolume(volume) {
  if (volume == null) return;
  try {
    Eagle.player.setVolume(volume);
  } catch (err) {
    mod.warn(err.message);
  }
}

function start(choice) {
  if (timer) restoreVolume(timer.volume);
  timer = { end: choice === 'track' ? 'track' : Date.now() + choice * 60000, volume: null };
  Eagle.notify(choice === 'track' ? 'The music stops at the end of this track.' : `The music stops in ${choice} minutes.`);
  render();
}

function cancel() {
  restoreVolume(timer && timer.volume);
  timer = null;
  Eagle.notify('Sleep timer turned off.');
  render();
}

function tick() {
  if (!timer) return;
  const left = remainingSeconds();
  if (mod.settings.get('fade') && left < FADE_SECONDS) {
    if (timer.volume == null) timer.volume = Eagle.player.getVolume();
    Eagle.player.setVolume(timer.volume * (left / FADE_SECONDS));
  }
  if (left <= 1) {
    const volume = timer.volume;
    timer = null;
    try {
      Eagle.player.pause();
    } catch (err) {
      mod.warn(err.message);
    }
    setTimeout(() => restoreVolume(volume), 1500);
    Eagle.notify('Sleep timer: good night!');
  }
  render();
}
setInterval(tick, 1000);

function closeMenu() {
  if (menu) menu.remove();
  menu = null;
  document.removeEventListener('click', closeOnOutsideClick, true);
}

function closeOnOutsideClick(event) {
  if (menu && !menu.contains(event.target) && !control.contains(event.target)) closeMenu();
}

function openMenu() {
  menu = document.createElement('div');
  menu.className = 'eagle-sleep-menu';
  const title = document.createElement('div');
  title.textContent = 'Stop the music after';
  menu.append(title);
  const entries = CHOICES.slice();
  if (timer) entries.push([null, 'Turn the timer off']);
  for (const [choice, label] of entries) {
    const item = document.createElement('button');
    item.type = 'button';
    item.textContent = label;
    item.addEventListener('click', () => {
      if (choice === null) cancel();
      else start(choice);
      closeMenu();
    });
    menu.append(item);
  }
  document.body.append(menu);
  const box = control.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.bottom = `${window.innerHeight - box.top + 8}px`;
  setTimeout(() => document.addEventListener('click', closeOnOutsideClick, true), 0);
}

// The player bar may be re-rendered: put the button back next to the volume.
Eagle.observe("#page_player [aria-label='volume button']", (volume) => {
  if (control && control.isConnected) return;
  control = document.createElement('button');
  control.type = 'button';
  control.className = 'eagle-sleep';
  control.setAttribute('aria-label', 'Sleep timer');
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('width', '20');
  icon.setAttribute('height', '20');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', MOON);
  icon.append(path);
  control.append(icon, document.createElement('span'));
  control.addEventListener('click', (event) => {
    event.stopPropagation();
    if (menu) closeMenu();
    else openMenu();
  });
  volume.before(control);
  render();
});
