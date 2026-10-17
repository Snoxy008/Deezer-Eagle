'use strict';
// Renders a shell with the same structure as Deezer's React app (the
// selectors Deezer Eagle relies on), a little after load like the real one.

const SVG_NS = 'http://www.w3.org/2000/svg';

function element(tag, attributes, children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes || {})) node.setAttribute(name, value);
  node.append(...(children || []));
  return node;
}

function navRow(href, icon, label) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('data-testid', icon);
  svg.setAttribute('class', 'nav-icon');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '24');
  return element('div', { class: 'nav-row' }, [element('a', { href, class: 'nav-link' }, [svg, element('span', { class: 'nav-label' }, [label])])]);
}

// Deezer's web player: window.dzPlayer, plus "player-…" messages on every change.
const songs = [
  { SNG_ID: '1', SNG_TITLE: 'First Song', ART_NAME: 'An Artist', ALB_TITLE: 'An Album', ALB_PICTURE: 'cafe', DURATION: '200' },
  { SNG_ID: '2', SNG_TITLE: 'Second Song', ART_NAME: 'An Artist', ALB_TITLE: 'An Album', ALB_PICTURE: 'beef', DURATION: '180' },
];
const playback = { index: 0, playing: false, volume: 0.5, position: 0 };
const post = (type, data) => window.postMessage(Object.assign({ type }, data), '*');
window.dzPlayer = {
  get volume() {
    return playback.volume;
  },
  getCurrentSong: () => songs[playback.index],
  isPlaying: () => playback.playing,
  getDuration: () => Number(songs[playback.index].DURATION),
  getPosition: () => playback.position,
  control: {
    setVolume(volume) {
      playback.volume = volume;
      post('player-volume-changed', { player: { volume } });
    },
    play() {
      playback.playing = true;
      post('player-playing-changed', { isPlaying: true });
    },
    pause() {
      playback.playing = false;
      post('player-playing-changed', { isPlaying: false });
    },
    togglePause() {
      if (playback.playing) this.pause();
      else this.play();
    },
    nextSong() {
      playback.index = (playback.index + 1) % songs.length;
      post('player-track-updated', {});
    },
    prevSong() {
      playback.index = (playback.index + songs.length - 1) % songs.length;
      post('player-track-updated', {});
    },
    seek(fraction) {
      playback.position = fraction * Number(songs[playback.index].DURATION);
    },
  },
};

setTimeout(() => {
  // The app writes some design tokens at runtime, as inline styles.
  document.documentElement.style.setProperty('--tempo-colors-icon-neutral-primary-default', '#0f0d13');
  const nav = element('div', { class: 'nav' }, [navRow('#home', 'HouseFilledIcon', 'Home'), navRow('#explore', 'ExploreOutlinedIcon', 'Explore')]);
  const favourites = element('div', { class: 'library-block' }, [navRow('#favourites', 'HeartOutlinedIcon', 'Favourite tracks')]);
  const promo = element('div', { class: 'promo', id: 'promo' }, [
    element('p', {}, ['Go Premium: 2 months free to skip the ads.']),
    element('a', { href: 'https://www.deezer.com/offers' }, ['Get it']),
  ]);
  const sidebar = element('div', { class: 'sidebar' }, [nav, promo, favourites]);
  const naboo = element('div', { class: 'naboo' }, [
    element('div', {}, [sidebar]),
    element('div', { id: 'page_topbar' }),
    element('main', { id: 'page_content', class: 'page-main' }, [
      element('div', { class: 'alert-wrapper', id: 'offline-alert' }, [element('div', { 'data-testid': 'alert-AppOffline' }, ['Application is offline'])]),
      element('div', { id: 'probe' }, ['probe']),
      element('span', { id: 'icon-probe' }, ['icon']),
    ]),
  ]);
  const playerBar = element('div', { id: 'page_player' }, [
    element('button', { 'aria-label': 'volume button', id: 'volume-button' }, ['volume']),
    element('div', { 'data-testid': 'volume_menu' }),
  ]);
  document.getElementById('dzr-app').append(naboo, playerBar);
}, 300);
