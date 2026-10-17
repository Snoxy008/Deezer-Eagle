// Experimental: hides Deezer's "go Premium" promotions in the sidebar. They
// change often; if one stays visible, inspect it (Ctrl+Shift+I) and open an
// issue with what you see.
const SIDEBAR = '.naboo > div:not([id]):has(a) > div';
const PROMOTIONS = [
  `${SIDEBAR} a[href*="/offers"]`,
  `${SIDEBAR} a[href*="/premium"]`,
  `${SIDEBAR} a[href*="/payment"]`,
  `${SIDEBAR} a[href*="/subscribe"]`,
  '[data-testid*="upsell" i]',
].join(', ');

// The largest box around the promotion that holds nothing else: no
// navigation icon and only a short text.
function promotionBox(element) {
  let box = element;
  for (let parent = box.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    if (parent.matches(`${SIDEBAR}, #page_player, #page_topbar, #page_content, .naboo`)) break;
    if (parent.querySelector('svg[data-testid$="Icon"]')) break;
    if ((parent.textContent || '').trim().length > 160) break;
    box = parent;
  }
  return box;
}

Eagle.observe(PROMOTIONS, (element) => {
  if (element.closest('#page_player')) return;
  const box = promotionBox(element);
  box.style.setProperty('display', 'none', 'important');
  mod.log('hid a promotion:', box.textContent.trim().slice(0, 60));
});
