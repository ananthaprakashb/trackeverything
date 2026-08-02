# Google Cloud deployment

Cloudflare is not required. The default deployment uses Google Cloud Run for the Node.js API and Firestore for user records, OAuth state, spreadsheet IDs, and encrypted-token-ready persistence.

## Architecture

1. GitHub Pages hosts the static dashboard.
2. Cloud Run hosts the authenticated API.
3. Google OAuth asks the user for profile and Google Sheets permission.
4. The API creates a `Track Everything - <name>` spreadsheet in the user's Google account.
5. Firestore stores the Google user ID, spreadsheet ID, and refresh token. Production deployments should encrypt refresh tokens with Cloud KMS.
6. The browser receives a one-hour Track Everything session token, not the Google refresh token.

## Google Cloud setup

1. Create or select a Google Cloud project.
2. Enable these APIs:
   - Google Sheets API
   - Google Drive API
   - Cloud Run Admin API
   - Cloud Build API
   - Artifact Registry API
   - Firestore API
   - Secret Manager API
3. Create a Firestore database in Native mode.
4. Configure the OAuth consent screen.
5. Create an OAuth 2.0 Web application client.
6. Add the GitHub Pages URL as an authorized JavaScript origin.
7. After Cloud Run is deployed, add this redirect URI:

   `https://YOUR_CLOUD_RUN_URL/auth/google/callback`

Because the application requests Google Sheets access, public production use may require Google OAuth verification. During development, add specific Google accounts as test users.

## Secrets

Store the following in Secret Manager rather than committing them:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `SESSION_SECRET`

Generate the session secret with a cryptographically secure random generator. Use at least 32 random bytes.

## Deploy the backend

From the repository root:

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT_ID

gcloud builds submit backend \
  --tag REGION-docker.pkg.dev/YOUR_PROJECT_ID/track-everything/api:latest

gcloud run deploy track-everything-api \
  --image REGION-docker.pkg.dev/YOUR_PROJECT_ID/track-everything/api:latest \
  --region REGION \
  --allow-unauthenticated \
  --set-env-vars APP_ORIGIN=https://ananthaprakashb.github.io/trackeverything/,GOOGLE_REDIRECT_URI=https://YOUR_CLOUD_RUN_URL/auth/google/callback \
  --set-secrets GOOGLE_CLIENT_ID=GOOGLE_CLIENT_ID:latest,GOOGLE_CLIENT_SECRET=GOOGLE_CLIENT_SECRET:latest,SESSION_SECRET=SESSION_SECRET:latest
```

The Cloud Run service must be publicly reachable because the browser and Google OAuth callback call it. Application endpoints remain protected by the app session token.

Grant the Cloud Run runtime service account access to Firestore and permission to read the required Secret Manager secrets.

## Configure GitHub Pages

Update `config.js`:

```js
window.TRACK_EVERYTHING_CONFIG = {
  apiUrl: 'https://YOUR_CLOUD_RUN_URL'
};
```

Do not put Google client secrets, refresh tokens, or device write credentials in `config.js`.

## First sign-in behavior

On first consent, the backend creates these tabs in the user's spreadsheet:

- Members
- Steps
- Tasks
- Expenses
- Savings

The signed-in user is inserted as the initial owner/member. Future family invitation endpoints can add members to the same family spreadsheet.

## Production hardening before public launch

- Encrypt refresh tokens with Cloud KMS or store them in a dedicated encrypted secret store.
- Replace bearer tokens in URL fragments with secure, SameSite cookies when the frontend and API are served under a shared custom domain.
- Add token revocation and account deletion.
- Add rate limiting and abuse protection.
- Validate OAuth state expiration and delete expired state documents.
- Restrict member writes through family membership and device credentials.
- Add Firestore retention rules and audit logging.
- Complete Google OAuth verification and publish privacy policy and terms pages.
