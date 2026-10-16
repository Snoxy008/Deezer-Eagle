// Ctrl+Shift+L: copies the public link of the page open in Deezer.
// Deliberately small, meant to be read as an example of the Eagle API.

function copy(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(() => copyWithSelection(text));
  }
  return Promise.resolve(copyWithSelection(text));
}

// Fallback for when the app denies the Clipboard API.
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
    Eagle.notify(`Link copied: ${url.href}`);
    mod.log(`link copied (${count} times since install)`);
  });
});
