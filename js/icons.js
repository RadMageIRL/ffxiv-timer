// Weather icons, drawn for this project (no game assets). Weathers are grouped by look only;
// the grouping is cosmetic and never feeds a forecast.
(function (root) {
  'use strict';
  const GROUP = {
    'Clear Skies': 'clear', 'Fair Skies': 'fair', Clouds: 'clouds', Fog: 'fog',
    Wind: 'wind', Gales: 'wind', Rain: 'rain', Showers: 'rain',
    Thunder: 'thunder', Thunderstorms: 'thunder', Snow: 'snow', Blizzards: 'snow',
    'Dust Storms': 'dust', 'Moon Dust': 'dust', 'Heat Waves': 'heat',
    Gloom: 'umbral', 'Umbral Wind': 'umbral', 'Umbral Static': 'umbral', 'Astromagnetic Storms': 'umbral',
  };
  const cloud = 'M7 18h10a4 4 0 0 0 .6-8A5.5 5.5 0 0 0 7 9.5 4.3 4.3 0 0 0 7 18Z';
  const PATHS = {
    clear: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>',
    fair: '<circle cx="9" cy="8.5" r="3.2"/><path d="M9 2.6v1.4M3.1 8.5h1.4M4.8 4.3l1 1M13.2 4.3l-1 1"/><path d="M9 20h8.5a3.5 3.5 0 0 0 .4-7 4.8 4.8 0 0 0-9.1 1.4A2.9 2.9 0 0 0 9 20Z"/>',
    clouds: `<path d="${cloud}"/><path d="M15.5 6.5a4 4 0 0 1 5.5 5.2"/>`,
    fog: '<path d="M4 8h16M2.5 12h19M4 16h16M7 20h10"/>',
    wind: '<path d="M3 9h11a3 3 0 1 0-3-3M3 13h15a3 3 0 1 1-3 3M3 17h7"/>',
    rain: `<path d="${cloud}"/><path d="M8 20.5l-1 2M12 20.5l-1 2M16 20.5l-1 2"/>`,
    thunder: `<path d="${cloud}"/><path d="M12.5 15.5 10 20h3.5l-2 3.5"/>`,
    snow: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5 12 7l2.5-2.5M9.5 19.5 12 17l2.5 2.5"/>',
    dust: '<path d="M3 8h9M6 12h12M3 16h8"/><circle cx="16" cy="8" r="1"/><circle cx="20" cy="12" r="1"/><circle cx="15" cy="16" r="1"/><circle cx="19" cy="18" r="1"/>',
    heat: '<path d="M7 20c-2-3 2-5 0-8s2-5 0-8M12 20c-2-3 2-5 0-8s2-5 0-8M17 20c-2-3 2-5 0-8s2-5 0-8"/>',
    umbral: '<path d="M12 2.5 13.8 10 21.5 12 13.8 14 12 21.5 10.2 14 2.5 12 10.2 10Z"/><circle cx="12" cy="12" r="1.6"/>',
    other: '<circle cx="12" cy="12" r="6"/>',
  };

  function weatherGroup(name) { return GROUP[name] || 'other'; }

  function weatherIcon(name) {
    const g = weatherGroup(name);
    return `<svg class="wx-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${PATHS[g]}</svg>`;
  }

  root.FfxivIcons = { weatherGroup, weatherIcon };
})(typeof globalThis !== 'undefined' ? globalThis : this);
