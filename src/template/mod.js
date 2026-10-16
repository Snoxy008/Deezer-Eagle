// Ce fichier s'exécute dans la page de Deezer à chaque chargement.
//   Eagle : l'API de Deezer Eagle (Eagle.observe, Eagle.waitFor, Eagle.notify...)
//   mod   : ton mod (mod.log, mod.storage, mod.addStyle...)
// Doc : https://github.com/Snoxy008/Deezer-Eagle/blob/main/docs/creer-un-mod.md

mod.log('chargé !');

Eagle.onNavigate((url) => {
  mod.log('nouvelle page :', url);
});
