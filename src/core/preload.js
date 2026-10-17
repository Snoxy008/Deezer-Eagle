'use strict';
// Deezer Eagle — preload, registered on Deezer's session by the core. It
// exposes window.EagleBridge, the library's only channel to the main process
// (which checks every request comes from Deezer's own page).

const { contextBridge, ipcRenderer } = require('electron');

function isDeezerPage() {
  const { protocol, hostname } = window.location;
  if (protocol === 'http:' || protocol === 'https:') return /(^|\.)deezer\.com$/i.test(hostname);
  return protocol !== 'about:' && protocol !== 'data:' && protocol !== 'blob:';
}

if (window.top === window && isDeezerPage()) {
  const call =
    (channel) =>
    (...args) =>
      ipcRenderer.invoke(`eagle:${channel}`, ...args);
  const bridge = {
    list: call('list'),
    setEnabled: call('set-enabled'),
    remove: call('remove'),
    marketplace: call('marketplace'),
    install: call('install'),
    update: call('update'),
  };
  if (process.contextIsolated) {
    contextBridge.exposeInMainWorld('EagleBridge', bridge);
  } else {
    window.EagleBridge = Object.freeze(bridge);
  }
}
