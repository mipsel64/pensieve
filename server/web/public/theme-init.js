(function () {
  var root = document.documentElement;
  var choice = null;
  try {
    choice = localStorage.getItem('pensieve.theme');
  } catch (e) {}
  var dark = choice === 'dark' || (choice !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  var theme = dark ? 'dark' : 'light';
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#1f1d1b' : '#f5ecd4');
})();
