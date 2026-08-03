const config = window.TRACK_EVERYTHING_CONFIG || {};
const SESSION_KEY = 'trackEverythingSession';
let session = sessionStorage.getItem(SESSION_KEY) || '';
let currentUser = null;

const $ = selector => document.querySelector(selector);
const elements = {
  authPanel: $('#authPanel'), userPanel: $('#userPanel'), dashboard: $('#dashboard'), loginButton: $('#loginButton'), logoutButton: $('#logoutButton'), refreshButton: $('#refreshButton'), sheetLink: $('#sheetLink'),
  userPicture: $('#userPicture'), userName: $('#userName'), userEmail: $('#userEmail'), groupName: $('#groupName'), adminPanel: $('#adminPanel'),
  familySteps: $('#familySteps'), familyGoalProgress: $('#familyGoalProgress'), activeMembers: $('#activeMembers'), goalsReached: $('#goalsReached'), projectCount: $('#projectCount'),
  statusBadge: $('#statusBadge'), memberGrid: $('#memberGrid'), emptyState: $('#emptyState'), trendChart: $('#trendChart'), projectGrid: $('#projectGrid'),
  stepForm: $('#stepForm'), stepInput: $('#stepInput'), stepDate: $('#stepDate'), stepMessage: $('#stepMessage'),
  memberForm: $('#memberForm'), memberEmail: $('#memberEmail'), memberName: $('#memberName'), memberGoal: $('#memberGoal'), memberMessage: $('#memberMessage'),
  projectForm: $('#projectForm'), projectName: $('#projectName'), projectType: $('#projectType'), projectMessage: $('#projectMessage')
};

const numberFormatter = new Intl.NumberFormat();
elements.stepDate.value = new Date().toISOString().slice(0, 10);

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
  if (response.status === 401) { clearSession(); showSignedOut(); }
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload.data;
}

function clearSession() { session = ''; currentUser = null; sessionStorage.removeItem(SESSION_KEY); }
function showSignedOut(message = '') {
  elements.authPanel.hidden = false; elements.userPanel.hidden = true; elements.dashboard.hidden = true;
  elements.logoutButton.hidden = true; elements.refreshButton.hidden = true; elements.sheetLink.hidden = true;
  if (message) elements.authPanel.querySelector('.subtitle').textContent = message;
}
function showSignedIn(user) {
  currentUser = user;
  elements.authPanel.hidden = true; elements.userPanel.hidden = false; elements.dashboard.hidden = false;
  elements.logoutButton.hidden = false; elements.refreshButton.hidden = false;
  elements.userName.textContent = user.name || 'Google user'; elements.userEmail.textContent = user.email || '';
  elements.groupName.textContent = `${user.groupName || 'Shared group'} · ${user.role === 'admin' ? 'Admin' : 'Member'}`;
  elements.userPicture.src = user.picture || ''; elements.userPicture.hidden = !user.picture;
  elements.sheetLink.href = user.spreadsheetUrl; elements.sheetLink.hidden = !user.spreadsheetUrl;
  elements.adminPanel.hidden = user.role !== 'admin';
}
function setStatus(label, isError = false) { elements.statusBadge.textContent = label; elements.statusBadge.classList.toggle('error', isError); }
function setMessage(element, message, isError = false) { element.textContent = message; element.classList.toggle('error', isError); }

async function initialize() {
  captureOAuthSession();
  if (!session) return showSignedOut();
  try { const user = await request('/api/me'); showSignedIn(user); await loadDashboard(); }
  catch (error) { console.error(error); showSignedOut('Your session could not be restored. Sign in again to reconnect your group.'); }
}

async function loadDashboard() {
  elements.refreshButton.disabled = true; setStatus('Syncing');
  try { const data = await request('/api/dashboard'); renderDashboard(data); setStatus('Live'); }
  catch (error) { console.error(error); setStatus('Unable to sync', true); }
  finally { elements.refreshButton.disabled = false; }
}

function renderDashboard(data) {
  const members = Array.isArray(data.members) ? data.members : [];
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const totalSteps = members.reduce((sum, member) => sum + Number(member.steps || 0), 0);
  const totalGoal = members.reduce((sum, member) => sum + Number(member.goal || 0), 0);
  const reached = members.filter(member => Number(member.steps || 0) >= Number(member.goal || 0)).length;
  elements.familySteps.textContent = numberFormatter.format(totalSteps);
  elements.familyGoalProgress.textContent = totalGoal ? `${Math.round((totalSteps / totalGoal) * 100)}% of the combined daily goal` : 'No group goal configured';
  elements.activeMembers.textContent = numberFormatter.format(members.length);
  elements.goalsReached.textContent = `${reached}/${members.length}`;
  elements.projectCount.textContent = numberFormatter.format(projects.length);
  renderMembers(members); renderProjects(projects); renderTrend(Array.isArray(data.trend) ? data.trend : []);
}

