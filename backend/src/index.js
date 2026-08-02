import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { google } from 'googleapis';
import admin from 'firebase-admin';

const requiredEnv = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REDIRECT_URI',
  'APP_ORIGIN',
  'SESSION_SECRET',
  'TOKEN_ENCRYPTION_KEY'
];
for (const name of requiredEnv) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

const tokenEncryptionKey = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, 'base64');
if (tokenEncryptionKey.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();
const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: process.env.APP_ORIGIN, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '100kb' }));

const oauth2Client = () => new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const scopes = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/spreadsheets'];

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/auth/google', async (_req, res, next) => {
  try {
    const state = crypto.randomBytes(24).toString('hex');
    await db.collection('oauthStates').doc(state).set({ createdAt: admin.firestore.Timestamp.now() });
    const url = oauth2Client().generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: true,
      scope: scopes,
      state
    });
    res.redirect(url);
  } catch (error) {
    next(error);
  }
});

app.get('/auth/google/callback', async (req, res, next) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send('Missing OAuth code or state');

    const stateRef = db.collection('oauthStates').doc(String(state));
    const stateDoc = await stateRef.get();
    if (!stateDoc.exists) return res.status(400).send('Invalid or expired OAuth state');
    const createdAt = stateDoc.data()?.createdAt?.toMillis?.() || 0;
    await stateRef.delete();
    if (!createdAt || Date.now() - createdAt > 10 * 60 * 1000) return res.status(400).send('Invalid or expired OAuth state');

    const client = oauth2Client();
    const { tokens } = await client.getToken(String(code));
    client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data: profile } = await oauth2.userinfo.get();
    if (!profile.id || !profile.email) return res.status(400).send('Google profile is incomplete');

    const userRef = db.collection('users').doc(profile.id);
    const existing = await userRef.get();
    const existingData = existing.exists ? existing.data() : {};
    const existingRefreshToken = existingData.refreshTokenEncrypted ? decryptToken(existingData.refreshTokenEncrypted) : null;
    const refreshToken = tokens.refresh_token || existingRefreshToken;
    if (!refreshToken) return res.status(400).send('Google did not return offline access. Revoke access and try again.');

    const spreadsheetId = existingData.spreadsheetId || await createUserSpreadsheet(client, profile);
    await userRef.set({
      email: profile.email,
      name: profile.name || profile.email,
      picture: profile.picture || null,
      refreshTokenEncrypted: encryptToken(refreshToken),
      spreadsheetId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    const session = jwt.sign(
      { sub: profile.id, email: profile.email },
      process.env.SESSION_SECRET,
      { expiresIn: '1h', issuer: 'track-everything', audience: 'track-everything-web' }
    );
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
    const sheets = google.sheets({ version: 'v4', auth: authorizedClient(user.refreshTokenEncrypted) });
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
    if (!Number.isInteger(steps) || steps < 0 || steps > 200000) {
      return res.status(400).json({ ok: false, error: 'steps must be an integer from 0 to 200000' });
    }

    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.date || ''))
      ? String(req.body.date)
      : new Date().toISOString().slice(0, 10);
    const eventId = String(req.body.eventId || crypto.randomUUID()).slice(0, 100);
    const now = new Date().toISOString();
    const sheets = google.sheets({ version: 'v4', auth: authorizedClient(user.refreshTokenEncrypted) });

    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: user.spreadsheetId,
      range: 'Steps!A:A'
    });
    if ((existing.data.values || []).some(row => row[0] === eventId)) {
      return res.json({ ok: true, data: { eventId, steps, duplicate: true } });
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId: user.spreadsheetId,
      range: 'Steps!A:H',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[eventId, req.user.sub, req.user.sub, date, steps, String(req.body.source || 'web').slice(0, 80), now, now]]
      }
    });
    res.status(201).json({ ok: true, data: { eventId, steps, duplicate: false } });
  } catch (error) {
    next(error);
  }
});

