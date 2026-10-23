# Changelog

## Unreleased

- Weather forecasts for 25 more zones, finishing A Realm Reborn and Heavensward: Ul'dah (both
  steps), Gridania (old and new), the five Thanalan and four Black Shroud field zones, Coerthas
  Central Highlands, Mor Dhona, Wolves' Den Pier, Ishgard (Foundation and The Pillars),
  Idyllshire and the six Heavensward field zones. 45 zones in all.
- Weather forecasts for 25 more zones, Stormblood through Endwalker: Kugane, Rhalgr's Reach,
  the Doman Enclave and the six Stormblood field zones; the Crystarium, Eulmore and the six
  Norvrandt field zones; Old Sharlayan, Radz-at-Han and the six Endwalker field zones. 70 zones
  in all: every city and field zone from A Realm Reborn through Dawntrail, plus Eureka.
- Weather now keeps starred zones on top and groups the rest by expansion in sections that open
  and close (and stay that way). The area filter, the zone pickers and the About list are grouped
  by expansion too.
- About explains that story versions of a zone can have their own weather.
- README screenshot, taken by `node tools/screenshot.mjs` at a fixed moment.

## Milestone 1

First milestone: the clock, the weather engine and the dashboard.

- Eorzea clock: ET time, sun and moon, local time, day or night, a day bar with the weather
  change points, and countdowns to the next bell, weather change and sunrise or sunset.
- Weather forecasts for 20 zones: Limsa Lominsa (both decks) and the six La Noscea field zones,
  Tuliyollal, Solution Nine and the six Dawntrail field zones, and the four Eureka zones. Tables
  from game data patch 7.57 hotfix 1.
- Every other city, field zone and open-world area with weather is listed by name as not
  supported, with no forecast.
- Weather now (search, region filter, starred zones), Upcoming timeline, per-zone Forecast with
  odds, and a Weather transitions finder with shareable links.
- Static site that works under any base path; builds for GitHub Pages (/ffxiv-timer/, also proxied
  at radmagelabs.com/ffxiv/) and a standalone /ffxiv/ copy.
- Unit tests and browser base-path tests, with no dependencies.
