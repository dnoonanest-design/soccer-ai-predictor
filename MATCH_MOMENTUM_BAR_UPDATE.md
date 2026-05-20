# Match Momentum Percentage Bar Update

Added a live match momentum bar to the match-detail screen.

## What it does
- Calculates a home/away momentum split from live pressure values.
- Uses live API-Football stats already pulled into the enhanced prediction engine, including live xG, shots on target, shots inside the box, corners, dangerous attacks, possession, pass accuracy, recent events and card impact.
- Displays a percentage bar during live matches:
  - Home momentum percentage on the left
  - Away momentum percentage on the right
  - Visual split bar with live refresh
  - Feed quality indicator: enhanced live stats or basic events
  - Pressure, next-goal and attack-index details

## Refresh rate
The match stats/prediction panel now refreshes every 15 seconds so the momentum bar updates during live matches.

## Files changed
- artifacts/api-server/src/lib/enhancedStatsService.ts
- artifacts/api-server/dist/index.mjs
- artifacts/soccer-dashboard/src/pages/match-detail.tsx
