# Prediction data integrity — non-negotiable rule

The app and AI generate independent predictions from match information gathered before the prediction timestamp.

For any fixture, its own final result and any data recorded after the relevant prediction cutoff are forbidden inputs to that fixture's pre-match prediction. Results may be joined only after the prediction has been permanently timestamped, and only to measure accuracy or train future predictions for different matches.

Enforcement:

- Pre-match predictions require a future kickoff timestamp.
- A prediction is rejected if an outcome already exists for that fixture.
- Finished-match prediction snapshots are rejected.
- Calibration and training queries accept only records created before kickoff.
- Odds remain separate from the independent statistical model.
- Any breach is logged as an integrity error and must fail automated tests.
