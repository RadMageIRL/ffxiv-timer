// Compares js/weather-data.js with an independent capture of the same game tables (see
// tools/verify-weather.mjs). Returns a list of disagreements; empty means they match.
export function compareWeather(fixture, weatherData) {
  const problems = [];
  const byTerritory = new Map(fixture.zones.map((z) => [z.territory, z]));
  for (const z of weatherData.zones) {
    const x = byTerritory.get(z.territory);
    if (!x) { problems.push(`${z.name}: not in the independent capture`); continue; }
    if (x.name !== z.name) problems.push(`${z.territory}: name ${z.name} vs ${x.name}`);
    if (x.weatherRate !== z.weatherRate) problems.push(`${z.name}: WeatherRate ${z.weatherRate} vs ${x.weatherRate}`);
    if (JSON.stringify(x.rates) !== JSON.stringify(z.rates)) problems.push(`${z.name}: rates ${JSON.stringify(z.rates)} vs ${JSON.stringify(x.rates)}`);
    for (const [w, name] of Object.entries(x.names)) {
      if (weatherData.weathers[w] !== name) problems.push(`${z.name}: weather ${w} is ${weatherData.weathers[w]} vs ${name}`);
    }
  }
  return problems;
}
