# Error recheck and live-stat improvements

Applied after the API-Football subscription upgrade.

## Fixes

- Fixed live stat parsing so `0` values are preserved instead of being converted to `null`.
- Made API-Football statistic-name matching more robust by normalising names and supporting aliases such as `Shots on Target`, `Shots inside box`, `xG`, `Expected Goals`, and pass accuracy variants.
- Reduced live fixture-stat cache from 30 seconds to 12 seconds so the 15-second match-page refresh can actually receive fresh API data.
- Allowed partial live-stat responses: if API-Football returns one side only, the app now keeps the available side instead of dropping all live stats.
- Added guard logic so empty live-stat responses do not crash or produce false live data.
- Patched the bundled API `dist/index.mjs` as well as the TypeScript source, so direct `start` and rebuild flows both get the fixes.

## UI improvements

The match-detail live stats panel now also displays, when supplied by API-Football:

- red cards
- offsides
- shots outside the box
- total passes
- improved decimal/percentage parsing

## Checks run

- TypeScript/TSX parse check across the project.
- JavaScript syntax check on bundled API `dist/index.mjs`.
- Manual review of the live stats API path and match-detail rendering logic.

## Notes

Run the app with the upgraded `API_FOOTBALL_KEY` in Replit Secrets. For best results, use live fixtures because these extra stats are only available when API-Football supplies fixture-level statistics for that match and league.
