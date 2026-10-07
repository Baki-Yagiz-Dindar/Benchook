'use strict';
// Apply the saved theme before the first paint, with the same rule the panel uses later
// (`theme.js`, loaded just before this file): an unknown name falls back to the default theme.
window.PanelTema.apply(document, new URLSearchParams(location.search).get('theme'));
