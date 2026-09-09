# Market Intelligence Layer

The predictor now keeps its statistical forecast independent from bookmakers and produces a second, explicitly labelled market-assisted forecast.

## Data flow

1. `soccerService` fetches the available European H2H prices and stores every bookmaker observation, including the provider update time and the time this app first observed it.
2. Decimal prices are converted to implied probabilities and normalised to remove bookmaker overround.
3. `marketIntelligenceService` compares the opening and latest bookmaker consensus available at a prediction cutoff.
4. The independent forecast is preserved unchanged. A separate assisted forecast blends in at most 15% market influence.
5. Settled-match reporting compares the independent model, bookmaker consensus and assisted model with Brier score, log loss and pick accuracy.

The `observed_at <= prediction cutoff` query is the leakage barrier. A provider timestamp alone is not treated as proof that this application possessed the data at that earlier time.

## API responses

- `GET /api/matches/:match_id/stats` includes `enhanced.market_intelligence`.
- `GET /api/matches/:match_id/market-history` returns timestamped bookmaker observations.
- `GET /api/matches/:match_id/market-intelligence?as_of=<ISO timestamp>` reconstructs an assessment using only prediction and market snapshots available by that cutoff.
- `GET /api/market-intelligence/performance` compares the three models on settled pre-match fixtures.

Probability values inside market-intelligence responses use the `0-1` scale. Existing enhanced prediction fields retain their current `0-100` API contract.

## Deployment

Run the existing database migration before deploying the new application code:

```sh
pnpm migrate
```

Initially operate the assisted forecast in shadow mode: display and score it, but keep the independent forecast as the app's primary selection. Increase or change the influence cap only after a sufficiently large out-of-sample report shows a repeatable improvement.
