const SHEETS = { MEMBERS: 'Members', STEPS: 'Steps' };
const MEMBER_HEADERS = ['familyId', 'memberId', 'name', 'dailyGoal', 'writeTokenHash', 'active'];
const STEP_HEADERS = ['eventId', 'familyId', 'memberId', 'date', 'steps', 'source', 'recordedAt', 'receivedAt'];

function doGet(e) {
  try {
    if (String(e.parameter.action || 'dashboard') !== 'dashboard') throw httpError_('Unsupported action', 400);
    const familyId = required_(e.parameter.familyId, 'familyId');
    authorizeRead_(familyId, e.parameter.readKey);
    return json_({ ok: true, data: buildDashboard_(familyId) });
  } catch (error) {
    return json_({ ok: false, error: error.message });
  }
}

function doPost(e) {
  try {
    const payload = parseJson_(e);
    if (String(payload.action || 'recordSteps') !== 'recordSteps') throw httpError_('Unsupported action', 400);
    return json_({ ok: true, data: recordSteps_(payload) });
  } catch (error) {
    return json_({ ok: false, error: error.message });
  }
}

function setupSheets() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(spreadsheet, SHEETS.MEMBERS, MEMBER_HEADERS);
  ensureSheet_(spreadsheet, SHEETS.STEPS, STEP_HEADERS);
}

function hashToken(token) {
  return sha256_(required_(token, 'token'));
}

function recordSteps_(payload) {
  const familyId = required_(payload.familyId, 'familyId');
  const memberId = required_(payload.memberId, 'memberId');
  const writeToken = required_(payload.writeToken, 'writeToken');
  const eventId = required_(payload.eventId, 'eventId');
  const date = validateDate_(required_(payload.date, 'date'));
  const steps = validateSteps_(payload.steps);
  const source = sanitizeText_(payload.source || 'unknown', 80);
  const recordedAt = validateTimestamp_(payload.recordedAt || new Date().toISOString());

  const member = getMember_(familyId, memberId);
  if (!member || !truthy_(member.active)) throw httpError_('Unknown or inactive member', 403);
  if (!constantTimeEqual_(String(member.writeTokenHash), sha256_(writeToken))) throw httpError_('Invalid member token', 403);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.STEPS);
    if (eventExists_(sheet, eventId)) return { eventId: eventId, duplicate: true };
    sheet.appendRow([eventId, familyId, memberId, date, steps, source, recordedAt, new Date().toISOString()]);
  } finally {
    lock.releaseLock();
  }
  return { eventId: eventId, duplicate: false, acceptedSteps: steps };
}

function buildDashboard_(familyId) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const timezone = spreadsheet.getSpreadsheetTimeZone();
  const today = Utilities.formatDate(new Date(), timezone, 'yyyy-MM-dd');
  const dates = lastDates_(7, timezone);
  const members = readObjects_(spreadsheet.getSheetByName(SHEETS.MEMBERS))
    .filter(row => String(row.familyId) === familyId && truthy_(row.active));
  const events = readObjects_(spreadsheet.getSheetByName(SHEETS.STEPS))
    .filter(row => String(row.familyId) === familyId);

  const latestToday = latestByMember_(events.filter(row => String(row.date) === today));
  const memberData = members.map(member => {
    const latest = latestToday[String(member.memberId)];
    return {
      memberId: String(member.memberId),
      name: String(member.name || member.memberId),
      goal: Number(member.dailyGoal || 10000),
      steps: latest ? Number(latest.steps || 0) : 0,
      syncedAt: latest ? String(latest.receivedAt || latest.recordedAt || '') : null
    };
  });

  const trend = dates.map(date => {
    const latest = latestByMember_(events.filter(row => String(row.date) === date));
    return {
      date: date,
      steps: Object.keys(latest).reduce((sum, key) => sum + Number(latest[key].steps || 0), 0)
    };
  });
  return { generatedAt: new Date().toISOString(), date: today, members: memberData, trend: trend };
}

function latestByMember_(events) {
  return events.reduce((result, row) => {
    const memberId = String(row.memberId);
    const previous = result[memberId];
    if (!previous || String(row.recordedAt) > String(previous.recordedAt)) result[memberId] = row;
    return result;
  }, {});
}

function authorizeRead_(familyId, readKey) {
  const expected = PropertiesService.getScriptProperties().getProperty('READ_KEY_' + familyId);
  if (!expected || !constantTimeEqual_(String(readKey || ''), expected)) throw httpError_('Invalid dashboard key', 403);
}

function getMember_(familyId, memberId) {
  return readObjects_(SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEETS.MEMBERS))
    .find(row => String(row.familyId) === familyId && String(row.memberId) === memberId);
}

function eventExists_(sheet, eventId) {
  if (!sheet || sheet.getLastRow() < 2) return false;
  return Boolean(sheet.getRange(2, 1, sheet.getLastRow() - 1, 1)
    .createTextFinder(String(eventId)).matchEntireCell(true).findNext());
}

function ensureSheet_(spreadsheet, name, headers) {
  const sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
  if (sheet.getLastRow() === 0) sheet.appendRow(headers);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
}

function readObjects_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  const values = sheet.getDataRange().getValues();
  const headers = values.shift().map(String);
  return values.map(row => headers.reduce((object, header, index) => {
    object[header] = row[index];
    return object;
  }, {}));
}

function lastDates_(count, timezone) {
  const dates = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - offset);
    dates.push(Utilities.formatDate(date, timezone, 'yyyy-MM-dd'));
  }
  return dates;
}

function parseJson_(e) {
  try { return JSON.parse((e.postData && e.postData.contents) || '{}'); }
  catch (_) { throw httpError_('Request body must be valid JSON', 400); }
}

function validateSteps_(value) {
  const steps = Number(value);
  if (!Number.isInteger(steps) || steps < 0 || steps > 200000) throw httpError_('steps must be an integer from 0 to 200000', 400);
  return steps;
}

function validateDate_(value) {
  const date = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw httpError_('date must use YYYY-MM-DD', 400);
  return date;
}

function validateTimestamp_(value) {
  const timestamp = String(value);
  if (isNaN(Date.parse(timestamp))) throw httpError_('recordedAt must be an ISO timestamp', 400);
  return new Date(timestamp).toISOString();
}

function required_(value, field) {
  if (value === undefined || value === null || String(value).trim() === '') throw httpError_(field + ' is required', 400);
  return String(value).trim();
}

function sanitizeText_(value, maxLength) {
  return String(value).replace(/[\r\n\t]/g, ' ').slice(0, maxLength);
}

function truthy_(value) {
  return value === true || String(value).toLowerCase() === 'true' || Number(value) === 1;
}

function sha256_(value) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value));
  return bytes.map(byte => ('0' + (((byte + 256) % 256).toString(16))).slice(-2)).join('');
}

function constantTimeEqual_(left, right) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
}

function httpError_(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}
