import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { google } from 'googleapis';
import admin from 'firebase-admin';

const requiredEnv = ['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REDIRECT_URI','APP_ORIGIN','SESSION_SECRET','TOKEN_ENCRYPTION_KEY'];
for (const name of requiredEnv) if (!process.env[name]) throw new Error(`${name} is required`);

const tokenEncryptionKey = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, 'base64');
if (tokenEncryptionKey.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
if (!admin.apps.length) admin.initializeApp();

const db = admin.firestore();
const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: process.env.APP_ORIGIN, methods: ['GET','POST','PATCH','DELETE'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '100kb' }));

const oauth2Client = () => new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
const scopes = ['openid','email','profile','https://www.googleapis.com/auth/drive.file'];
const sheetsApi = auth => google.sheets({ version: 'v4', auth });

app.get('/health', (_req, res) => res.json({ ok: true, oauthScope: 'drive.file', membershipLookup: 'direct' }));

app.get('/auth/google', async (_req, res, next) => {
  try {
    const state = crypto.randomBytes(24).toString('hex');
    await db.collection('oauthStates').doc(state).set({ createdAt: admin.firestore.Timestamp.now() });
    res.redirect(oauth2Client().generateAuthUrl({ access_type: 'offline', prompt: 'consent', include_granted_scopes: true, scope: scopes, state }));
  } catch (error) { next(error); }
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    if (req.query.error) return redirectWithError(res, `Google sign-in was not completed: ${String(req.query.error)}`);
    const { code, state } = req.query;
    if (!code || !state) return redirectWithError(res, 'Missing OAuth code or state');

    const stateRef = db.collection('oauthStates').doc(String(state));
    const stateDoc = await stateRef.get();
    if (!stateDoc.exists) return redirectWithError(res, 'Invalid or expired OAuth state');
    const createdAt = stateDoc.data()?.createdAt?.toMillis?.() || 0;
    await stateRef.delete();
    if (!createdAt || Date.now() - createdAt > 10 * 60 * 1000) return redirectWithError(res, 'Invalid or expired OAuth state');

    const client = oauth2Client();
    const { tokens } = await client.getToken(String(code));
    client.setCredentials(tokens);
    const { data: profile } = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
    if (!profile.id || !profile.email) return redirectWithError(res, 'Google profile is incomplete');

    const email = normalizeEmail(profile.email);
    const userRef = db.collection('users').doc(profile.id);
    const existing = await userRef.get();
    const existingData = existing.exists ? existing.data() : {};
    const oldRefresh = existingData.refreshTokenEncrypted ? decryptToken(existingData.refreshTokenEncrypted) : null;
    const refreshToken = tokens.refresh_token || oldRefresh;
    if (!refreshToken) return redirectWithError(res, 'Google did not return offline access. Revoke Track Everything and sign in again.');

    let membership = await findMembership(email);
    let group;
    if (membership?.groupId) {
      group = await getGroup(membership.groupId);
    } else if (existingData.groupId) {
      group = await getGroup(existingData.groupId);
      membership = { groupId: group.id, role: existingData.role || 'member', name: profile.name || email };
      await saveMemberLookup(email, membership);
    } else {
      group = await createGroup(client, profile);
      membership = { groupId: group.id, role: 'admin', name: profile.name || email };
    }

    await userRef.set({
      email,
      name: profile.name || email,
      picture: profile.picture || null,
      refreshTokenEncrypted: encryptToken(refreshToken),
      groupId: group.id,
      role: membership.role,
      spreadsheetId: group.spreadsheetId,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    await db.collection('groups').doc(group.id).collection('members').doc(email).set({
      email,
      name: profile.name || membership.name || email,
      userId: profile.id,
      role: membership.role,
      status: 'active',
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    await saveMemberLookup(email, { groupId: group.id, role: membership.role, name: profile.name || membership.name || email });

    if (membership.role !== 'admin') await shareSpreadsheetWithMember(group, email);

    const session = jwt.sign({ sub: profile.id, email, groupId: group.id, role: membership.role }, process.env.SESSION_SECRET, {
      expiresIn: '1h', issuer: 'track-everything', audience: 'track-everything-web'
    });
    const redirect = new URL(process.env.APP_ORIGIN);
    redirect.hash = new URLSearchParams({ session, connected: '1' }).toString();
    res.redirect(redirect.toString());
  } catch (error) {
    console.error('OAuth callback failed', error);
    return redirectWithError(res, readableError(error));
  }
});

app.get('/api/me', requireSession, async (req, res, next) => {
  try {
    const user = await getUser(req.user.sub);
    const group = await getGroup(user.groupId);
    res.json({ ok: true, data: publicUser(user, group) });
  } catch (error) { next(error); }
});

app.get('/api/dashboard', requireSession, async (req, res, next) => {
  try {
    const context = await getGroupContext(req.user.sub);
    const response = await sheetsApi(context.auth).spreadsheets.values.batchGet({
      spreadsheetId: context.group.spreadsheetId,
      ranges: ['Members!A2:F','Steps!A2:H','Projects!A2:G']
    });
    res.json({ ok: true, data: {
      ...buildDashboard(response.data.valueRanges || []),
      group: { id: context.group.id, name: context.group.name, role: context.user.role },
      projects: buildProjects(response.data.valueRanges?.[2]?.values || [])
    } });
  } catch (error) { next(error); }
});

app.get('/api/group/members', requireSession, async (req, res, next) => {
  try {
    const context = await getGroupContext(req.user.sub);
    const snapshot = await db.collection('groups').doc(context.group.id).collection('members').get();
    res.json({ ok: true, data: snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })) });
  } catch (error) { next(error); }
});

