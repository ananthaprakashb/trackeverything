const config = window.TRACK_EVERYTHING_CONFIG || {};
const SESSION_KEY = 'trackEverythingSession';
let session = sessionStorage.getItem(SESSION_KEY) || '';
let currentUser = null;
let currentProjects = [];
let deferredInstallPrompt = null;

const $ = selector => document.querySelector(selector);
const elements = {
  authPanel: $('#authPanel'), userPanel: $('#userPanel'), dashboard: $('#dashboard'), loginButton: $('#loginButton'), logoutButton: $('#logoutButton'), refreshButton: $('#refreshButton'), sheetLink: $('#sheetLink'), oauthMessage: $('#oauthMessage'),
  userPicture: $('#userPicture'), userName: $('#userName'), userEmail: $('#userEmail'), groupName: $('#groupName'), adminPanel: $('#adminPanel'), projectAdminPanel: $('#projectAdminPanel'),
  familySteps: $('#familySteps'), familyGoalProgress: $('#familyGoalProgress'), activeMembers: $('#activeMembers'), goalsReached: $('#goalsReached'), projectCount: $('#projectCount'),
  statusBadge: $('#statusBadge'), memberGrid: $('#memberGrid'), emptyState: $('#emptyState'), trendChart: $('#trendChart'), projectGrid: $('#projectGrid'),
  memberForm: $('#memberForm'), memberEmail: $('#memberEmail'), memberGoal: $('#memberGoal'), memberMessage: $('#memberMessage'), copyInstructionsButton: $('#copyInstructionsButton'),
  quickStepsForm: $('#quickStepsForm'), quickSteps: $('#quickSteps'), quickStepsDate: $('#quickStepsDate'), quickStepsMessage: $('#quickStepsMessage'),
  projectForm: $('#projectForm'), projectName: $('#projectName'), projectType: $('#projectType'), projectMessage: $('#projectMessage'),
  progressForm: $('#progressForm'), progressProject: $('#progressProject'), progressValue: $('#progressValue'), progressDate: $('#progressDate'), progressNotes: $('#progressNotes'), progressMessage: $('#progressMessage'), entriesTitle: $('#entriesTitle'), entriesTable: $('#entriesTable'),
  networkStatus: $('#networkStatus'), installButton: $('#installButton')
};

const numberFormatter = new Intl.NumberFormat();
const today = localDateString();
elements.progressDate.value = today;
elements.quickStepsDate.value = today;

function localDateString() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

function api(path) {
  if (!config.apiUrl) throw new Error('Backend API URL is not configured');
  return `${String(config.apiUrl).replace(/\/$/, '')}${path}`;
}

function captureOAuthResult() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const token = hash.get('session');
  const oauthError = hash.get('oauth_error');
  if (oauthError) elements.oauthMessage.textContent = oauthError;
  if (token) {
    session = token;
    sessionStorage.setItem(SESSION_KEY, token);
  }
  if (token || oauthError) history.replaceState(null, '', `${location.pathname}${location.search}`);
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (session) headers.Authorization = `Bearer ${session}`;
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(api(path), { ...options, headers, cache: 'no-store' });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) { clearSession(); showSignedOut('Your session expired. Sign in again.'); }
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload.data;
}

function clearSession() {
  session = '';
  currentUser = null;
  currentProjects = [];
  sessionStorage.removeItem(SESSION_KEY);
}

function showSignedOut(message = '') {
  elements.authPanel.hidden = false;
  elements.userPanel.hidden = true;
  elements.dashboard.hidden = true;
  elements.logoutButton.hidden = true;
  elements.refreshButton.hidden = true;
  elements.sheetLink.hidden = true;
  if (message) elements.oauthMessage.textContent = message;
}

