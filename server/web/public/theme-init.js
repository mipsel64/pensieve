(function () {
  var root = document.documentElement;
  var choice = null;
  try {
    choice = localStorage.getItem('pensieve.theme');
  } catch (e) {}
  // The same attributes Astryx's <Theme> sets once React runs, so the first paint already has the theme.
  root.setAttribute('data-astryx-theme', 'pensieve');
  if (choice === 'light' || choice === 'dark') root.setAttribute('data-theme', choice);
  var dark = choice === 'dark' || (choice !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#111111' : '#f5f4ed');
})();
