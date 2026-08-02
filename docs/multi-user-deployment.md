# Multi-user deployment

Track Everything uses GitHub Pages for the static frontend and a small Node.js API for Google OAuth and Google Sheets access.

## Is Cloudflare required?

No. The backend can run anywhere that supports Node.js and HTTPS, including Google Cloud Run, Firebase Functions, Render, Railway, Fly.io, or a traditional server. Cloudflare Workers would require adapting the Express/Firebase implementation to the Workers runtime.

The current reference deployment is:

- Frontend: GitHub Pages
- Backend: Google Cloud Run
- User metadata and OAuth state: Firestore
- User data: one Google Sheet owned by each signed-in user

This keeps the first deployment within Google's ecosystem and avoids an additional Cloudflare account.

## Google Cloud setup

1. Create or select a Google Cloud project.
2. Enable Google Sheets API, Google Drive API, and Firestore.
3. Configure the OAuth consent screen.
4. Create an OAuth 2.0 Web application client.
5. Add the backend callback URL as an authorized redirect URI:
   `https://YOUR_API_HOST/auth/google/callback`
6. Add the GitHub Pages URL as an authorized JavaScript origin when required by the OAuth configuration.
7. Configure the environment variables listed in `backend/.env.example`.

The application requests these scopes:

- `openid`
- `email`
- `profile`
- `https://www.googleapis.com/auth/spreadsheets`

The Sheets scope permits the application to create and update spreadsheets. Each user sees the consent screen and owns the spreadsheet created for their account.

## Backend deployment using Cloud Run

From the `backend` directory, build a container or deploy from source. Configure all environment variables as Cloud Run secrets or environment variables. Never commit the Google client secret, session secret, service-account credentials, or user refresh tokens.

After deployment:

1. Set `GOOGLE_REDIRECT_URI` to the deployed callback URL.
2. Update the same callback in Google Cloud OAuth credentials.
3. Set `apiUrl` in `config.js` to the Cloud Run service URL.
4. Redeploy GitHub Pages.

## User onboarding flow

1. User opens the GitHub Pages application.
2. User selects **Continue with Google**.
3. Google displays the requested permissions.
4. After consent, the backend creates `Track Everything - <user name>` in the user's Drive.
5. The backend stores the spreadsheet ID and refresh token server-side.
6. The browser receives a short-lived Track Everything session.
7. Dashboard requests are authenticated and read only that user's spreadsheet.

## Family sharing model

The current implementation provisions one owner and one spreadsheet. The next family-sharing increment should add:

- family IDs independent of Google user IDs
- invitations using expiring, single-use tokens
- owner/admin/member roles
- explicit membership rows in Firestore
- optional sharing of the Google Sheet with invited users
- device credentials scoped to one member and one data type

Family members should never receive the owner's Google refresh token.

## Production security requirements

Before public launch:

- encrypt refresh tokens using Cloud KMS or another managed encryption service
- use secure, HTTP-only cookies instead of returning the session in the URL fragment
- expire OAuth state records automatically
- add rate limiting and audit logging
- validate membership for every family-scoped request
- publish a privacy policy and data deletion process
- complete Google's OAuth verification if required for public use
