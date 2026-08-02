# Step tracking setup

## Architecture

```text
Phone / watch health app
        ↓ scheduled sync or companion app
Google Apps Script web API
        ↓ validated append-only event
Private Google Sheet
        ↓ aggregated dashboard response
GitHub Pages dashboard
```

The spreadsheet should remain private. Family members do not need direct Sheet access. Each member/device receives a separate write token, while the dashboard uses a lower-privilege family read key.

## 1. Create the Google Sheet

1. Create a private Google Sheet named `Track Everything Data`.
2. Open **Extensions → Apps Script**.
3. Copy `apps-script/Code.gs` and `apps-script/appsscript.json` into the Apps Script project.
4. Run `setupSheets()` once and approve the requested spreadsheet permissions.

This creates:

- `Members`: family member configuration and token hashes.
- `Steps`: append-only step synchronization events.

## 2. Add family members

Create a long random token for every member/device. In Apps Script, run `hashToken('your-random-token')` and copy the returned SHA-256 hash into the `Members` sheet.

Example `Members` row:

| familyId | memberId | name | dailyGoal | writeTokenHash | active |
|---|---|---|---:|---|---|
| family-1 | anantha | Anantha | 10000 | generated hash | TRUE |

Store the original token only in the member's tracking app or device automation. Do not commit it to GitHub.

## 3. Configure dashboard read access

In Apps Script, open **Project Settings → Script properties** and add:

- Property: `READ_KEY_family-1`
- Value: a separate long random dashboard key

The read key only grants access to the aggregated dashboard endpoint. It must never be reused as a member write token.

## 4. Deploy the API

1. Select **Deploy → New deployment → Web app**.
2. Execute as: **Me**.
3. Access: **Anyone**.
4. Deploy and copy the `/exec` URL.

Although the web app is reachable publicly, every read and write request is checked by an application-level key. The Sheet itself stays private.

## 5. Connect GitHub Pages

Edit `config.js`:

```js
window.TRACK_EVERYTHING_CONFIG = {
  apiUrl: 'https://script.google.com/macros/s/DEPLOYMENT_ID/exec',
  familyId: 'family-1',
  readKey: 'your-dashboard-read-key'
};
```

The read key is visible to anyone who can load the GitHub Pages site. For this MVP, treat the site URL and key as family-only access. Before storing expenses or other sensitive data, place authentication in front of the dashboard or move reads through a proper backend.

## 6. Send a step update

Each device should send the cumulative step count for that member and date. Reusing the same `eventId` is safe; duplicate events are ignored.

```bash
curl -X POST 'https://script.google.com/macros/s/DEPLOYMENT_ID/exec' \
  -H 'Content-Type: application/json' \
  -d '{
    "action": "recordSteps",
    "eventId": "anantha-2026-08-02-1700000000",
    "familyId": "family-1",
    "memberId": "anantha",
    "writeToken": "MEMBER_WRITE_TOKEN",
    "date": "2026-08-02",
    "steps": 8240,
    "source": "apple-health",
    "recordedAt": "2026-08-02T20:00:00Z"
  }'
```

## Device integration path

### iPhone / Apple Watch

Use an iOS companion app with HealthKit authorization. The app reads `stepCount` totals and posts them to this API. Apple Shortcuts is useful for prototyping, but a small native or React Native companion app is more dependable for background synchronization.

### Android / Wear OS

Use Health Connect. A companion app requests step permissions, reads daily totals, and posts them to this API. Google Fit APIs should not be the foundation for new work where Health Connect is available.

## Data behavior

- Step records are append-only for auditability.
- The API validates member identity, token, date, count, and timestamp.
- `eventId` provides idempotency.
- Dashboard totals use the latest recorded event per member per day, preventing repeated cumulative uploads from being added together.
- Each token can be revoked independently by disabling the member or replacing its hash.