function renderProjects(projects) {
  elements.projectGrid.innerHTML = '';
  projects.forEach(project => {
    const card = document.createElement('article');
    card.className = 'project-card';
    card.innerHTML = `<p class="eyebrow">${escapeHtml(project.type || 'general')}</p><h3>${escapeHtml(project.name || 'Untitled project')}</h3><p class="member-meta">Sheet page: ${escapeHtml(project.sheetTitle || '—')}</p><p class="member-meta">Created by ${escapeHtml(project.createdBy || 'group member')}</p>`;
    elements.projectGrid.appendChild(card);
  });
  if (!projects.length) elements.projectGrid.innerHTML = '<p class="empty-state">No projects created yet.</p>';
}

function renderMembers(members) {
  elements.memberGrid.innerHTML = ''; elements.emptyState.hidden = members.length > 0;
  members.forEach(member => {
    const steps = Number(member.steps || 0), goal = Number(member.goal || 0), percent = goal ? Math.min(100, Math.round((steps / goal) * 100)) : 0;
    const card = document.createElement('article'); card.className = 'member-card';
    card.innerHTML = `<div class="member-row"><h3>${escapeHtml(member.name || member.memberId || 'Group member')}</h3><span class="member-meta">${percent}%</span></div><div class="member-steps">${numberFormatter.format(steps)}</div><div class="progress-track"><div class="progress-bar" style="width:${percent}%"></div></div><p class="member-meta">Goal ${numberFormatter.format(goal)} · synced ${formatTime(member.syncedAt)}</p>`;
    elements.memberGrid.appendChild(card);
  });
}

function renderTrend(trend) {
  elements.trendChart.innerHTML = '';
  if (!trend.length) { elements.trendChart.innerHTML = '<p class="empty-state">Trend data will appear after step updates are recorded.</p>'; return; }
  const maximum = Math.max(...trend.map(item => Number(item.steps || 0)), 1);
  trend.forEach(item => {
    const steps = Number(item.steps || 0), height = Math.max(2, Math.round((steps / maximum) * 100));
    const date = new Date(`${item.date}T12:00:00`), column = document.createElement('div'); column.className = 'trend-column';
    column.innerHTML = `<div class="trend-bar-wrap"><div class="trend-bar" style="height:${height}%"></div></div><div class="trend-value">${numberFormatter.format(steps)}</div><div class="trend-label">${date.toLocaleDateString(undefined, { weekday: 'short' })}</div>`;
    elements.trendChart.appendChild(column);
  });
}

async function submitForm(form, messageElement, action) {
  const button = form.querySelector('button[type="submit"]'); button.disabled = true; setMessage(messageElement, 'Saving…');
  try { const result = await action(); setMessage(messageElement, 'Saved successfully.'); await loadDashboard(); return result; }
  catch (error) { console.error(error); setMessage(messageElement, error.message, true); }
  finally { button.disabled = false; }
}

function formatTime(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;'); }

elements.loginButton.addEventListener('click', () => { location.href = api('/auth/google'); });
elements.logoutButton.addEventListener('click', () => { clearSession(); showSignedOut(); });
elements.refreshButton.addEventListener('click', loadDashboard);
elements.stepForm.addEventListener('submit', event => { event.preventDefault(); submitForm(elements.stepForm, elements.stepMessage, () => request('/api/steps', { method: 'POST', body: JSON.stringify({ steps: Number(elements.stepInput.value), date: elements.stepDate.value, source: 'manual-web' }) })).then(() => { elements.stepInput.value = ''; }); });
elements.memberForm.addEventListener('submit', event => { event.preventDefault(); submitForm(elements.memberForm, elements.memberMessage, () => request('/api/group/members', { method: 'POST', body: JSON.stringify({ email: elements.memberEmail.value, name: elements.memberName.value, dailyGoal: Number(elements.memberGoal.value) }) })).then(() => { elements.memberEmail.value = ''; elements.memberName.value = ''; }); });
elements.projectForm.addEventListener('submit', event => { event.preventDefault(); submitForm(elements.projectForm, elements.projectMessage, () => request('/api/projects', { method: 'POST', body: JSON.stringify({ name: elements.projectName.value, type: elements.projectType.value }) })).then(() => { elements.projectName.value = ''; }); });
initialize();
