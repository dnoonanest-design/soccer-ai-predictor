# Future Market Sampler

## Purpose

The future market sampler builds opening-to-closing bookmaker movement history before match day while keeping the core soccer predictor independent from bookmaker prices.

It is disabled by default and is enabled in production with:

```text
MARKET_FUTURE_SAMPLER_ENABLED=true
```

## Sampling window and cadence

Default future window: 72 hours before kickoff.

For a fixture that already has a bookmaker snapshot, the next observation becomes due after:

- 24-72 hours before kickoff: every 2 hours
- 6-24 hours before kickoff: every 1 hour
- 0-6 hours before kickoff: every 30 minutes

The scheduler itself wakes every 30 minutes. API-Football future fixtures are cached for 2 hours so a new fixture-list request is not made on every scan.

## Quota controls

Defaults:

```text
MARKET_FUTURE_SAMPLER_WINDOW_HOURS=72
MARKET_FUTURE_SAMPLER_SCAN_MS=1800000
MARKET_FUTURE_SAMPLER_FIXTURE_REFRESH_MS=7200000
MARKET_FUTURE_SAMPLER_MAX_FIXTURES=120
MARKET_FUTURE_SAMPLER_MAX_ODDS_CALLS_PER_RUN=4
MARKET_FUTURE_SAMPLER_MAX_ODDS_CALLS_PER_DAY=80
```

Only competitions with a configured The Odds API sport key are queried. Sport keys are processed sequentially through the shared rate limiter. When several competitions are due at once, fixtures closest to kickoff are prioritised.

The daily sampler budget is an additional guard for this sampler. Normal match-page bookmaker requests remain separately cached by `soccerService.ts`.

## Independence rule

The sampler only calls `captureMarketSnapshots()` and stores bookmaker observations in `market_odds_snapshots`.

It does not call the prediction engine, does not modify model probabilities, and does not modify calibration weights. The runtime policy remains:

```text
corePredictionUsesBookmakerOdds=false
bookmakerDataRole=evaluation_and_learning_only
```

## Monitoring

```text
GET /api/market-intelligence/sampler-status
```

This returns whether the sampler is enabled/running, its last result, sampling cadence, and current in-process odds-call budget.

The existing report remains:

```text
GET /api/market-intelligence/report
```

As snapshots accumulate, the report can compare opening and closing market probabilities with settled outcomes and with the predictor's independent pre-match predictions.
