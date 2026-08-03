# Track Everything Health Connect companion

This Android companion reads only the user's daily step total from Health Connect and sends it to the existing Track Everything `/api/steps` endpoint.

## Requirements

- Android Studio with Android SDK 36
- Android 9 or newer
- Health Connect installed on Android 13 or lower; it is built into Android 14+
- A Track Everything account

## Run

1. Open `mobile/android` in Android Studio.
2. Allow Gradle sync to finish.
3. Run the `app` configuration on a physical Android device.
4. Sign in to Track Everything inside the embedded page.
5. Tap **Connect Health** and grant Steps read access.
6. Tap **Sync Steps**.

The app aggregates today's step count through Health Connect and posts one deterministic event ID (`health-connect:YYYY-MM-DD`). Repeated syncs for the same day are idempotent in the current backend, so the first accepted daily value is retained.

## Production work before Play Store release

- Add launcher icons and branded screenshots.
- Add an in-app Health Connect settings/manage-access screen.
- Complete the Google Play health-app declaration for `READ_STEPS`.
- Publish a health-data privacy disclosure explaining collection, use, retention, deletion, and sharing.
- Add background sync only after requesting the separate background-read permission and giving users a sync toggle.

## iPhone

Apple Health data cannot be read by this web application or Android companion. An iOS target must be created in Xcode with the HealthKit capability and `NSHealthShareUsageDescription`, then request read access to `HKQuantityType(.stepCount)`.
