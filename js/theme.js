// Light or dark, chosen with the two buttons in the page header and remembered in
// this browser. Until someone chooses, the page follows the computer's setting.
(function () {
  const root = document.documentElement;
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const current = () => root.dataset.theme || (dark.matches ? 'dark' : 'light');
  const buttons = () => document.querySelectorAll('[data-set-theme]');
  const sync = () => { for (const b of buttons()) b.setAttribute('aria-pressed', String(b.dataset.setTheme === current())); };
  for (const b of buttons()) {
    b.addEventListener('click', () => {
      root.dataset.theme = b.dataset.setTheme;
      try { localStorage.setItem('pe-theme', b.dataset.setTheme); } catch (e) { /* private window: not remembered */ }
      sync();
    });
  }
  dark.addEventListener?.('change', sync);
  sync();
})();
