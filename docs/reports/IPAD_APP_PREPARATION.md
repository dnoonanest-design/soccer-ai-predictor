# iPad App Preparation Applied

This project has been prepared for iPad use in two ways:

## 1. Progressive Web App (recommended first release)
Added:
- `manifest.webmanifest`
- Apple mobile web app meta tags
- SVG app icons
- service worker caching
- offline fallback page
- install prompt / iPad instructions
- touch-friendly CSS and safe-area support

Use on iPad:
1. Deploy the app over HTTPS.
2. Open the site in Safari on the iPad.
3. Tap Share.
4. Tap Add to Home Screen.

## 2. Push notification groundwork
Added:
- service worker `push` and `notificationclick` handlers
- API routes:
  - `GET /api/push/config`
  - `POST /api/push/subscribe`
  - `POST /api/push/test`

Production push delivery still needs VAPID keys and a persistent subscription table. Set:
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`

## 3. Capacitor iOS wrapper groundwork
Added:
- `capacitor.config.ts`
- Capacitor dependencies/scripts in the dashboard package

To create a native iPad/iOS shell after dependencies install:
```bash
cd artifacts/soccer-dashboard
pnpm install
pnpm run build
pnpm run cap:add:ios
pnpm run cap:sync
```

You will need a Mac with Xcode to build/sign the final App Store iPad app.

## Notes
- The PWA route is fastest and avoids App Store approval.
- The native Capacitor route is best later for App Store distribution and deeper notification handling.
