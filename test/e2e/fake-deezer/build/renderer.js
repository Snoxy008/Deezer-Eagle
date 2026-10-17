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

setTimeout(() => {
  const nav = element('div', { class: 'nav' }, [navRow('#home', 'HouseFilledIcon', 'Home'), navRow('#explore', 'ExploreOutlinedIcon', 'Explore')]);
  const favourites = element('div', { class: 'library-block' }, [navRow('#favourites', 'HeartOutlinedIcon', 'Favourite tracks')]);
  const sidebar = element('div', { class: 'sidebar' }, [nav, favourites]);
  const naboo = element('div', { class: 'naboo' }, [
    element('div', {}, [sidebar]),
    element('div', { id: 'page_topbar' }),
    element('main', { id: 'page_content', class: 'page-main' }, [element('div', { id: 'probe' }, ['probe'])]),
  ]);
  document.getElementById('dzr-app').append(naboo, element('div', { id: 'page_player' }));
}, 300);