function showSignedIn(user) {
  currentUser = user;
  const isAdmin = user.role === 'admin';
  elements.authPanel.hidden = true;
  elements.userPanel.hidden = false;
  elements.dashboard.hidden = false;
  elements.logoutButton.hidden = false;
  elements.refreshButton.hidden = false;
  elements.userName.textContent = user.name || 'Google user';
  elements.userEmail.textContent = user.email || '';
  elements.groupName.textContent = `${user.groupName || 'Community activity'} · ${isAdmin ? 'Organizer' : 'Participant'}`;
  elements.userPicture.src = user.picture || '';
  elements.userPicture.hidden = !user.picture;
  elements.sheetLink.href = user.spreadsheetUrl || '#';
  elements.sheetLink.hidden = !isAdmin || !user.spreadsheetUrl;
  elements.adminPanel.hidden = !isAdmin;
  elements.projectAdminPanel.hidden = !isAdmin;
}

function setStatus(label, isError = false) {
  elements.statusBadge.textContent = label;
  elements.statusBadge.classList.toggle('error', isError);
}

function setMessage(element, message, isError = false) {
  element.textContent = message;
  element.classList.toggle('error', isError);
}

async function initialize() {
  captureOAuthResult();
  setupPwa();
  if (!session) return showSignedOut();
  try {
    const user = await request('/api/me');
    showSignedIn(user);
    await loadDashboard();
  } catch (error) {
    console.error(error);
    showSignedOut('Your session could not be restored. Sign in again.');
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
  currentProjects = Array.isArray(data.projects) ? data.projects : [];
  const totalSteps = members.reduce((sum, member) => sum + Number(member.steps || 0), 0);
  const totalGoal = members.reduce((sum, member) => sum + Number(member.goal || 0), 0);
  const reached = members.filter(member => Number(member.steps || 0) >= Number(member.goal || 0)).length;
  elements.familySteps.textContent = numberFormatter.format(totalSteps);
  elements.familyGoalProgress.textContent = totalGoal ? `${Math.round((totalSteps / totalGoal) * 100)}% of the combined daily goal` : 'No community goal configured';
  elements.activeMembers.textContent = numberFormatter.format(members.length);
  elements.goalsReached.textContent = `${reached}/${members.length}`;
  elements.projectCount.textContent = numberFormatter.format(currentProjects.length);
  renderMembers(members);
  renderProjects(currentProjects);
  renderProjectOptions(currentProjects);
  renderTrend(Array.isArray(data.trend) ? data.trend : []);

  if (currentUser) {
    const mine = members.find(member => String(member.memberId || '').toLowerCase() === String(currentUser.email || '').toLowerCase());
    if (mine && !elements.quickSteps.value) elements.quickSteps.placeholder = String(mine.steps || '8426');
  }
}

function renderProjects(projects) {
  elements.projectGrid.innerHTML = '';
  projects.forEach(project => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'project-card project-button';
    card.dataset.projectId = project.projectId;
    card.innerHTML = `<p class="eyebrow">${escapeHtml(project.type || 'general')}</p><h3>${escapeHtml(project.name || 'Untitled activity')}</h3><p class="member-meta">Tracking page: ${escapeHtml(project.sheetTitle || '—')}</p><p class="member-meta">Created by ${escapeHtml(project.createdBy || 'organizer')}</p>`;
    card.addEventListener('click', () => selectProject(project.projectId));
    elements.projectGrid.appendChild(card);
  });
  if (!projects.length) elements.projectGrid.innerHTML = '<p class="empty-state">No additional activities created yet.</p>';
}

function renderProjectOptions(projects) {
  const selected = elements.progressProject.value;
  elements.progressProject.innerHTML = '<option value="">Select an activity</option>' + projects.map(project => `<option value="${escapeHtml(project.projectId)}">${escapeHtml(project.name)}</option>`).join('');
  if (projects.some(project => project.projectId === selected)) elements.progressProject.value = selected;
}

