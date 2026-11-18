// The head loads this before the body so the first frame uses the saved palette.
window.undertoneAppearance = (() => {
  const names = { green: 'Forest green', blue: 'Midnight blue', amoled: 'AMOLED black', gray: 'Graphite gray' };
  const storageKey = 'undertone-theme';

  function apply(id) {
    const root = document.documentElement;
    root.dataset.theme = Object.hasOwn(names, id) ? id : 'green';
    const background = getComputedStyle(root).getPropertyValue('--bg').trim();
    if (background) document.querySelector('meta[name="theme-color"]').content = background;
  }

  let saved;
  try { saved = localStorage.getItem(storageKey); } catch {}
  apply(saved);

  return {
    names,
    select(id) {
      apply(id);
      try { localStorage.setItem(storageKey, document.documentElement.dataset.theme); } catch {}
    },
  };
})();
