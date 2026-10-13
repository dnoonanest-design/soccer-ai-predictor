# Soccer AI Predictor

Pre-match and in-play football predictions from a statistical model (Dixon-Coles adjusted Poisson), with a signed, tamper-evident accuracy ledger. Deployed on Railway as one service: an Express API that also serves the React dashboard.

## Layout

| Path | What it is |
| --- | --- |
| `api-server/` | Express API, prediction model, background workers, tests (`vitest`) |
| `artifacts/soccer-dashboard/` | React + Vite dashboard; builds into `dashboard-dist/` |
| `lib/db/` | Postgres schema and numbered SQL migrations (`pnpm migrate`) |
| `lib/api-zod/`, `lib/api-client-react/` | Generated API types and React Query client |
| `docs/` | Audits and historical upgrade reports |

## Commands

```sh
pnpm install
pnpm test                 # API tests
pnpm typecheck            # all packages
pnpm railway:build        # typecheck + test + build dashboard and API bundle
pnpm migrate              # apply SQL migrations (needs DATABASE_URL)
pnpm railway:start        # run the built server
```

Build output (`api-server/dist/`, `dashboard-dist/`) is generated on deploy and is not committed.

## Configuration

Copy `.env.example`. In production set at least `DATABASE_URL`, `API_FOOTBALL_KEY`, `ADMIN_SECRET` (long random string) and `NODE_ENV=production`. Admin actions and detailed health output need the `X-Admin-Key` header.

## Accuracy reporting

Pre-match and in-play predictions are stored and scored separately and never combined:

- **Pre-match**: one frozen, integrity-verified prediction per match, captured before kickoff. This is the headline accuracy.
- **In-play**: checkpoints at 15', 30' ... 90', reported in their own section. Late checkpoints are naturally very accurate, so mixing them in would inflate results.

Results settle on the 90-minute score; extra time and penalties are excluded.

## Model challengers

New models run beside the live one on the same matches and replace it only after passing a promotion gate (`GET /api/model/challengers`, `GET /api/model/inplay`).

- **Pre-match**: challengers include fitted team ratings and `step7-shots-stacked` (ratings fitted on goals and on shots). A challenger must beat the live model on 1X2 Brier and log loss, on matches with closing odds, and must not make over 2.5 or BTTS log loss worse.
- **In-play**: the live model's six multipliers are refitted on finished matches every 12 hours (`inplay-fitted`) and judged per match at the in-play checkpoints. In-play rows are kept in their own table.
- **Shot data**: past-match shot statistics are fetched in batches (100 API calls every 2 hours, paused above 60% of the daily budget). `STATS_BACKFILL_ENABLED=false` turns this off.
- **Explanations**: set `ANTHROPIC_API_KEY` to turn on plain-English match explanations (`ANTHROPIC_MODEL` overrides the default model). They never change a probability.

## Scaling note

Rate limits, caches and background workers live in one process. Run a single Railway replica unless that state is moved to Postgres or Redis.
