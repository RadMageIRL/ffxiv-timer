# Changelog

Every version of FFXIV Timer and what changed in it, newest first. Dates are the day I released
each one.

## Unreleased

Added
- Resets: a panel with the daily reset, the Mini Cactpot, Grand Company missions, leve
  allowances, the weekly reset, your data center's Jumbo Cactpot drawing and the housing
  lottery's current period. Each time is in your time zone, which is named, with its UTC time
  beside it and a countdown. The weekly reset, the Mini Cactpot and every data center's Jumbo
  Cactpot drawing are times Square Enix states on the Lodestone. The daily reset, Grand Company
  missions, leve allowances and the dates of the housing lottery come from community sources
  only and are marked "time unverified".
- Starred resets: star a reset to see it in Upcoming, in time order with everything else, and,
  if you choose, to be reminded of it when it happens or 5, 15 or 30 minutes before, while the
  page is open. With no reset starred, Upcoming is exactly as before. Your data center, starred
  resets and reminder choice are remembered on this device.
- Add to calendar: calendar buttons in Upcoming, Resets, Timed gathering and Weather transitions
  make a calendar file (.ics) of the times you choose. That can be a transition search's next
  match or all the matches it lists; a node's next spawn or its windows over 2 or 6 hours (one
  node, starred nodes, or the nodes the filters match); the weather changes in starred zones;
  what Upcoming lists; or resets over up to 30 days. An alarm 5, 10 or 15 minutes before is
  optional. The calendar tool loads from this site the first time you use it; the page writes
  the file itself, and nothing is sent anywhere or saved. Each entry is written in UTC, so a
  calendar shows it in its own time zone across daylight-saving changes. Something already
  under way, such as a node that is up, starts when the file is made; nothing starts in the
  past. The dialog asks you to check the count above 200 entries and makes no file above 500.
- Latest news flags maintenance: a headline the Lodestone files under Maintenance is marked in
  the list and shown on the bar for 7 days after it is posted, even while the bar is closed. The
  flag uses only headlines already loaded or saved in this browser (from the last day), so it
  asks for nothing.
- Resets in the section links at the top.

Changed
- Game data is from patch 7.58. No weather table or gathering node changed, and every zone and
  node was checked again against XIVAPI for 7.58.

## v0.9.1 (2026-10-25)

Changed
- Latest news keeps the last headlines it loaded. If a refresh fails, they stay on screen with no
  error, and it tries again in 5 seconds, then 15 seconds, a minute, and every 5 minutes after.
  With nothing loaded yet it says it is loading, and says it could not load only after two
  failed tries in a row.

Fixed
- A missing news feed at radmagelabs.com/ffxiv/ (a brief hiccup there) is retried like any other
  failed try. It used to hide the headlines and point to radmagelabs.com/ffxiv/ from that same
  page, without trying again.

## v0.9 (2026-10-25)

The first numbered release. It covers everything since Milestone 1.

Added
- Latest news: a bar at the top, closed until you open it, with the newest Topics and Notices
  and maintenance headlines from the official Lodestone, each linking to the Lodestone. It loads
  nothing until opened, keeps headlines for 15 minutes and remembers whether it was left open.
  radmagelabs.com/ffxiv/ passes the Lodestone feeds through; at radmageirl.github.io the bar
  links to the Lodestone instead.
- The version, in the page title, under the FFXIV Timer name and in About.
- Gathering filters for expansion (ARR, HW, SB, ShB, EW, DT) and level range, and your own Miner
  and Botanist levels with Hide higher, which holds each job's nodes to that job's level. All
  gathering filters and the view are remembered on this device.
- Starred nodes that are up appear at the top of Upcoming, marked Up now, with the time left.
- A RadMage Labs link in the tagline under the FFXIV Timer name, back to radmagelabs.com.
- Weather forecasts for 25 more zones, finishing A Realm Reborn and Heavensward: Ul'dah (both
  steps), Gridania (old and new), the five Thanalan and four Black Shroud field zones, Coerthas
  Central Highlands, Mor Dhona, Wolves' Den Pier, Ishgard (Foundation and The Pillars),
  Idyllshire and the six Heavensward field zones. 45 zones in all.
- Weather forecasts for 25 more zones, Stormblood through Endwalker: Kugane, Rhalgr's Reach,
  the Doman Enclave and the six Stormblood field zones; the Crystarium, Eulmore and the six
  Norvrandt field zones; Old Sharlayan, Radz-at-Han and the six Endwalker field zones. 70 zones
  in all: every city and field zone from A Realm Reborn through Dawntrail, plus Eureka.
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
- Timed gathering for Stormblood: all 31 nodes (19 unspoiled, 12 legendary), 120 in all. Six wiki
  rows disagree with the game data; for five, the official Lodestone database settles it (its
  star rating, or a player's posted position and time that matches the game data), and one
  (Chromite Ore's position) is on the list to check in the game. The wiki's unspoiled Beech
  Branch has no timed node in the current game data and is left out.
- Timed gathering for Heavensward: all 31 nodes (12 unspoiled, 19 legendary), 151 in all. Five
  wiki positions disagree with the game data; for four, a player's report on the Lodestone
  database matches the game data. For Frost Cotton Boll the reports conflict, so it stays as the
  game data has it and is first on the list to check in the game.
- Timed gathering for A Realm Reborn: all 38 unspoiled nodes (3-bell windows, up to three a day),
  189 in all. Six more timed nodes in the game data sit in the blank placeholder territory (no
  zone at all) and are left out; the generator now refuses any node without a zone. The wiki
  lists A Realm Reborn windows one row each, so the check now also makes sure every window of a
  node appears in some row.
- README screenshot, taken by `node tools/screenshot.mjs` at a fixed moment.

Changed
- Gathering: the list shows the nodes up now, ending soonest first, then the nodes appearing
  within the next 15 minutes, 30 minutes or hour of real time (the default), soonest first, under
  sticky headings; All drops the time limit. The list scrolls inside the panel, so nothing is
  paged away.
- Gathering search also matches the expansion name.
- On phones the gathering chips are smaller and wrap, so the filters take less room.
- Weather now keeps starred zones on top and groups the rest by expansion in sections that open
  and close (and stay that way). The area filter, the zone pickers and the About list are grouped
  by expansion too.
- Search results and link previews: the page title and description now name the weather
  forecasts and timed gathering, and shared links show a preview image.
- About and the README say what leaves the browser: only Latest news, once you open it.
- The data checks retry dropped connections.
- README: the duplicated gathering sentence is gone.

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
