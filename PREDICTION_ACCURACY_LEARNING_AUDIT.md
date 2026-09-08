# Prediction Accuracy & Learning Audit

## Purpose

This layer creates an immutable evidence trail for the predictor. It records what the model believed at fixed points in time, waits for the real match result, and then measures whether the prediction was correct and how well calibrated the probabilities were.

Bookmaker odds remain outside the core prediction formula. Market intelligence can be compared with the model later, but it does not alter the probabilities recorded by this audit.

## Fixed checkpoints

### Pre-match

- 24 hours before kickoff
- 6 hours before kickoff
- 90 minutes before kickoff
- 15 minutes before kickoff

The 24h and 6h checkpoints intentionally use the lean statistical data tier. The 90m and 15m checkpoints add lineup/injury/circumstance information. This makes it possible to measure the incremental value of late team information rather than assuming it helps.

### In-play

- 15 minutes
- 30 minutes
- 45 minutes
- 60 minutes
- 75 minutes
- 90 minutes

The live checkpoints include the current score, live stats, momentum and available circumstances.

## Metrics

Every settled checkpoint records:

- 1X2 predicted outcome and actual outcome
- pick accuracy
- three-way Brier score
- log-loss
- Over 2.5 accuracy when a probability was produced
- BTTS accuracy when a probability was produced
- model confidence and confidence band
- model version
- exact deployed Git/Railway revision where available
- league and checkpoint
- circumstance score edge when available

For the Brier score and log-loss, lower is better. The audit uses the summed three-class Brier score, for which a uniform 1/3-1/3-1/3 prediction has a score of approximately 0.667.

## Reporting

`GET /api/accuracy/audit`

Returns overall performance and breakdowns by:

- league
- pre-match/live checkpoint
- confidence band
- model version and engine revision
- predicted home/draw/away outcome
- home/away circumstance edge

`GET /api/accuracy/audit/status`

Returns worker status, cadence, current model/revision and the most recent audit run.

## Data maturity

The report labels the evidence base as:

- `collecting`: fewer than 250 settled checkpoint predictions
- `developing`: 250-999 settled checkpoint predictions
- `mature`: 1,000 or more settled checkpoint predictions

Model changes should not be promoted purely because they look better on a very small sample. League/checkpoint-specific conclusions should also require enough examples to avoid reacting to noise.

## Quota protection

The audit is deliberately quota-aware:

- fixture date requests pass through the API-Football quota optimisation layer and normally reuse the existing scheduled fixture cache
- pre-match capture is capped per scan
- live capture is capped per scan
- expensive circumstance/lineup collection starts only from 90 minutes before kickoff
- bookmaker calls are not made by the audit worker

Environment controls:

- `PREDICTION_ACCURACY_AUDIT_ENABLED` (default enabled)
- `PREDICTION_ACCURACY_AUDIT_SCAN_MS` (default 15 minutes, minimum 5 minutes)
- `PREDICTION_ACCURACY_AUDIT_MAX_PREMATCH` (default 10)
- `PREDICTION_ACCURACY_AUDIT_MAX_LIVE` (default 8)
- `PREDICTION_MODEL_VERSION` (defaults to `calibrated-statistical-v4`)

## Learning rule

The audit is measurement-first. It does not automatically change the prediction formula. Its evidence should feed the existing guarded recalibration/self-improvement process, where proposed changes must improve holdout metrics before becoming active.