async function selectProject(projectId) {
  elements.progressProject.value = projectId;
  const project = currentProjects.find(item => item.projectId === projectId);
  elements.entriesTitle.textContent = project?.name || 'Activity updates';
  elements.entriesTable.innerHTML = '<p class="empty-state">Loading updates…</p>';
  try {
    const data = await request(`/api/projects/${encodeURIComponent(projectId)}/entries`);
    renderEntries(data.entries || []);
  } catch (error) {
    elements.entriesTable.innerHTML = `<p class="form-message error">${escapeHtml(error.message)}</p>`;
  }
}

function renderEntries(entries) {
  if (!entries.length) {
    elements.entriesTable.innerHTML = '<p class="empty-state">No progress updates yet.</p>';
    return;
  }
  const rows = entries.slice(-20).reverse().map(entry => `<tr><td>${escapeHtml(entry.date || '—')}</td><td>${escapeHtml(entry.memberEmail || '—')}</td><td>${numberFormatter.format(Number(entry.value || 0))}</td><td>${escapeHtml(entry.notes || '')}</td></tr>`).join('');
  elements.entriesTable.innerHTML = `<table><thead><tr><th>Date</th><th>Participant</th><th>Value</th><th>Notes</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderMembers(members) {
  elements.memberGrid.innerHTML = '';
  elements.emptyState.hidden = members.length > 0;
  [...members].sort((a, b) => Number(b.steps || 0) - Number(a.steps || 0)).forEach((member, index) => {
    const steps = Number(member.steps || 0);
    const goal = Number(member.goal || 0);
    const percent = goal ? Math.min(100, Math.round((steps / goal) * 100)) : 0;
    const card = document.createElement('article');
    card.className = 'member-card';
    card.innerHTML = `<div class="member-row"><h3><span class="rank">#${index + 1}</span> ${escapeHtml(member.name || member.memberId || 'Participant')}</h3><span class="member-meta">${percent}%</span></div><div class="member-steps">${numberFormatter.format(steps)}</div><div class="progress-track"><div class="progress-bar" style="width:${percent}%"></div></div><p class="member-meta">Goal ${numberFormatter.format(goal)} · updated ${formatTime(member.syncedAt)}</p>`;
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

async function submitForm(form, messageElement, action, success = 'Saved successfully.') {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  setMessage(messageElement, 'Saving…');
  try {
    const result = await action();
    setMessage(messageElement, success);
    await loadDashboard();
    return result;
  } catch (error) {
    console.error(error);
    setMessage(messageElement, error.message, true);
    throw error;
  } finally {
    button.disabled = false;
  }
}

function parseEmails(value) {
  return [...new Set(String(value || '').split(/[\s,;]+/).map(item => item.trim().toLowerCase()).filter(Boolean))];
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function updateNetworkStatus() {
  if (!elements.networkStatus) return;
  const online = navigator.onLine;
  elements.networkStatus.textContent = online ? 'Online' : 'Offline';
  elements.networkStatus.classList.toggle('error', !online);
}

function setupPwa() {
  updateNetworkStatus();
  window.addEventListener('online', updateNetworkStatus);
  window.addEventListener('offline', updateNetworkStatus);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/service-worker.js').catch(error => console.warn('Service worker registration failed', error));
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    if (elements.installButton) elements.installButton.hidden = false;
  });
  if (elements.installButton) elements.installButton.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    elements.installButton.hidden = true;
  });
}

elements.loginButton.addEventListener('click', () => { location.href = api('/auth/google'); });
elements.logoutButton.addEventListener('click', () => { clearSession(); showSignedOut(); });
elements.refreshButton.addEventListener('click', loadDashboard);
elements.progressProject.addEventListener('change', () => { if (elements.progressProject.value) selectProject(elements.progressProject.value); });

