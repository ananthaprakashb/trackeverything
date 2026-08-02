const config = window.TRACK_EVERYTHING_CONFIG || {};
const SESSION_KEY = 'trackEverythingSession';
let session = sessionStorage.getItem(SESSION_KEY) || '';

const elements = {
  authPanel: document.querySelector('#authPanel'),
  userPanel: document.querySelector('#userPanel'),
  dashboard: document.querySelector('#dashboard'),
  loginButton: document.querySelector('#loginButton'),
  logoutButton: document.querySelector('#logoutButton'),
  refreshButton: document.querySelector('#refreshButton'),
  sheetLink: document.querySelector('#sheetLink'),
  userPicture: document.querySelector('#userPicture'),
  userName: document.querySelector('#userName'),
  userEmail: document.querySelector('#userEmail'),
  familySteps: document.querySelector('#familySteps'),
  familyGoalProgress: document.querySelector('#familyGoalProgress'),
  activeMembers: document.querySelector('#activeMembers'),
  goalsReached: document.querySelector('#goalsReached'),
  lastSync: document.querySelector('#lastSync'),
  statusBadge: document.querySelector('#statusBadge'),
  memberGrid: document.querySelector('#memberGrid'),
  emptyState: document.querySelector('#emptyState'),
  trendChart: document.querySelector('#trendChart')
};

const numberFormatter = new Intl.NumberFormat();

function api(path) {
  if (!config.apiUrl) throw new Error('Backend API URL is not configured');
  return `${String(config.apiUrl).replace(/\/$/, '')}${path}`;
}

function captureOAuthSession() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const token = hash.get('session');
  if (!token) return;
  session = token;
  sessionStorage.setItem(SESSION_KEY, token);
  history.replaceState(null, '', `${location.pathname}${location.search}`);
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (session) headers.Authorization = `Bearer ${session}`;
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(api(path), { ...options, headers, cache: 'no-store' });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    clearSession();
    showSignedOut();
  }
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload.data;
}

function clearSession() {
  session = '';
  sessionStorage.removeItem(SESSION_KEY);
}

function showSignedOut(message = '') {
  elements.authPanel.hidden = false;
  elements.userPanel.hidden = true;
  elements.dashboard.hidden = true;
  elements.logoutButton.hidden = true;
  elements.refreshButton.hidden = true;
  elements.sheetLink.hidden = true;
  if (message) elements.authPanel.querySelector('.subtitle').textContent = message;
}

function showSignedIn(user) {
  elements.authPanel.hidden = true;
  elements.userPanel.hidden = false;
  elements.dashboard.hidden = false;
  elements.logoutButton.hidden = false;
  elements.refreshButton.hidden = false;
  elements.userName.textContent = user.name || 'Google user';
  elements.userEmail.textContent = user.email || '';
  elements.userPicture.src = user.picture || '';
  elements.userPicture.hidden = !user.picture;
  elements.sheetLink.href = user.spreadsheetUrl;
  elements.sheetLink.hidden = !user.spreadsheetUrl;
}

function setStatus(label, isError = false) {
  elements.statusBadge.textContent = label;
  elements.statusBadge.classList.toggle('error', isError);
}

async function initialize() {
  captureOAuthSession();
  if (!session) return showSignedOut();
  try {
    const user = await request('/api/me');
    showSignedIn(user);
    await loadDashboard();
  } catch (error) {
    console.error(error);
    showSignedOut('Your session could not be restored. Sign in again to reconnect your spreadsheet.');
  }
}

async function loadDashboard() {
  elements.refreshButton.disabled = true;
  setStatus('Syncing');
  try {
    const data = await request('/api/dashboard');
    renderDashboard(data);
    setStatus('Live');
  } catch (error) {
    console.error(error);
    setStatus('Unable to sync', true);
  } finally {
    elements.refreshButton.disabled = false;
  }
}

function renderDashboard(data) {
  const members = Array.isArray(data.members) ? data.members : [];
  const familySteps = members.reduce((sum, member) => sum + Number(member.steps || 0), 0);
  const familyGoal = members.reduce((sum, member) => sum + Number(member.goal || 0), 0);
  const goalsReached = members.filter(member => Number(member.steps || 0) >= Number(member.goal || 0)).length;

  elements.familySteps.textContent = numberFormatter.format(familySteps);
  elements.familyGoalProgress.textContent = familyGoal ? `${Math.round((familySteps / familyGoal) * 100)}% of the combined daily goal` : 'No family goal configured';
  elements.activeMembers.textContent = numberFormatter.format(members.length);
  elements.goalsReached.textContent = `${goalsReached}/${members.length}`;
  elements.lastSync.textContent = formatTime(data.generatedAt);
  renderMembers(members);
  renderTrend(Array.isArray(data.trend) ? data.trend : []);
}

function renderMembers(members) {
  elements.memberGrid.innerHTML = '';
  elements.emptyState.hidden = members.length > 0;
  members.forEach(member => {
    const steps = Number(member.steps || 0);
    const goal = Number(member.goal || 0);
    const percent = goal ? Math.min(100, Math.round((steps / goal) * 100)) : 0;
    const card = document.createElement('article');
    card.className = 'member-card';
    card.innerHTML = `<div class="member-row"><h3>${escapeHtml(member.name || member.memberId || 'Family member')}</h3><span class="member-meta">${percent}%</span></div><div class="member-steps">${numberFormatter.format(steps)}</div><div class="progress-track" aria-label="${percent}% of step goal"><div class="progress-bar" style="width:${percent}%"></div></div><p class="member-meta">Goal ${numberFormatter.format(goal)} · synced ${formatTime(member.syncedAt)}</p>`;
    elements.memberGrid.appendChild(card);
  });
}

function renderTrend(trend) {
  elements.trendChart.innerHTML = '';
  if (!trend.length) {
    elements.trendChart.innerHTML = '<p class="empty-state">Trend data will appear after step updates are recorded.</p>';
    return;
  }
  const maximum = Math.max(...trend.map(item => Number(item.steps || 0)), 1);
  trend.forEach(item => {
    const steps = Number(item.steps || 0);
    const height = Math.max(2, Math.round((steps / maximum) * 100));
    const date = new Date(`${item.date}T12:00:00`);
    const column = document.createElement('div');
    column.className = 'trend-column';
    column.innerHTML = `<div class="trend-bar-wrap"><div class="trend-bar" style="height:${height}%"></div></div><div class="trend-value">${numberFormatter.format(steps)}</div><div class="trend-label">${date.toLocaleDateString(undefined, { weekday: 'short' })}</div>`;
    elements.trendChart.appendChild(column);
  });
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

elements.loginButton.addEventListener('click', () => { location.href = api('/auth/google'); });
elements.logoutButton.addEventListener('click', () => { clearSession(); showSignedOut(); });
elements.refreshButton.addEventListener('click', loadDashboard);
initialize();
