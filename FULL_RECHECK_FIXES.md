# Full recheck fixes

This package was rechecked after the accuracy + ML calibration upgrade.

## Checks completed

- ZIP archive integrity verified.
- JavaScript `.js/.mjs/.cjs` files passed `node --check`.
- TypeScript/TSX source files were parsed/transpiled for syntax errors.
- API server was started from the bundled server and `/api/healthz` returned OK.
- SQL migration was reviewed against the Drizzle schema.

## Fixes applied

- Safer 3-way probability normalisation after ML calibration.
- Prevented divide-by-zero/NaN risk in calibrated home/draw/away percentages.
- Training pipeline now re-normalises probabilities before Brier/accuracy scoring.
- Live alert creation now rejects invalid fixture IDs and ignores bad minute/pressure values.
- Value-edge calculations now reject invalid odds/probability inputs.

## Important after import

Run the normal install/build process in Replit so `artifacts/api-server/dist/index.mjs` is rebuilt from the corrected source files:

```bash
pnpm install
pnpm --filter @workspace/api-server run build
```

Then run the database SQL once:

```bash
db/001_prediction_platform.sql
```
