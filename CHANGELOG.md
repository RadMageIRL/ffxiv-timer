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
- Timed gathering: all 26 timed nodes in Dawntrail (8 unspoiled, 18 legendary) with items,
  levels, stars, job, place, map coordinates, folklore tome and spawn times; live up-now and
  next-spawn countdowns; filters for job, kind, up now and starred. Starred nodes appear in
  Upcoming, and reminders (when a node appears, or 1, 2 or 5 minutes before) show in the page
  and, if allowed, as system notifications.
- Gathering data is generated from the game tables and checked against XIVAPI and the wiki's
  node tables.
- Timed gathering for Endwalker: all 28 nodes (10 unspoiled, 18 legendary), 54 in all. Place
  names drop the game's italics markers ("The Ragnarok"). Where the wiki and the game data
  disagree, the official Lodestone database decided (Rarefied Palm Log is level 81).
- Timed gathering for Shadowbringers: all 35 nodes (19 unspoiled, 16 legendary), 89 in all.
  Four wiki rows disagree with the game data (Rarefied Kelp's level and star, and the positions
  of Wattle Petribark and the Rarefied Raw Petalite node); each is a reviewed exception with its
  evidence, and each is on the list to check in the game.
- The data checks retry dropped connections.
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