async function createUserSpreadsheet(auth, profile) {
  const sheets = google.sheets({ version: 'v4', auth });
  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: `Track Everything - ${profile.name || profile.email}` },
      sheets: [
        { properties: { title: 'Members', gridProperties: { frozenRowCount: 1 } }, data: [headerRow(['familyId','memberId','name','dailyGoal','role','active'])] },
        { properties: { title: 'Steps', gridProperties: { frozenRowCount: 1 } }, data: [headerRow(['eventId','familyId','memberId','date','steps','source','recordedAt','receivedAt'])] },
        { properties: { title: 'Tasks', gridProperties: { frozenRowCount: 1 } }, data: [headerRow(['taskId','title','assignedTo','status','dueDate','priority','createdAt','updatedAt'])] },
        { properties: { title: 'Expenses', gridProperties: { frozenRowCount: 1 } }, data: [headerRow(['expenseId','date','category','description','amount','paidBy','createdAt'])] },
        { properties: { title: 'Savings', gridProperties: { frozenRowCount: 1 } }, data: [headerRow(['goalId','name','targetAmount','currentAmount','targetDate','updatedAt'])] }
      ]
    },
    fields: 'spreadsheetId'
  });
  const spreadsheetId = created.data.spreadsheetId;
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: 'Members!A:F',
    valueInputOption: 'RAW',
    requestBody: { values: [[profile.id, profile.id, profile.name || profile.email, 10000, 'owner', true]] }
  });
  return spreadsheetId;
}

function headerRow(headers) {
  return { rowData: [{ values: headers.map(value => ({ userEnteredValue: { stringValue: value } })) }] };
}

function authorizedClient(encryptedRefreshToken) {
  const client = oauth2Client();
  client.setCredentials({ refresh_token: decryptToken(encryptedRefreshToken) });
  return client;
}

function encryptToken(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', tokenEncryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}

function decryptToken(value) {
  const [ivValue, tagValue, encryptedValue] = String(value || '').split('.');
  if (!ivValue || !tagValue || !encryptedValue) throw Object.assign(new Error('Stored Google authorization is invalid'), { statusCode: 401 });
  const decipher = crypto.createDecipheriv('aes-256-gcm', tokenEncryptionKey, Buffer.from(ivValue, 'base64'));
  decipher.setAuthTag(Buffer.from(tagValue, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64')), decipher.final()]).toString('utf8');
}

async function getUser(id) {
  const doc = await db.collection('users').doc(id).get();
  if (!doc.exists) throw Object.assign(new Error('User is not provisioned'), { statusCode: 404 });
  return { id: doc.id, ...doc.data() };
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    picture: user.picture,
    spreadsheetId: user.spreadsheetId,
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${user.spreadsheetId}`
  };
}

function requireSession(req, res, next) {
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ ok: false, error: 'Authentication required' });
    req.user = jwt.verify(token, process.env.SESSION_SECRET, {
      issuer: 'track-everything',
      audience: 'track-everything-web'
    });
    next();
  } catch (_) {
    res.status(401).json({ ok: false, error: 'Session expired or invalid' });
  }
}

function buildDashboard(valueRanges) {
  const members = (valueRanges[0]?.values || []).map(row => ({
    memberId: row[1],
    name: row[2],
    goal: Number(row[3] || 10000),
    active: String(row[5]).toLowerCase() !== 'false'
  }));
  const rows = valueRanges[1]?.values || [];
  const dates = lastDates(7);
  const latestByDateMember = new Map();

  for (const row of rows) {
    const date = String(row[3] || '');
    const memberId = String(row[2] || '');
    if (!dates.includes(date) || !memberId) continue;
    const key = `${date}:${memberId}`;
    const previous = latestByDateMember.get(key);
    if (!previous || String(row[6]) > String(previous[6])) latestByDateMember.set(key, row);
  }

  const today = dates[dates.length - 1];
  return {
    generatedAt: new Date().toISOString(),
    date: today,
    members: members.filter(member => member.active).map(member => {
      const row = latestByDateMember.get(`${today}:${member.memberId}`);
      return { ...member, steps: Number(row?.[4] || 0), syncedAt: row?.[7] || row?.[6] || null };
    }),
    trend: dates.map(date => ({
      date,
      steps: members.reduce((sum, member) => sum + Number(latestByDateMember.get(`${date}:${member.memberId}`)?.[4] || 0), 0)
    }))
  };
}

function lastDates(count) {
  const dates = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - offset);
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.statusCode || 500).json({ ok: false, error: error.message || 'Unexpected error' });
});

app.listen(process.env.PORT || 8080, () => console.log('Track Everything API started'));