app.post('/api/group/members', requireSession, requireAdmin, async (req, res, next) => {
  try {
    const context = await getGroupContext(req.user.sub);
    const email = normalizeEmail(req.body.email);
    const name = String(req.body.name || email).trim().slice(0, 100);
    const dailyGoal = Number(req.body.dailyGoal || 10000);
    if (!isValidEmail(email)) return res.status(400).json({ ok: false, error: 'A valid member email is required' });
    if (!Number.isInteger(dailyGoal) || dailyGoal < 1 || dailyGoal > 100000) return res.status(400).json({ ok: false, error: 'dailyGoal must be an integer from 1 to 100000' });

    const memberRef = db.collection('groups').doc(context.group.id).collection('members').doc(email);
    const existing = await memberRef.get();
    if (!existing.exists) {
      await sheetsApi(context.auth).spreadsheets.values.append({
        spreadsheetId: context.group.spreadsheetId,
        range: 'Members!A:F', valueInputOption: 'RAW',
        requestBody: { values: [[context.group.id, email, name, dailyGoal, 'member', true]] }
      });
    }
    const role = existing.data()?.role || 'member';
    await memberRef.set({ email, name, role, status: existing.data()?.status || 'invited', dailyGoal, invitedBy: req.user.email, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await saveMemberLookup(email, { groupId: context.group.id, role, name });
    await shareSpreadsheetWithMember(context.group, email, context.auth);
    res.status(existing.exists ? 200 : 201).json({ ok: true, data: { email, name, dailyGoal, sheetShared: true } });
  } catch (error) { next(error); }
});

app.post('/api/projects', requireSession, async (req, res, next) => {
  try {
    const context = await getGroupContext(req.user.sub);
    const name = String(req.body.name || '').trim().slice(0, 60);
    const type = String(req.body.type || 'general').trim().toLowerCase().slice(0, 30);
    if (!name) return res.status(400).json({ ok: false, error: 'Project name is required' });
    if (!['general','steps','percentage','count'].includes(type)) return res.status(400).json({ ok: false, error: 'Unsupported project type' });

    const sheets = sheetsApi(context.auth);
    const metadata = await sheets.spreadsheets.get({ spreadsheetId: context.group.spreadsheetId, fields: 'sheets.properties.title' });
    const sheetTitle = uniqueSheetTitle(name, new Set((metadata.data.sheets || []).map(sheet => sheet.properties?.title)));
    const projectId = crypto.randomUUID();
    const now = new Date().toISOString();
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: context.group.spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: sheetTitle, gridProperties: { frozenRowCount: 1 } } } }] } });
    await sheets.spreadsheets.values.update({
      spreadsheetId: context.group.spreadsheetId,
      range: `'${escapeSheetTitle(sheetTitle)}'!A1:G1`, valueInputOption: 'RAW',
      requestBody: { values: [['entryId','memberEmail','date','value','notes','createdBy','updatedAt']] }
    });
    await sheets.spreadsheets.values.append({
      spreadsheetId: context.group.spreadsheetId, range: 'Projects!A:G', valueInputOption: 'RAW',
      requestBody: { values: [[projectId, name, type, sheetTitle, req.user.email, now, 'active']] }
    });
    res.status(201).json({ ok: true, data: { projectId, name, type, sheetTitle } });
  } catch (error) { next(error); }
});

