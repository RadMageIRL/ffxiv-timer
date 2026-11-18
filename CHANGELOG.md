# Changelog

Every version of FFXIV Timer and what changed in it, newest first. Dates are the day I released
each one.

## v0.11.0 (2026-11-17)

Added
- Market & Crafting: a second mode beside Timers & Weather, switched with the two buttons at the
  top. Each switch is one step in the browser's history, so Back returns to where you were, and
  the timers keep running while the market is open. It shows market board prices from
  Universalis (universalis.app) for a data center, a world or a region, and has its own section
  links: Market Watch, Favorites and Browse.
- The first visit to Market & Crafting asks which data center to show, prefilled from the one
  chosen in Resets. Nothing is saved until you choose.
- Market Watch: 75 commonly traded items in groups (crystals, materia, medicine, meals, dyes and
  crafting materials), all priced in one request. Your newest favorites show beside it
  (Show all lists the rest; up to 500 are kept), and Browse lists the market board's categories.
- Search across all 16,845 items that can be sold on the market board, by name or id, with each
  item's lowest NQ and HQ listing and the world it is on, units sold a day, and its listing age:
  how long ago Universalis last received the market board of the world with the lowest listing
  shown (for a data center or a region, not the newest upload anywhere in it). Sort by best
  match, name, lowest NQ or HQ listing, units sold a day, listing age or item level, and filter by
  category, Can be HQ, Listed now and item level. Each sort and filter says which items it
  covers.
- Item details: how old the data is comes first, then NQ and HQ apart (lowest listing, last
  sale, average sale price, units sold a day), the lowest listing by place, the current listings
  apart from completed sales (up to 20 of each), and the market tax in each city when a world is
  chosen. From the details you can change the place, add a favorite, refresh, and copy a link.
  Each item has its own address, so Back closes the details and a link opens them.
- Ages: data under 6 hours old reads as current, under 3 days as recent, and anything older is
  marked old with its date. An age is always Universalis's own time for the data, never when the
  page fetched it.
- When the price service asks the page to wait, it waits as long as asked and says so; when
  prices cannot be loaded, the last ones stay on screen with their ages and the page says why.
  Nothing is ever estimated.
- The page asks radmagelabs.com for prices and radmagelabs.com asks Universalis, so your browser
  does not contact Universalis and nothing about you is sent there. Your place, favorites, sort
  and filters stay in this browser; prices are not saved. At radmageirl.github.io, Market &
  Crafting links to the same view at radmagelabs.com/ffxiv/ and asks for nothing.
- A light theme: the moon and sun button at the top switches between dark, still the default,
  and light. The choice is saved in this browser only once you make it, and applies before the
  page first appears.
- Share, in the header and in About: a link to radmagelabs.com/ffxiv/ with what the page shows
  now, through your device's share sheet where there is one, otherwise copied. Nothing else goes
  with it.

Changed
- The header: the two mode buttons sit beside the title. From 641 to 1360 pixels wide the section
  links take a row of their own, and on phones the mode buttons do.
- On phones, where the section links scroll sideways, the edge with more links beyond it fades, so
  you can tell there are more. The fade clears while you move through them with the keyboard.
- At radmagelabs.com the page now comes with a Content-Security-Policy: it runs only its own
  scripts and connects only to its own site.
- The search box placeholder in the dark theme is a little lighter, for contrast.

## v0.10.0 (2026-11-16)

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
- Search results and link previews: the page title names the resets, and the description names
  the daily and weekly resets and calendar export.

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
