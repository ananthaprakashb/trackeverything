# Track Everything Mobile

Cross-platform Android and iPhone application built with Expo and React Native.

## Product direction

The mobile app becomes the primary experience for:

- Google sign-in
- group creation and membership
- shared project dashboards
- progress updates
- manual daily steps
- Android Health Connect step sync
- Apple HealthKit step sync

The existing website remains available temporarily for migration and administrative fallback.

## Current status

Implemented:

- Expo/React Native application foundation
- secure local session storage with `expo-secure-store`
- system-browser authentication handoff
- deep-link callback handling using `trackeverything://auth`
- `/api/me` and `/api/dashboard` integration
- member and project overview
- manual daily-step submission
- Android and iOS health capability declarations

Required next:

1. Add `GET /auth/mobile/google` to the Cloud Run backend.
2. Store OAuth state with an approved mobile callback.
3. Redirect with a short-lived, single-use authorization code.
4. Add `POST /api/mobile/session/exchange`.
5. Return mobile access and refresh tokens.
6. Implement Android Health Connect native module.
7. Implement iOS HealthKit native module.
8. Add member invitation and project editing screens.
9. Configure EAS Build and store signing.

Do not send a reusable JWT directly in a production deep-link URL. The current UI accepts a `session` parameter only to make the expected callback contract visible during development; replace it with a one-time code exchange before release.

## Run locally

```bash
cd mobile/app
npm install
npx expo prebuild
npx expo run:android
```

For iOS, run on macOS with Xcode:

```bash
npx expo run:ios
```

Health Connect and HealthKit require development builds. They are not available through a generic Expo Go runtime.

## Backend

Default API:

```text
https://track-everything-api-854374277452.us-west1.run.app
```

Override it through Expo configuration for development and staging builds.
