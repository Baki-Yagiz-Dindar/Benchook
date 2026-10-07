'use strict';

/* Choosing a theme changes the panel surface only. Terminal processes, the project layout and
   provider accounts know nothing about this module. The same pure routine is used as
   window.PanelTema in the browser and as module.exports under test. */
(function themeModule(root, setup) {
  const api = setup();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PanelTema = api;
})(typeof window !== 'undefined' ? window : null, () => {
  const OPTIONS = Object.freeze([
    { id: 'pink', name: "Rose glass", description: "Warm accents and translucent surfaces" },
    { id: 'purple', name: "Violet night", description: "Soft contrast with violet accents" },
    { id: 'blue', name: "Blue focus", description: "Cool accents for focused work" },
    { id: 'classic', name: "Classic dark", description: "Neutral dark surfaces" },
  ]);
  const DEFAULTS = 'pink';
  const ids = new Set(OPTIONS.map((x) => x.id));

  function valid(name) {
    return typeof name === 'string' && ids.has(name) ? name : DEFAULTS;
  }

  function apply(document, name) {
    const selected = valid(name);
    for (const link of document.querySelectorAll('link[data-panel-theme]')) {
      link.disabled = link.dataset.panelTheme !== selected;
    }
    document.documentElement.dataset.theme = selected;
    return selected;
  }

  return { OPTIONS, DEFAULTS, valid, apply };
});
