// This file runs inside Deezer's page every time it loads.
//   Eagle: the Deezer Eagle API (Eagle.observe, Eagle.waitFor, Eagle.notify...)
//   mod:   your mod (mod.log, mod.storage, mod.addStyle...)
// Docs: https://github.com/Snoxy008/Deezer-Eagle/blob/main/docs/creating-mods.md

mod.log('loaded!');

Eagle.onNavigate((url) => {
  mod.log('new page:', url);
});
