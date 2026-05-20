# Circumstance Learning Upgrade

This upgrade teaches the predictor which match circumstances actually affect winning, losing and value-bet accuracy.

## Added data capture
The background learner now stores:
- team selections and formations from API-Football lineups
- pre-match injuries and unavailable players
- player ratings and star-player performance from fixture player stats
- goals, assists, shots, key passes, cards and minutes played
- in-match injury substitutions where the event feed supplies injury comments
- yellow/red cards and the timing of match events
- team form scores and circumstance scores for home/away teams

## Added learning tables
Run the updated SQL file before using this version:

```sql
\i db/001_prediction_platform.sql
```

New tables:
- `match_circumstances`
- `player_match_factors`
- `factor_learning_insights`

## How it learns
When matches finish, the learner joins stored circumstances with final outcomes and calculates the influence of:
- circumstance score difference
- red-card difference
- injury/unavailability difference
- star-player rating difference
- team-form difference

It stores learned weights and confidence in `factor_learning_insights`.

## How predictions improve
Before storing each new prediction, the app checks recent circumstances for that fixture and applies a small probability correction. This means future predictions can learn, for example, whether:
- missing players are being underweighted
- red cards are too strong or too weak in the model
- star-player performance is improving match outcome accuracy
- form is overvalued in certain leagues

## New endpoints
- `GET /api/background/circumstance-learning`
- `POST /api/background/run/circumstance-analysis`

## Important note
This works best after a few hundred settled matches. Until then, default conservative weights are used so the model does not overreact to small samples.
