# Error check fixes applied

- API server now defaults to `PORT=3000` instead of crashing when `PORT` is missing.
- API server now handles listen errors using `server.on("error")`, avoiding an invalid Express listen callback signature.
- Bundled `dist/index.mjs` was patched to match the source fix, so the exported Replit app can start immediately.
- SQL migration now includes the base `match_predictions` and `match_outcomes` tables needed by accuracy/calibration/training.
- Bet tracker SQL now validates statuses: `open`, `won`, `lost`, `void`.
- User watchlist now includes a foreign key to `app_users`.
- Fixed value-bet filtering so DRAW/AWAY can be found even when the home market field is missing.