app.get('/api/projects/:projectId/entries', requireSession, async (req, res, next) => {
  try {
    const context = await getGroupContext(req.user.sub);
    const project = await findProject(context, req.params.projectId);
    const range = project.sheetTitle === 'Steps' ? 'Steps!A2:H' : `'${escapeSheetTitle(project.sheetTitle)}'!A2:G`;
    const result = await sheetsApi(context.auth).spreadsheets.values.get({ spreadsheetId: context.group.spreadsheetId, range });
    res.json({ ok: true, data: { project, entries: buildProjectEntries(project, result.data.values || []) } });
  } catch (error) { next(error); }
});

app.post('/api/projects/:projectId/entries', requireSession, async (req, res, next) => {
  try {
    const context = await getGroupContext(req.user.sub);
    const project = await findProject(context, req.params.projectId);
    const value = Number(req.body.value);
    if (!Number.isFinite(value) || value < 0 || value > 100000000) return res.status(400).json({ ok: false, error: 'A valid non-negative progress value is required' });
    if (project.type === 'percentage' && value > 100) return res.status(400).json({ ok: false, error: 'Percentage progress cannot exceed 100' });
    const date = validDate(req.body.date) ? String(req.body.date) : new Date().toISOString().slice(0, 10);
    const notes = String(req.body.notes || '').trim().slice(0, 500);
    const entryId = crypto.randomUUID();
    const now = new Date().toISOString();
    const sheets = sheetsApi(context.auth);

    if (project.sheetTitle === 'Steps' || project.type === 'steps') {
      await sheets.spreadsheets.values.append({ spreadsheetId: context.group.spreadsheetId, range: 'Steps!A:H', valueInputOption: 'RAW', requestBody: { values: [[entryId, context.group.id, req.user.email, date, Math.round(value), notes || 'project-web', now, now]] } });
    } else {
      await sheets.spreadsheets.values.append({ spreadsheetId: context.group.spreadsheetId, range: `'${escapeSheetTitle(project.sheetTitle)}'!A:G`, valueInputOption: 'RAW', requestBody: { values: [[entryId, req.user.email, date, value, notes, req.user.email, now]] } });
    }
    res.status(201).json({ ok: true, data: { entryId, projectId: project.projectId, value, date } });
  } catch (error) { next(error); }
});

app.post('/api/steps', requireSession, async (req, res, next) => {
  try {
    const context = await getGroupContext(req.user.sub);
    const steps = Number(req.body.steps);
    if (!Number.isInteger(steps) || steps < 0 || steps > 200000) return res.status(400).json({ ok: false, error: 'steps must be an integer from 0 to 200000' });
    const date = validDate(req.body.date) ? String(req.body.date) : new Date().toISOString().slice(0, 10);
    const eventId = String(req.body.eventId || crypto.randomUUID()).slice(0, 100);
    const now = new Date().toISOString();
    const sheets = sheetsApi(context.auth);
    const existing = await sheets.spreadsheets.values.get({ spreadsheetId: context.group.spreadsheetId, range: 'Steps!A:A' });
    if ((existing.data.values || []).some(row => row[0] === eventId)) return res.json({ ok: true, data: { eventId, steps, duplicate: true } });
    await sheets.spreadsheets.values.append({ spreadsheetId: context.group.spreadsheetId, range: 'Steps!A:H', valueInputOption: 'RAW', requestBody: { values: [[eventId, context.group.id, req.user.email, date, steps, String(req.body.source || 'web').slice(0, 80), now, now]] } });
    res.status(201).json({ ok: true, data: { eventId, steps, duplicate: false } });
  } catch (error) { next(error); }
});

async function createGroup(auth, profile) {
  const groupId = crypto.randomUUID();
  const ownerEmail = normalizeEmail(profile.email);
  const spreadsheetId = await createGroupSpreadsheet(auth, profile, groupId);
  const group = { name: `${profile.name || profile.email}'s Group`, ownerUserId: profile.id, ownerEmail, spreadsheetId, createdAt: admin.firestore.FieldValue.serverTimestamp() };
  await db.collection('groups').doc(groupId).set(group);
  await db.collection('groups').doc(groupId).collection('members').doc(ownerEmail).set({ email: ownerEmail, name: profile.name || profile.email, userId: profile.id, role: 'admin', status: 'active', dailyGoal: 10000, createdAt: admin.firestore.FieldValue.serverTimestamp() });
  await saveMemberLookup(ownerEmail, { groupId, role: 'admin', name: profile.name || profile.email });
  return { id: groupId, ...group };
}

