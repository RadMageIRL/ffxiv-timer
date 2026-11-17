// Which part of the page a URL hash opens. Pure, so the rules can be tested without a page.
//
// Timers & Weather keeps every address it has today: an empty hash, the forecast and finder hash
// (#zone=..&fz=..&prev=..&to=..&bells=..), #main and every section id. Market & Crafting owns
// #market and the paths under it, strictly:
//   #market                      Prices home
//   #market/item/<id>            one item's details; id is 1 to 9 digits with no leading zero
//   #market/<anything else>      Market & Crafting with a notice that the address is not known
// Anything else opens Timers & Weather, exactly as before, and changes nothing saved.
(function (root) {
  'use strict';

  const ITEM = /^market\/item\/([1-9][0-9]{0,8})$/;

  function modeOf(hash) {
    const h = String(hash || '').replace(/^#/, '');
    if (h !== 'market' && !h.startsWith('market/')) return { mode: 'timers' };
    if (h === 'market' || h === 'market/') return { mode: 'market', view: 'home' };
    const m = ITEM.exec(h);
    if (m) return { mode: 'market', view: 'item', id: Number(m[1]) };
    return { mode: 'market', view: 'notice' };
  }

  // The hash for a market view; the inverse of modeOf for the views it can name.
  function marketHash(view) {
    if (view && view.view === 'item' && Number.isInteger(view.id) && view.id > 0 && view.id < 1e9) return `#market/item/${view.id}`;
    return '#market';
  }

  const Router = { modeOf, marketHash };
  if (typeof module === 'object' && module.exports) module.exports = Router;
  else root.XivRouter = Router;
})(typeof globalThis !== 'undefined' ? globalThis : this);
