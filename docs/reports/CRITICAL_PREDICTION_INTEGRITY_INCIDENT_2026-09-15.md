# Critical prediction-integrity incident — 2026-09-15

## Incident

The adaptive learner advertised learned form, injury, lineup, competition,
head-to-head, league home-advantage and league xG parameters, but most of those
parameters were not connected to the prediction-serving path. The learner's
training query also replaced available circumstance features with `NULL`.

The generative player-analysis path additionally accepted model-generated
correlations, predictive power and probabilities as if they were validated
statistics.

## Severity

Critical. A prediction system must not claim that a learned factor is active
unless the exact promoted parameter is used by the serving calculation and its
improvement has been measured on data unavailable during fitting.

## Permanent invariants

1. Training rows must be pre-kickoff snapshots and may only join circumstance
   observations captured before kickoff.
2. Finished-match outcomes are labels only and can never enter a feature vector.
3. Every promoted parameter must be consumed by the prediction-serving path.
4. Promotion requires a chronological holdout, a material Brier-score
   improvement and an adequate sample.
5. Live forecasts must use current score, remaining time, live xG, shots,
   attacking pressure and dismissals in one coherent calculation.
6. Generative AI may explain computed statistics; it may not originate trusted
   probabilities, correlations or predictive-power values.
7. Published performance must come from immutable, pre-kickoff audit records.

