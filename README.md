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

## Scaling note

Rate limits, caches and background workers live in one process. Run a single Railway replica unless that state is moved to Postgres or Redis.
