# AI-aware self-improving soccer predictor upgrade

This upgrade adds a guarded AI-learning layer. The app now learns from completed matches that look similar to upcoming/live matches and uses the results to improve calibration over time.

## What was added

- **Similar match memory**: stores a feature vector for completed matches including xG, momentum, red cards, injuries, form, star-player rating and circumstance score.
- **AI model registry**: stores the currently active calibration model and its metrics.
- **Learning audits**: records whether a new recalibration is good enough to use.
- **Self-improvement queue**: flags weaknesses such as low accuracy or not enough training data.
- **Manual AI endpoints**:
  - `GET /ai/status`
  - `POST /ai/run-learning-cycle`
- **Background integration**: the normal automatic recalibration job now also runs the AI-aware learning cycle.

## Important safety design

The app does **not** rewrite its own code. That would be risky and could break the app.

Instead, it improves safely by updating database-backed model weights, calibration parameters, audit results and improvement recommendations.

## Required database setup

Run:

```sql
/db/001_prediction_platform.sql
```

This creates the new AI learning tables:

- `similar_match_memory`
- `ai_model_registry`
- `ai_learning_audits`
- `self_improvement_queue`

## How it improves accuracy

1. The app saves predictions and match circumstances.
2. Finished results are settled.
3. The AI learner builds a memory bank of similar completed matches.
4. It checks whether the model was overconfident or underconfident.
5. It promotes safer calibration only when there is enough evidence.
6. It flags weak areas for improvement.

## Best results require data volume

The AI-aware layer becomes useful after at least 30 settled matches and becomes much stronger after 300+ settled matches per major market/league.
