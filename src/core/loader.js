/* Deezer Eagle loader: added by `eagle apply`, removed by `eagle restore`. */
;(function () {
  // DEEZER_EAGLE_DISABLE=1 starts Deezer without any mod (safe mode).
  if (process.env.DEEZER_EAGLE_DISABLE) return;
  try {
    require(require('path').join(__EAGLE_HOME__, 'core', 'main.js'));
  } catch (err) {
    console.error('[Deezer Eagle] core failed to load, starting Deezer without mods:', err);
  }
})();
