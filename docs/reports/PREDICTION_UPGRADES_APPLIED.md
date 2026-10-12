# Prediction upgrades applied

The prediction system has been upgraded in both source files and the bundled API build.

## Pre-match improvements

- Enhanced Dixon-Coles Poisson engine now exposes:
  - Home / draw / away probabilities
  - Expected goals for both teams
  - Over 1.5, Over 2.5, Over 3.5
  - Both teams to score (BTTS)
  - Top correct-score probabilities
  - Fair decimal odds for home / draw / away
- Confidence rating added:
  - Low / Medium / High
  - Numeric confidence score
- Explainable reasons added for every prediction:
  - xG advantage
  - recent form advantage
  - injury/absence impact
  - lineup strength impact
  - head-to-head contribution
- Value-bet detection added by comparing model probability to bookmaker decimal odds:
  - bookmaker odds
  - model fair odds
  - edge percentage
  - value flag when edge is 5% or higher

## Live-match improvements

- Live score adjusted probabilities retained and improved around remaining match time.
- Live momentum object added:
  - home pressure score
  - away pressure score
  - dominant live team
  - next-goal split
  - pressure alert when a team is strongly dominant
- Substitution impact is still included and feeds into adjusted probabilities.

## Front-end improvements

The match detail xG panel now uses the enhanced server prediction where available instead of the simple local-only xG model. It also displays:

- enhanced AI markets
- confidence rating
- Over 2.5 probability
- BTTS probability
- fair odds
- value edge cards
- likely correct scores
- live pressure/next-goal indicators
- model reasons

## Files changed

- `artifacts/api-server/src/lib/enhancedStatsService.ts`
- `artifacts/api-server/src/routes/stats.ts`
- `artifacts/api-server/dist/index.mjs`
- `artifacts/soccer-dashboard/src/pages/match-detail.tsx`

## Important note

The local environment did not include `node_modules`, so a full TypeScript rebuild could not be run here. The bundled API JavaScript was syntax-checked with `node --check` after patching. When opening in Replit, run the normal install/build process so the TypeScript source rebuilds cleanly.
