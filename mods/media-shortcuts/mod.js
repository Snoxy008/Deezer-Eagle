// Playback shortcuts on Ctrl+Alt, which Deezer does not use.

function changeVolume(direction) {
  const step = mod.settings.get('step') / 100;
  const volume = Math.round(Math.max(0, Math.min(1, Eagle.player.getVolume() + direction * step)) * 100) / 100;
  Eagle.player.setVolume(volume);
  return `Volume ${Math.round(volume * 100)}%`;
}

const ACTIONS = {
  ' ': () => {
    Eagle.player.togglePlay();
    return Eagle.player.isPlaying() ? 'Pause' : 'Play';
  },
  ArrowRight: () => {
    Eagle.player.next();
    return 'Next track';
  },
  ArrowLeft: () => {
    Eagle.player.previous();
    return 'Previous track';
  },
  ArrowUp: () => changeVolume(1),
  ArrowDown: () => changeVolume(-1),
};

window.addEventListener(
  'keydown',
  (event) => {
    if (!event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey) return;
    const action = ACTIONS[event.key];
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      const message = action();
      if (mod.settings.get('notify')) Eagle.notify(message, { timeout: 1500 });
    } catch (err) {
      Eagle.notify(err.message);
    }
  },
  true,
);
