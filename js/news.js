// Latest news from the official Lodestone (na.finalfantasyxiv.com). Its feeds do not allow
// cross-origin reads, so the page asks its own site for them: radmagelabs.com passes
// news/topics.xml and news/news.xml through to the Lodestone. Where nothing answers there (GitHub
// Pages, a file opened from disk) the panel links to the Lodestone instead. The last good
// headlines are kept, so a failed fetch shows them and tries again soon instead of showing an
// error. Only titles, links, dates and categories are used, always as plain text, and only links
// back to the Lodestone are kept. Recent headlines in the Lodestone's Maintenance category are
// flagged, from headlines already loaded or saved, so the flag adds no request. Parsing, the retry
// rules and the flag are pure, so the Node tests can check them.
(function (root) {
  'use strict';

  const FEEDS = [
    { key: 'topics', path: 'news/topics.xml', title: 'Topics' },
    { key: 'news', path: 'news/news.xml', title: 'Notices and maintenance' },
  ];
  const HOST = 'na.finalfantasyxiv.com';
  const LODESTONE = 'https://na.finalfantasyxiv.com/lodestone/';
  const HOME = 'https://radmagelabs.com/ffxiv/';
  const PER_FEED = 5;
  const REFRESH_MS = 15 * 60000;
  const TIMEOUT_MS = 8000;
  // After a failed round: try again in 5 s, then 15 s, then 1 minute, then every 5 minutes.
  const RETRY_MS = [5000, 15000, 60000, 300000];
  // With nothing to show yet, the panel says it is loading until this many rounds in a row fail.
  const QUIET_FAILURES = 2;

  const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '...', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };
  // Dashes become plain hyphens; control characters are dropped.
  function safeChar(code) {
    if (code === 0x2013 || code === 0x2014 || code === 0x2015) return '-';
    if (code < 0x20 || (code >= 0x7f && code < 0xa0) || code > 0x10ffff) return '';
    return String.fromCodePoint(code);
  }
  function decode(s) {
    return s
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => safeChar(Number(d)))
      .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in NAMED ? NAMED[n.toLowerCase()] : m));
  }
  // Titles are text: decoded, any markup removed, dashes plain, whitespace collapsed.
  const text = (s) => decode(decode(s).replace(/<[^>]*>/g, ''))
    .replace(/[\u2013\u2014\u2015]/g, '-').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  const tag = (block, name) => {
    const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
    return m ? m[1] : '';
  };
  const attrs = (t) => Object.fromEntries([...t.matchAll(/([a-z:-]+)\s*=\s*"([^"]*)"/gi)].map((m) => [m[1].toLowerCase(), m[2]]));

  /** A Lodestone https link with no query or fragment, or null for anything else. */
  function cleanLink(raw) {
    let u;
    try { u = new URL(decode(String(raw)).trim()); } catch (e) { return null; }
    if (u.protocol !== 'https:' || u.hostname !== HOST || u.port || u.username || u.password || !u.pathname.startsWith('/lodestone/')) return null;
    return `https://${HOST}${u.pathname}`;
  }

  /** The newest entries of a Lodestone Atom feed: [{ title, link, dateMs, category }], newest first. */
  function parseFeed(xml, max) {
    const items = [];
    for (const m of String(xml).matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)) {
      const block = m[1];
      const title = text(tag(block, 'title')).slice(0, 200);
      const alt = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((l) => attrs(l[1])).find((a) => (a.rel || 'alternate') === 'alternate');
      const link = alt ? cleanLink(alt.href) : null;
      const dateMs = Date.parse(text(tag(block, 'published') || tag(block, 'updated')));
      const cat = /<category\b[^>]*\bterm\s*=\s*"([^"]*)"/i.exec(block);
      const category = cat ? text(cat[1]).slice(0, 40) : '';
      if (title && link) items.push({ title, link, dateMs: Number.isFinite(dateMs) ? dateMs : null, category });
    }
    items.sort((a, b) => (b.dateMs ?? -Infinity) - (a.dateMs ?? -Infinity));
    return items.slice(0, max || PER_FEED);
  }

  /** How long to wait after the nth failed round in a row (n from 1). */
  const retryDelay = (failures) => RETRY_MS[Math.min(Math.max(1, failures), RETRY_MS.length) - 1];

  /**
   * What one round of fetches means. Each result is { items } (parsed), { missing: true } (404)
   * or {} (any other failure). 'ok': every feed has headlines. 'partial': some do. 'unavailable':
   * every feed is missing at an address that does not pass the feeds through. 'failed': anything
   * else, including a 404 at radmagelabs.com, which passes them through and so only blipped.
   */
  function roundOutcome(results, passesFeeds) {
    const good = results.filter((r) => r.items && r.items.length).length;
    if (good) return good === results.length ? 'ok' : 'partial';
    if (!passesFeeds && results.every((r) => r.missing)) return 'unavailable';
    return 'failed';
  }

  /** A maintenance headline is flagged for this long after the Lodestone posts it. */
  const MAINTENANCE_MS = 7 * 86400000;
  /** Saved headlines older than this are not used for the flag on the closed bar: they may be out of date. */
  const FLAG_FRESH_MS = 24 * 3600000;
  /**
   * The headlines to flag as maintenance: the Lodestone's own "Maintenance" category, posted within
   * MAINTENANCE_MS before nowMs, newest first, each link once. Nothing is read from the article: the
   * Lodestone gives maintenance times only in its prose, so the flag shows the headline as written.
   */
  function maintenance(feeds, nowMs) {
    const seen = new Set(), out = [];
    for (const f of FEEDS) {
      for (const i of (feeds && feeds[f.key]) || []) {
        if (!/^maintenance$/i.test(i.category || '') || !Number.isFinite(i.dateMs) || seen.has(i.link)) continue;
        if (i.dateMs > nowMs + 3600000 || nowMs - i.dateMs >= MAINTENANCE_MS) continue;
        seen.add(i.link);
        out.push(i);
      }
    }
    return out.sort((a, b) => b.dateMs - a.dateMs);
  }

  /** A cached copy is used as is while it is younger than REFRESH_MS. */
  const isFresh = (cache, nowMs) => Boolean(cache && Number.isFinite(cache.fetchedAt) && nowMs >= cache.fetchedAt && nowMs - cache.fetchedAt < REFRESH_MS);

  /** A cached copy read back from storage: kept only if it still looks like what parseFeed returns. */
  function sanitizeCache(raw) {
    if (!raw || typeof raw !== 'object' || !Number.isFinite(raw.fetchedAt) || !raw.feeds || typeof raw.feeds !== 'object') return null;
    const feeds = {};
    for (const f of FEEDS) {
      const list = Array.isArray(raw.feeds[f.key]) ? raw.feeds[f.key] : [];
      feeds[f.key] = list
        .filter((i) => i && typeof i.title === 'string' && i.title && typeof i.link === 'string' && cleanLink(i.link) === i.link)
        .slice(0, PER_FEED)
        .map((i) => ({ title: text(i.title).slice(0, 200), link: i.link, dateMs: Number.isFinite(i.dateMs) ? i.dateMs : null, category: typeof i.category === 'string' ? text(i.category).slice(0, 40) : '' }));
    }
    return FEEDS.some((f) => feeds[f.key].length) ? { fetchedAt: raw.fetchedAt, feeds } : null;
  }

  const News = { FEEDS, HOST, LODESTONE, HOME, PER_FEED, REFRESH_MS, TIMEOUT_MS, RETRY_MS, QUIET_FAILURES, MAINTENANCE_MS, FLAG_FRESH_MS, parseFeed, cleanLink, isFresh, sanitizeCache, retryDelay, roundOutcome, maintenance };
  if (typeof module === 'object' && module.exports) module.exports = News;
  else root.FfxivNews = News;
})(typeof globalThis !== 'undefined' ? globalThis : this);
