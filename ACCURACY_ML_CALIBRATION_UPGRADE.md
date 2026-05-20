# Accuracy Tracking + Machine-Learning Calibration Upgrade

This version adds a stronger learning loop for the soccer predictor app.

## Added

- Automatic finished-result settlement endpoint: `POST /api/outcomes/settle-finished`
- Calibration report endpoint: `GET /api/calibration`
- Training dataset export endpoint: `GET /api/training/dataset`
- Improved bucket calibration with Bayesian smoothing, so small samples do not distort predictions too aggressively
- Performance page now shows:
  - prediction sample size
  - pick accuracy
  - Brier score
  - log loss
  - expected calibration error
  - predicted-vs-actual calibration buckets
  - dataset export link
- Training runs now include calibration diagnostics in the saved weights JSON

## How to use

1. Open the Performance page.
2. Press **Settle results** after matches finish. This records final scores from API-Football.
3. Press **Run training**. This recalculates the calibration model.
4. Keep collecting results. The model becomes more useful after roughly 250 settled predictions and becomes ready for external ML training after roughly 2,000+ rows.

## Accuracy notes

The app now improves prediction probabilities by comparing previous predictions against real outcomes. This is not magic; it needs historic data. Early calibration is intentionally cautious to avoid overfitting.