async function createGroupSpreadsheet(auth, profile, groupId) {
  const sheets = sheetsApi(auth);
  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: `Track Everything - ${profile.name || profile.email}` },
      sheets: [
        { properties: { title: 'Members', gridProperties: { frozenRowCount: 1 } }, data: [headerRow(['familyId','memberId','name','dailyGoal','role','active'])] },
        { properties: { title: 'Projects', gridProperties: { frozenRowCount: 1 } }, data: [headerRow(['projectId','name','type','sheetTitle','createdBy','createdAt','status'])] },
        { properties: { title: 'Steps', gridProperties: { frozenRowCount: 1 } }, data: [headerRow(['eventId','familyId','memberId','date','steps','source','recordedAt','receivedAt'])] }
      ]
    }, fields: 'spreadsheetId'
  });
  const spreadsheetId = created.data.spreadsheetId;
  const now = new Date().toISOString();
  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: { valueInputOption: 'RAW', data: [
    { range: 'Members!A2:F2', values: [[groupId, normalizeEmail(profile.email), profile.name || profile.email, 10000, 'admin', true]] },
    { range: 'Projects!A2:G2', values: [[crypto.randomUUID(), 'Step Tracking', 'steps', 'Steps', normalizeEmail(profile.email), now, 'active']] }
  ] } });
  return spreadsheetId;
}

async function findMembership(email) {
  const doc = await db.collection('memberLookup').doc(normalizeEmail(email)).get();
  return doc.exists ? doc.data() : null;
}

