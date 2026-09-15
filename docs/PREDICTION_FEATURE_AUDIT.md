# Prediction feature and AI-role audit

## Governing rule

All user-facing, stored and audited three-way probabilities must be created by
`createCanonicalPrediction()` in `canonicalPredictionService.ts`. A statistic is
allowed to change a forecast only when it is available at that forecast's
timestamp and has a football rationale. Final results and post-kickoff data are
never inputs to pre-match forecasts. Bookmaker prices remain evaluation-only.

## Statistics used by the prediction model

| Evidence | Pre-match | Live | Purpose |
|---|---:|---:|---|
| Opponent-adjusted goals scored/conceded | Yes | Yes | Base expected goals |
| Recent results and recency weighting | Yes | Yes | Current form |
| Home/away venue history | Yes | Yes | Venue-specific evidence |
| Competition strength (Manchester Rule) | Yes | Yes | Cross-league/competition adjustment |
| League home advantage and scoring environment | Yes | Yes | Conservative league prior |
| Confirmed lineup | When available | Yes | Starter quality adjustment |
| Injuries and suspensions | When available | Yes | Player-availability adjustment |
| Player goals and assists per appearance | When available | Yes | Lineup, absence and substitution impact |
| Limited head-to-head history | When available | Pre-match prior only | Maximum 8% blend; default cap 6% |
| Current score and elapsed time | No | Yes | Remaining-score distribution |
| Live xG, shots, shots on target and shots in box | No | When available | Attacking intensity/remaining xG |
| Possession, pass accuracy, corners and dangerous attacks | No | When available | Live attacking intensity |
| Cards | No | Yes | Dismissal and pressure adjustment |
| Match events and substitutions | No | Yes | Recency-weighted momentum/player changes |
| Sample size and source quality | Yes | Yes | Shrinks weak evidence toward neutral |

Raw pass totals, shots off target, saves, fouls and offsides are retained for
display/audit where supplied. They are not independently weighted because they
are redundant with stronger inputs or have not passed holdout validation.
Blindly weighting every available field would double-count evidence and reduce
accuracy.

## AI responsibilities

| Component | May change probabilities? | Safeguard |
|---|---:|---|
| Statistical prediction engine | Yes | Canonical pipeline and timestamp boundary |
| Adaptive learning engine | Yes, after promotion | At least 250 settled matches, at least 50 newest chronological holdout matches, and Brier improvement of at least 0.002 |
| Circumstance learning | No direct adjustment | Diagnostic until adaptive holdout validation promotes a non-duplicative effect |
| Similar-match memory | No | Monitoring and recommendations only |
| Generative player AI | No | Explanation text only; computed probabilities remain deterministic |
| Market/odds intelligence | No | Separate value/evaluation layer |
| Offline fallback | League priors only | Requires at least 250 settled matches and is labelled low-confidence fallback |

## Consistency guarantees

- Dashboard match statistics, premium value calculations, background snapshots,
  future baselines and accuracy audits call the same canonical service.
- Live serving selects substitution-adjusted probabilities first, then current
  score/time probabilities, then the pre-match baseline.
- Three-way output is always normalised to exactly 100%.
- Legacy small-sample bucket calibration is neutral and cannot affect serving.
- Background model promotion uses a PostgreSQL advisory lock to prevent two
  application replicas training/promoting at the same time.
- The latest valid adaptive model is queried directly instead of disappearing
  after unrelated training rows are written.
