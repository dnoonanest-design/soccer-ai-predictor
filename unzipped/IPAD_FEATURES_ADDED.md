# iPad-specific features added

This build adds a dedicated iPad Match Desk at `/ipad`.

## Added features

- Split-screen iPad layout: match list on the left, selected focus match on the right.
- Large touch cards with bigger scorelines and live momentum bars.
- Focus Mode button for a cleaner live-monitoring display.
- Comfort/Compact density toggle saved in local storage.
- Live-only / all-matches toggle.
- Sticky selected-match panel for iPad landscape.
- Larger 48px touch targets for iPad use.
- iPad orientation handling for landscape and portrait.
- Next-goal percentage blocks and pressure-alert panel.
- Direct “Open full detail” button from the iPad panel.

## How to use on iPad

1. Open the web app in Safari.
2. Tap Share → Add to Home Screen.
3. Open it from the iPad Home Screen.
4. Go to **iPad Desk** in the top navigation.
5. Rotate the iPad to landscape for the best split-screen view.

## Notes

The dashboard refreshes every 15 seconds and uses the existing live stats/momentum API fields. If API-Football does not supply enhanced live stats for a match, the screen falls back to basic momentum values instead of crashing.
