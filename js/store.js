// Preferences and favorites in localStorage. One origin can host several apps
// (radmageirl.github.io serves every project of the account, and radmagelabs.com will host
// more than one tool), so every key carries this app's prefix. Storage can be missing or full
// (private windows, blocked site data); every call degrades to "nothing saved".
(function (root) {
  'use strict';
  const PREFIX = 'ffxiv-timer:v1:';

  function read(name, fallback) {
    try {
      const text = root.localStorage.getItem(PREFIX + name);
      return text == null ? fallback : JSON.parse(text);
    } catch (e) {
      return fallback;
    }
  }

  function write(name, value) {
    try { root.localStorage.setItem(PREFIX + name, JSON.stringify(value)); } catch (e) { /* not saved */ }
  }

  root.FfxivStore = { PREFIX, read, write };
})(typeof globalThis !== 'undefined' ? globalThis : this);