async function saveMemberLookup(email, membership) {
  await db.collection('memberLookup').doc(normalizeEmail(email)).set({
    email: normalizeEmail(email),
    groupId: membership.groupId,
    role: membership.role || 'member',
    name: membership.name || normalizeEmail(email),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

async function shareSpreadsheetWithMember(group, email, suppliedAuth = null) {
  if (normalizeEmail(email) === normalizeEmail(group.ownerEmail)) return;
  const auth = suppliedAuth || authorizedClient((await getUser(group.ownerUserId)).refreshTokenEncrypted);
  try {
    await google.drive({ version: 'v3', auth }).permissions.create({ fileId: group.spreadsheetId, sendNotificationEmail: true, requestBody: { type: 'user', role: 'writer', emailAddress: email }, fields: 'id' });
  } catch (error) {
    if (![403,409].includes(Number(error?.code)) && !String(error?.message || '').toLowerCase().includes('already')) throw error;
  }
}

async function getGroupContext(userId) {
  const user = await getUser(userId);
  const group = await getGroup(user.groupId);
  const owner = await getUser(group.ownerUserId);
  return { user, group, owner, auth: authorizedClient(owner.refreshTokenEncrypted) };
}

async function findProject(context, projectId) {
  const result = await sheetsApi(context.auth).spreadsheets.values.get({ spreadsheetId: context.group.spreadsheetId, range: 'Projects!A2:G' });
  const project = buildProjects(result.data.values || []).find(item => item.projectId === String(projectId));
  if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
  return project;
}

function authorizedClient(encryptedRefreshToken) { const client = oauth2Client(); client.setCredentials({ refresh_token: decryptToken(encryptedRefreshToken) }); return client; }
function headerRow(headers) { return { rowData: [{ values: headers.map(value => ({ userEnteredValue: { stringValue: value } })) }] }; }
function encryptToken(value) { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', tokenEncryptionKey, iv); const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.'); }
function decryptToken(value) { const [ivValue, tagValue, encryptedValue] = String(value || '').split('.'); if (!ivValue || !tagValue || !encryptedValue) throw Object.assign(new Error('Stored Google authorization is invalid'), { statusCode: 401 }); const decipher = crypto.createDecipheriv('aes-256-gcm', tokenEncryptionKey, Buffer.from(ivValue, 'base64')); decipher.setAuthTag(Buffer.from(tagValue, 'base64')); return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64')), decipher.final()]).toString('utf8'); }
async function getUser(id) { const doc = await db.collection('users').doc(id).get(); if (!doc.exists) throw Object.assign(new Error('User is not provisioned'), { statusCode: 404 }); return { id: doc.id, ...doc.data() }; }
async function getGroup(id) { if (!id) throw Object.assign(new Error('User is not assigned to a group'), { statusCode: 409 }); const doc = await db.collection('groups').doc(id).get(); if (!doc.exists) throw Object.assign(new Error('Group is not provisioned'), { statusCode: 404 }); return { id: doc.id, ...doc.data() }; }
function publicUser(user, group) { return { id: user.id, name: user.name, email: user.email, picture: user.picture, role: user.role, groupId: group.id, groupName: group.name, spreadsheetId: group.spreadsheetId, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${group.spreadsheetId}` }; }

function requireSession(req, res, next) {
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ ok: false, error: 'Authentication required' });
    req.user = jwt.verify(token, process.env.SESSION_SECRET, { issuer: 'track-everything', audience: 'track-everything-web' });
    next();
  } catch (_) { res.status(401).json({ ok: false, error: 'Session expired or invalid' }); }
}

async function requireAdmin(req, res, next) {
  try { const user = await getUser(req.user.sub); if (user.role !== 'admin') return res.status(403).json({ ok: false, error: 'Group admin access is required' }); next(); }
  catch (error) { next(error); }
}

function buildDashboard(valueRanges) {
  const members = (valueRanges[0]?.values || []).map(row => ({ memberId: row[1], name: row[2], goal: Number(row[3] || 10000), active: String(row[5]).toLowerCase() !== 'false' }));
  const rows = valueRanges[1]?.values || [];
  const dates = lastDates(7);
  const latest = new Map();
  for (const row of rows) {
    const date = String(row[3] || ''), memberId = String(row[2] || '');
    if (!dates.includes(date) || !memberId) continue;
    const key = `${date}:${memberId}`, previous = latest.get(key);
    if (!previous || String(row[6]) > String(previous[6])) latest.set(key, row);
  }
  const today = dates.at(-1);
  return {
    generatedAt: new Date().toISOString(), date: today,
    members: members.filter(member => member.active).map(member => { const row = latest.get(`${today}:${member.memberId}`); return { ...member, steps: Number(row?.[4] || 0), syncedAt: row?.[7] || row?.[6] || null }; }),
    trend: dates.map(date => ({ date, steps: members.reduce((sum, member) => sum + Number(latest.get(`${date}:${member.memberId}`)?.[4] || 0), 0) }))
  };
}

function buildProjects(rows) { return rows.filter(row => String(row[6] || 'active') !== 'archived').map(row => ({ projectId: row[0], name: row[1], type: row[2], sheetTitle: row[3], createdBy: row[4], createdAt: row[5], status: row[6] || 'active' })); }
function buildProjectEntries(project, rows) { return project.sheetTitle === 'Steps' ? rows.map(row => ({ entryId: row[0], memberEmail: row[2], date: row[3], value: Number(row[4] || 0), notes: row[5], updatedAt: row[7] || row[6] })) : rows.map(row => ({ entryId: row[0], memberEmail: row[1], date: row[2], value: Number(row[3] || 0), notes: row[4], createdBy: row[5], updatedAt: row[6] })); }
function uniqueSheetTitle(name, existingTitles) { const base = String(name).replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Project'; let title = base, counter = 2; while (existingTitles.has(title)) title = `${base.slice(0, 75)} ${counter++}`; return title; }
function escapeSheetTitle(value) { return String(value).replaceAll("'", "''"); }
function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function isValidEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')); }
function lastDates(count) { const dates = []; for (let offset = count - 1; offset >= 0; offset--) { const date = new Date(); date.setUTCDate(date.getUTCDate() - offset); dates.push(date.toISOString().slice(0, 10)); } return dates; }
function redirectWithError(res, message) { const redirect = new URL(process.env.APP_ORIGIN); redirect.hash = new URLSearchParams({ oauth_error: message }).toString(); return res.redirect(redirect.toString()); }
function readableError(error) { return error?.response?.data?.error?.message || error?.response?.data?.error_description || error?.message || 'Unexpected sign-in error'; }

app.use((error, _req, res, _next) => {
  console.error(error);
  const candidate = Number(error?.statusCode || error?.response?.status || 500);
  const status = candidate >= 400 && candidate <= 599 ? candidate : 500;
  res.status(status).json({ ok: false, error: readableError(error) });
});

app.listen(process.env.PORT || 8080, () => console.log('Track Everything API started'));