document.documentElement.dataset.e2eMod = [mod.id, typeof Eagle.observe, typeof Eagle.waitFor].join(':');
Eagle.onNavigate((url) => {
  document.documentElement.dataset.e2eNav = new URL(url).pathname;
});
