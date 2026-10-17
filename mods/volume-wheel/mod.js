// Scroll on the volume button (or anywhere on the player bar) to change the volume.
const VOLUME_CONTROLS = "[aria-label='volume button'], [data-testid='volume_menu']";

document.addEventListener(
  'wheel',
  (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !target.closest('#page_player') || !Eagle.player.available) return;
    if (!mod.settings.get('wholeBar') && !target.closest(VOLUME_CONTROLS)) return;
    event.preventDefault();
    const step = mod.settings.get('step') / 100;
    const volume = Eagle.player.getVolume() + (event.deltaY < 0 ? step : -step);
    Eagle.player.setVolume(Math.round(Math.max(0, Math.min(1, volume)) * 100) / 100);
  },
  { capture: true, passive: false },
);
