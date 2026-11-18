// Which part of the page a URL hash opens. Pure, so the rules can be tested without a page.
//
// Timers & Weather keeps every address it has today: an empty hash, the forecast and finder hash
// (#zone=..&fz=..&prev=..&to=..&bells=..), #main and every section id. Market & Crafting owns
// #market and the paths under it, strictly:
//   #market                      Prices home
//   #market/item/<id>            one item's details; id is 1 to 9 digits with no leading zero
//   #market/craft                Crafting home
//   #market/craft/<id>           Crafting for one item; id as for an item
//   #market/<anything else>      Market & Crafting with a notice that the address is not known
//                                (under #market/craft/, Crafting's own notice)
// Anything else opens Timers & Weather, exactly as before, and changes nothing saved.
(function (root) {
  'use strict';

  const ITEM = /^market\/item\/([1-9][0-9]{0,8})$/;

  function modeOf(hash) {
    const h = String(hash || '').replace(/^#/, '');
    if (h !== 'market' && !h.startsWith('market/')) return { mode: 'timers' };
    if (h === 'market' || h === 'market/') return { mode: 'market', view: 'home' };
    const c = craftRoute(h);
    if (c) return c.view === 'craft-item' ? { mode: 'market', view: 'craft-item', id: c.id } : { mode: 'market', view: c.view === 'notice' ? 'craft-notice' : c.view };
    const m = ITEM.exec(h);
    if (m) return { mode: 'market', view: 'item', id: Number(m[1]) };
    return { mode: 'market', view: 'notice' };
  }

  // The hash for a market view; the inverse of modeOf for the views it can name.
  function marketHash(view) {
    if (view && view.view === 'item' && Number.isInteger(view.id) && view.id > 0 && view.id < 1e9) return `#market/item/${view.id}`;
    return '#market';
  }

  // Crafting's addresses (v0.12.0), as modeOf above opens them:
  //   #market/craft                Crafting home (also with a trailing slash, as #market/ is)
  //   #market/craft/<id>           that item's recipes; id as in #market/item/<id>
  //   #market/craft/<anything else> a notice
  // Anything that is not under #market/craft gives null.
  const CRAFT_ITEM = /^market\/craft\/([1-9][0-9]{0,8})$/;
  function craftRoute(hash) {
    const h = String(hash || '').replace(/^#/, '');
    if (h !== 'market/craft' && !h.startsWith('market/craft/')) return null;
    if (h === 'market/craft' || h === 'market/craft/') return { view: 'craft-home' };
    const m = CRAFT_ITEM.exec(h);
    return m ? { view: 'craft-item', id: Number(m[1]) } : { view: 'notice' };
  }
  function craftHash(view) {
    if (view && view.view === 'craft-item' && Number.isInteger(view.id) && view.id > 0 && view.id < 1e9) return `#market/craft/${view.id}`;
    return '#market/craft';
  }

  const Router = { modeOf, marketHash, craftRoute, craftHash };
  if (typeof module === 'object' && module.exports) module.exports = Router;
  else root.XivRouter = Router;
})(typeof globalThis !== 'undefined' ? globalThis : this);
