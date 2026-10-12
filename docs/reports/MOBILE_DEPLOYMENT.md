# Mobile / iPad deployment

The project includes an Expo mobile app under:

`artifacts/soccer-mobile`

## Local test

```bash
cd artifacts/soccer-mobile
pnpm install
EXPO_PUBLIC_API_URL=https://your-api-domain.com pnpm start
```

Open the Expo Go app on iPad/iPhone and scan the QR code.

## Production build

Use EAS Build:

```bash
npm install -g eas-cli
eas login
cd artifacts/soccer-mobile
eas build:configure
eas build --platform ios
```

## Required mobile environment

Set one of these:

```env
EXPO_PUBLIC_API_URL=https://your-api-domain.com
```

or:

```env
EXPO_PUBLIC_DOMAIN=your-api-domain.com
```

`EXPO_PUBLIC_API_URL` is preferred because it avoids the previous `https://undefined` issue.
