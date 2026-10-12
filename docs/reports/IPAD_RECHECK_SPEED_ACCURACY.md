# iPad recheck: errors, speed and accuracy

Changes applied in this pass:

- Fixed iPad momentum and next-goal bars so they always normalise to a clean 100% split.
- Guarded iPad localStorage access so Safari private mode/storage restrictions do not crash the page.
- Reduced live iPad refresh from 15 seconds to 12 seconds when viewing live matches, but slowed all-match refresh to 30 seconds to reduce battery/network load.
- Added query stale-time settings to cut unnecessary repeat fetches.
- Made the iPad match query parameters stable with `useMemo` to reduce unnecessary React Query cache churn.
- Improved the main match-detail momentum block so it cannot show `NaN%` or uneven bar totals.
- Added both home and away next-goal percentages on the main match detail page.
- Made API live event parsing safer if API-Football returns partial event objects.
- Adjusted momentum scoring so recent goals/cards influence momentum without overwhelming live xG, shots, corners and dangerous attacks.

Checks run:

- ZIP archive integrity check passed before patching.
- Bundled API JavaScript syntax check passed with `node --check`.
- Key edited TSX files were checked for balanced JSX/brace structure.

Notes:

- Full TypeScript/Vite build could not be run in this environment because the exported project does not include `node_modules`. Replit should run the normal dependency install/build process when opened.
- Prediction accuracy still depends heavily on the API-Football plan fields actually returned for each league/match. Where live xG or dangerous attacks are unavailable, the app falls back to safer basic momentum logic.
