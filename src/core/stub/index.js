'use strict';
// Deezer Eagle loader. `eagle apply` packs this file into resources/app.asar
// and moves Deezer's original archive to resources/_app.asar; `eagle restore`
// puts everything back.

const path = require('path');
const { app } = require('electron');

const stub = require('./eagle.json');
const original = path.join(__dirname, '..', '_app.asar');

// DEEZER_EAGLE_DISABLE=1 starts Deezer without any mod (safe mode).
if (!process.env.DEEZER_EAGLE_DISABLE) {
  try {
    require(path.join(stub.home, 'core', 'main.js'));
  } catch (err) {
    console.error('[Deezer Eagle] core failed to load, starting Deezer without mods:', err);
  }
}

const pkg = require(path.join(original, 'package.json'));
const entry = path.join(original, pkg.main || 'index.js');

app.setAppPath(original);
require.main.filename = entry;

try {
  require(entry);
} catch (err) {
  if (err.code !== 'ERR_REQUIRE_ESM') throw err;
  import(require('url').pathToFileURL(entry).href).catch((esmErr) => {
    console.error('[Deezer Eagle] failed to start Deezer:', esmErr);
    app.exit(1);
  });
}
