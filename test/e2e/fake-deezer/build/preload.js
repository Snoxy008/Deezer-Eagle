'use strict';
// Like Deezer's own preload, this one uses Node (so the window is not sandboxed).
const os = require('os');

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.platform = os.platform();
});
