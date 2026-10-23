# Changelog

## Unreleased

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
