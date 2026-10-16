// Ctrl+Shift+L : copie le lien public de la page ouverte dans Deezer.
// Petit mod volontairement simple, à lire comme exemple de l'API Eagle.

function copy(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(() => copyWithSelection(text));
  }
  return Promise.resolve(copyWithSelection(text));
}

// Repli si l'API presse-papiers est refusée par l'application.
function copyWithSelection(text) {
  const field = document.createElement('textarea');
  field.value = text;
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.append(field);
  field.select();
  document.execCommand('copy');
  field.remove();
}

window.addEventListener('keydown', (event) => {
  if (!event.ctrlKey || !event.shiftKey || event.key.toLowerCase() !== 'l') return;
  event.preventDefault();
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  copy(url.href).then(() => {
    const count = mod.storage.get('copies', 0) + 1;
    mod.storage.set('copies', count);
    Eagle.notify(`Lien copié : ${url.href}`);
    mod.log(`lien copié (${count} fois depuis l'installation)`);
  });
});
