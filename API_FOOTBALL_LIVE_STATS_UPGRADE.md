# API-Football live stats upgrade

This version uses the upgraded API-Football fixture statistics feed more aggressively during live matches.

## Added live in-match fields

The match stats endpoint now reads and returns these extra fixture statistics when available from API-Football:

- Live xG / expected goals
- Shots off target
- Blocked shots
- Shots inside the box
- Shots outside the box
- Total passes
- Accurate passes
- Pass accuracy
- Offsides
- Yellow cards
- Red cards
- Goalkeeper saves
- Dangerous attacks, if supplied by the feed

## Prediction improvements

The live pressure engine now uses more than score/events. It blends:

- live xG
- shots on target
- shots inside the box
- corners
- dangerous attacks
- possession
- pass accuracy
- cards
- recent match events

The enhanced prediction response now includes:

- `live_momentum.home_attacking_index`
- `live_momentum.away_attacking_index`
- `live_momentum.home_danger_score`
- `live_momentum.away_danger_score`
- `live_momentum.data_quality`, showing `enhanced` when richer live stats are available

## Front-end changes

The match detail page now refreshes stats every 15 seconds and displays extra live bars for:

- Live xG
- Shots in box
- Blocked shots
- Keeper saves
- Yellow cards
- Pass accuracy

## Important

API-Football does not supply every statistic for every match, league, or subscription endpoint. The app only displays a stat when both teams have that field available.
