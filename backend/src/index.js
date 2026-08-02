import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { google } from 'googleapis';
import admin from 'firebase-admin';

const requiredEnv = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'APP_ORIGIN', 'SESSION_SECRET'];
for (const name of requiredEnv) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const app = express();
app.use(cors({ origin: process.env.APP_ORIGIN, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '100kb' }));

const oauth2Client = () => new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const scopes = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/spreadsheets'
];

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/auth/google', async (_req, res) => {
  const state = crypto.randomBytes(24).toString('hex');
  await db.collection('oauthStates').doc(state).set({ createdAt: admin.firestore.FieldValue.serverTimestamp() });
  const client = oauth2Client();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: scopes,
    state
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res, next) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Missing OAuth code or state');

    const stateRef = db.collection('oauthStates').doc(String(state));
    const stateDoc = await stateRef.get();
    if (!stateDoc.exists) return res.status(400).send('Invalid or expired OAuth state');
    await stateRef.delete();

    const client = oauth2Client();
    const { tokens } = await client.getToken(String(code));
    client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data: profile } = await oauth2.userinfo.get();
    if (!profile.id || !profile.email) return res.status(400).send('Google profile is incomplete');

    const userRef = db.collection('users').doc(profile.id);
    const existing = await userRef.get();
    const existingData = existing.exists ? existing.data() : {};
    const refreshToken = tokens.refresh_token || existingData.refreshToken;
    if (!refreshToken) return res.status(400).send('Google did not return offline access. Revoke access and try again.');

    const spreadsheetId = existingData.spreadsheetId || await createUserSpreadsheet(client, profile.name || profile.email);
    await userRef.set({
      email: profile.email,
      name: profile.name || profile.email,
      picture: profile.picture || null,
      refreshToken,
      spreadsheetId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    const session = jwt.sign({ sub: profile.id, email: profile.email }, process.env.SESSION_SECRET, { expiresIn: '1h', issuer: 'track-everything' });
    const redirect = new URL(process.env.APP_ORIGIN);
    redirect.hash = new URLSearchParams({ session, connected: '1' }).toString();
    res.redirect(redirect.toString());
  } catch (error) {
    next(error);
  }
});

app.get('/api/me', requireSession, async (req, res, next) => {
  try {
    const user = await getUser(req.user.sub);
    res.json({ ok: true, data: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/dashboard', requireSession, async (req, res, next) => {
  try {
    const user = await getUser(req.user.sub);
    const auth = authorizedClient(user.refreshToken);
    const sheets = google.sheets({ version: 'v4', auth });
    const response = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: user.spreadsheetId,
      ranges: ['Members!A2:F', 'Steps!A2:H']
    });
    res.json({ ok: true, data: buildDashboard(response.data.valueRanges || []) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/steps', requireSession, async (req, res, next) => {
  try {
    const user = await getUser(req.user.sub);
    const steps = Number(req.body.steps);
    if (!Number.isInteger(steps) || steps < 0 || steps > 200000) return res.status(400).json({ ok: false, error: 'Invalid steps value' });
    const memberId = String(req.body.memberId || req.user.sub);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.date || '')) ? req.body.date : new Date().toISOString().slice(0, 10);
    const eventId = String(req.body.eventId || crypto.randomUUID());
    const now = new Date().toISOString();
    const auth = authorizedClient(user.refreshToken);
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: user.spreadsheetId,
      range: 'Steps!A:H',
      valueInputOption: 'RAW',
      requestBody: { values: [[eventId, req.user.sub, memberId, date, steps, String(req.body.source || 'web'), now, now]] }
    });
    res.status(201).json({ ok: true, data: { eventId, steps } });
  } catch (error) {
    next(error);
  }
});

async function createUserSpreadsheet(auth, displayName) {
  const sheets = google.sheets({ version: 'v4', auth });
  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: `Track Everything - ${displayName}` },
      sheets: [
        { properties: { title: 'Members' }, data: [{ rowData: [{ values: ['familyId','memberId','name','dailyGoal','role','active'].map(value => ({ userEnteredValue: { stringValue: value } })) }] }] },
        { properties: { title: 'Steps' }, data: [{ rowData: [{ values: ['eventId','familyId','memberId','date','steps','source','recordedAt','receivedAt'].map(value => ({ userEnteredValue: { stringValue: value } })) }] }] },
        { properties: { title: 'Tasks' } },
        { properties: { title: 'Expenses' } },
        { properties: { title: 'Savings' } }
      ]
    },
    fields: 'spreadsheetId'
  });
  const spreadsheetId = created.data.spreadsheetId;
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'Members!A:F',
    valueInputOption: 'RAW',
    requestBody: { values: [['owner', 'owner', displayName, 10000, 'owner', true]] }
  });
  return spreadsheetId;
}

function authorizedClient(refreshToken) {
  const client = oauth2Client();
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

async function getUser(id) {
  const doc = await db.collection('users').doc(id).get();
  if (!doc.exists) throw Object.assign(new Error('User is not provisioned'), { statusCode: 404 });
  return { id: doc.id, ...doc.data() };
}

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, picture: user.picture, spreadsheetId: user.spreadsheetId, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${user.spreadsheetId}` };
}

function requireSession(req, res, next) {
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ ok: false, error: 'Authentication required' });
    req.user = jwt.verify(token, process.env.SESSION_SECRET, { issuer: 'track-everything' });
    next();
  } catch (_) {
    res.status(401).json({ ok: false, error: 'Session expired or invalid' });
  }
}

function buildDashboard(valueRanges) {
  const members = (valueRanges[0]?.values || []).map(row => ({ memberId: row[1], name: row[2], goal: Number(row[3] || 10000), active: String(row[5]).toLowerCase() !== 'false' }));
  const rows = valueRanges[1]?.values || [];
  const today = new Date().toISOString().slice(0, 10);
  const latest = new Map();
  for (const row of rows) {
    if (row[3] !== today) continue;
    const previous = latest.get(row[2]);
    if (!previous || String(row[6]) > String(previous[6])) latest.set(row[2], row);
  }
  return {
    generatedAt: new Date().toISOString(),
    date: today,
    members: members.filter(member => member.active).map(member => {
      const row = latest.get(member.memberId);
      return { ...member, steps: Number(row?.[4] || 0), syncedAt: row?.[7] || row?.[6] || null };
    }),
    trend: []
  };
}

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.statusCode || 500).json({ ok: false, error: error.message || 'Unexpected error' });
});

app.listen(process.env.PORT || 8080, () => console.log('Track Everything API started'));