elements.quickStepsForm.addEventListener('submit', event => {
  event.preventDefault();
  const steps = Number(elements.quickSteps.value);
  const date = elements.quickStepsDate.value;
  if (!Number.isInteger(steps) || steps < 0 || steps > 200000) return setMessage(elements.quickStepsMessage, 'Enter a valid step count from 0 to 200,000.', true);
  const eventId = `community:${String(currentUser?.email || 'member').toLowerCase()}:${date}:${steps}`.slice(0, 100);
  submitForm(elements.quickStepsForm, elements.quickStepsMessage, () => request('/api/steps', {
    method: 'POST',
    body: JSON.stringify({ eventId, date, steps, source: 'community-web' })
  }), `Updated to ${numberFormatter.format(steps)} steps.`).then(() => {
    elements.quickSteps.value = '';
  }).catch(() => {});
});

elements.memberForm.addEventListener('submit', async event => {
  event.preventDefault();
  const emails = parseEmails(elements.memberEmail.value);
  const invalid = emails.filter(email => !isValidEmail(email));
  if (!emails.length) return setMessage(elements.memberMessage, 'Add at least one Google email address.', true);
  if (invalid.length) return setMessage(elements.memberMessage, `Check these email addresses: ${invalid.join(', ')}`, true);

  const button = elements.memberForm.querySelector('button[type="submit"]');
  const dailyGoal = Number(elements.memberGoal.value);
  button.disabled = true;
  let added = 0;
  const failures = [];
  try {
    for (const [index, email] of emails.entries()) {
      setMessage(elements.memberMessage, `Adding ${index + 1} of ${emails.length}: ${email}`);
      try {
        await request('/api/group/members', { method: 'POST', body: JSON.stringify({ email, dailyGoal }) });
        added += 1;
      } catch (error) {
        failures.push(`${email}: ${error.message}`);
      }
    }
    if (failures.length) setMessage(elements.memberMessage, `Added ${added}. ${failures.length} failed: ${failures.join(' | ')}`, true);
    else {
      setMessage(elements.memberMessage, `${added} participant${added === 1 ? '' : 's'} added. You can now send them the participation instructions.`);
      elements.memberEmail.value = '';
    }
    await loadDashboard();
  } finally {
    button.disabled = false;
  }
});

elements.copyInstructionsButton.addEventListener('click', async () => {
  const text = `You're invited to our community activity on Track Everything.\n\n1. Open ${location.origin}/\n2. Sign in with the Google email address I registered for you.\n3. Check today's steps on your phone/watch.\n4. Enter the total under “Today's Update” and tap “Update my steps.”\n\nYou can update the number again later in the day.`;
  try {
    await navigator.clipboard.writeText(text);
    elements.copyInstructionsButton.textContent = 'Instructions copied';
    setTimeout(() => { elements.copyInstructionsButton.textContent = 'Copy participant instructions'; }, 2000);
  } catch (_) {
    window.prompt('Copy these participant instructions:', text);
  }
});

elements.projectForm.addEventListener('submit', event => {
  event.preventDefault();
  submitForm(elements.projectForm, elements.projectMessage, () => request('/api/projects', { method: 'POST', body: JSON.stringify({ name: elements.projectName.value, type: elements.projectType.value }) }), 'Activity created.').then(result => {
    elements.projectName.value = '';
    selectProject(result.projectId);
  }).catch(() => {});
});

elements.progressForm.addEventListener('submit', event => {
  event.preventDefault();
  const projectId = elements.progressProject.value;
  if (!projectId) return setMessage(elements.progressMessage, 'Select an activity first.', true);
  submitForm(elements.progressForm, elements.progressMessage, () => request(`/api/projects/${encodeURIComponent(projectId)}/entries`, { method: 'POST', body: JSON.stringify({ value: Number(elements.progressValue.value), date: elements.progressDate.value, notes: elements.progressNotes.value }) }), 'Progress saved.').then(() => {
    elements.progressValue.value = '';
    elements.progressNotes.value = '';
    selectProject(projectId);
  }).catch(() => {});
});

initialize();