// Display formatting that does not depend on the viewer's locale or time zone, and the link Share hands out.
(function (root) {
  'use strict';

  // A countdown rounded up to the whole second, so it reads 0:00 only at the moment itself:
  // "4:05" under an hour, "2h 07m" under a day, "3d 4h" beyond.
  function countdown(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  // URL-safe key for a zone or weather name: "Kozama'uka" -> "kozamauka", "Clear Skies" -> "clear-skies".
  function slug(name) {
    return name.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  // The address everyone is given, wherever this copy was opened (radmagelabs.com, GitHub Pages, a
  // local file). tools/build.mjs declares the same address as the page's canonical one.
  const CANONICAL = 'https://radmagelabs.com/ffxiv/';
  // The link Share hands out: the canonical address plus this view's hash exactly as the address bar
  // has it (the forecast zone and transition search, or any deep link that is open), nothing else.
  function shareUrl(hash) {
    return CANONICAL + (typeof hash === 'string' && hash.length > 1 && hash[0] === '#' ? hash : '');
  }

  const Format = { countdown, slug, CANONICAL, shareUrl };
  if (typeof module === 'object' && module.exports) module.exports = Format;
  else root.FfxivFormat = Format;
})(typeof globalThis !== 'undefined' ? globalThis : this);
