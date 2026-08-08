const config = window.TRACK_EVERYTHING_CONFIG || {};
const SESSION_KEY = 'trackEverythingSession';
const SHARECAPSULE_TASK_API = 'https://api.sharecapsule.app/api/v1/global-activities';
const TASK_PROJECT_NAME = 'Daily Checklist';
const TASK_DEF_PREFIX = 'TE_TASK_DEF:';
const TASK_STATE_PREFIX = 'TE_TASK_STATE:';

let session = sessionStorage.getItem(SESSION_KEY) || '';
let currentUser = null;
let currentProjects = [];
let currentMembers = [];
let taskEntries = [];

const $ = selector => document.querySelector(selector);
const elements = {
  authPanel: $('#authPanel'), userPanel: $('#userPanel'), dashboard: $('#dashboard'), loginButton: $('#loginButton'), logoutButton: $('#logoutButton'), refreshButton: $('#refreshButton'), sheetLink: $('#sheetLink'), oauthMessage: $('#oauthMessage'),
  userPicture: $('#userPicture'), userName: $('#userName'), userEmail: $('#userEmail'), groupName: $('#groupName'), adminPanel: $('#adminPanel'), projectAdminPanel: $('#projectAdminPanel'), taskAdminPanel: $('#taskAdminPanel'),
  familySteps: $('#familySteps'), familyGoalProgress: $('#familyGoalProgress'), activeMembers: $('#activeMembers'), goalsReached: $('#goalsReached'), projectCount: $('#projectCount'),
  statusBadge: $('#statusBadge'), memberGrid: $('#memberGrid'), emptyState: $('#emptyState'), trendChart: $('#trendChart'), projectGrid: $('#projectGrid'),
  memberForm: $('#memberForm'), memberEmail: $('#memberEmail'), memberGoal: $('#memberGoal'), memberMessage: $('#memberMessage'), copyInstructionsButton: $('#copyInstructionsButton'),
  quickStepsForm: $('#quickStepsForm'), quickSteps: $('#quickSteps'), quickStepsDate: $('#quickStepsDate'), quickStepsMessage: $('#quickStepsMessage'),
  projectForm: $('#projectForm'), projectName: $('#projectName'), projectType: $('#projectType'), projectMessage: $('#projectMessage'),
  progressForm: $('#progressForm'), progressProject: $('#progressProject'), progressValue: $('#progressValue'), progressDate: $('#progressDate'), progressNotes: $('#progressNotes'), progressMessage: $('#progressMessage'), entriesTitle: $('#entriesTitle'), entriesTable: $('#entriesTable'),
  taskDate: $('#taskDate'), taskProgressBadge: $('#taskProgressBadge'), dailyTaskList: $('#dailyTaskList'), taskMessage: $('#taskMessage'), taskMemberGrid: $('#taskMemberGrid'),
  taskTemplateForm: $('#taskTemplateForm'), taskTemplateSelect: $('#taskTemplateSelect'), taskStartDate: $('#taskStartDate'), taskAssignmentMode: $('#taskAssignmentMode'), taskAssigneeList: $('#taskAssigneeList'), taskTemplateMessage: $('#taskTemplateMessage'),
  customTaskForm: $('#customTaskForm'), customTaskTitle: $('#customTaskTitle'), customTaskPriority: $('#customTaskPriority'), customTaskMessage: $('#customTaskMessage')
};

const numberFormatter = new Intl.NumberFormat();
const today = localDateString();
elements.progressDate.value = today;
elements.quickStepsDate.value = today;
elements.taskDate.value = today;
elements.taskStartDate.value = today;

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
  currentMembers = [];
  taskEntries = [];
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
  elements.taskAdminPanel.hidden = !isAdmin;
}

function setStatus(label, isError = false) {
  elements.statusBadge.textContent = label;
  elements.statusBadge.classList.toggle('error', isError);
}

function setMessage(element, message, isError = false) {
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('error', isError);
}

async function initialize() {
  captureOAuthResult();
  if (!session) return showSignedOut();
  try {
    const user = await request('/api/me');
    showSignedIn(user);
    await refreshAll();
    if (user.role === 'admin') await loadTaskTemplates();
  } catch (error) {
    console.error(error);
    showSignedOut('Your session could not be restored. Sign in again.');
  }
}

async function refreshAll() {
  await loadDashboard();
  await loadCommunityMembers();
  await loadDailyTasks(elements.taskDate.value || today);
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
    throw error;
  } finally {
    elements.refreshButton.disabled = false;
  }
}

function renderDashboard(data) {
  const members = Array.isArray(data.members) ? data.members : [];
  currentProjects = Array.isArray(data.projects) ? data.projects : [];
  const visibleProjects = currentProjects.filter(project => !isTaskProject(project));
  const totalSteps = members.reduce((sum, member) => sum + Number(member.steps || 0), 0);
  const totalGoal = members.reduce((sum, member) => sum + Number(member.goal || 0), 0);
  const reached = members.filter(member => Number(member.steps || 0) >= Number(member.goal || 0)).length;
  elements.familySteps.textContent = numberFormatter.format(totalSteps);
  elements.familyGoalProgress.textContent = totalGoal ? `${Math.round((totalSteps / totalGoal) * 100)}% of the combined daily goal` : 'No community goal configured';
  elements.activeMembers.textContent = numberFormatter.format(members.length);
  elements.goalsReached.textContent = `${reached}/${members.length}`;
  elements.projectCount.textContent = numberFormatter.format(visibleProjects.length);
  renderMembers(members);
  renderProjects(visibleProjects);
  renderProjectOptions(visibleProjects);
  renderTrend(Array.isArray(data.trend) ? data.trend : []);

  if (currentUser) {
    const mine = members.find(member => String(member.memberId || '').toLowerCase() === String(currentUser.email || '').toLowerCase());
    if (mine && !elements.quickSteps.value) elements.quickSteps.placeholder = String(mine.steps || '8426');
  }
}

async function loadCommunityMembers() {
  try {
    const members = await request('/api/group/members');
    currentMembers = Array.isArray(members) ? members : [];
    if (currentUser?.role === 'admin') renderTaskAssignees();
  } catch (error) {
    console.error('Unable to load group members', error);
    currentMembers = [];
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

function isTaskProject(project) {
  return String(project?.name || '').trim().toLowerCase() === TASK_PROJECT_NAME.toLowerCase();
}

function getTaskProject() {
  return currentProjects.find(isTaskProject) || null;
}

async function ensureTaskProject() {
  const existing = getTaskProject();
  if (existing) return existing;
  if (currentUser?.role !== 'admin') throw new Error('The organizer has not set up the daily checklist yet.');
  const created = await request('/api/projects', { method: 'POST', body: JSON.stringify({ name: TASK_PROJECT_NAME, type: 'count' }) });
  currentProjects.push(created);
  return created;
}

async function fetchTaskEntries() {
  const project = getTaskProject();
  if (!project) {
    taskEntries = [];
    return [];
  }
  const data = await request(`/api/projects/${encodeURIComponent(project.projectId)}/entries`);
  taskEntries = Array.isArray(data.entries) ? data.entries : [];
  return taskEntries;
}

function encodeTaskNote(prefix, data) {
  const value = prefix + JSON.stringify(data);
  if (value.length > 500) throw new Error('Task assignment is too large. Assign fewer participants at a time.');
  return value;
}

function parseTaskNote(note, prefix) {
  const value = String(note || '');
  if (!value.startsWith(prefix)) return null;
  try { return JSON.parse(value.slice(prefix.length)); } catch { return null; }
}

function stableTaskId(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `task-${(hash >>> 0).toString(36)}`;
}

function parseTaskDefinitions(entries, date) {
  const byId = new Map();
  entries.forEach(entry => {
    const def = parseTaskNote(entry.notes, TASK_DEF_PREFIX);
    if (!def?.i || !def?.t || !def?.d || def.d > date) return;
    const existing = byId.get(def.i) || { id: def.i, title: def.t, priority: def.p || 'medium', source: def.s || 'Community activity', startDate: def.d, assignees: new Set() };
    (Array.isArray(def.a) ? def.a : ['*']).forEach(email => existing.assignees.add(String(email).toLowerCase()));
    byId.set(def.i, existing);
  });
  return [...byId.values()].map(task => ({ ...task, assignees: [...task.assignees] })).sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.title.localeCompare(b.title));
}

function buildTaskState(entries, date) {
  const state = new Map();
  entries.forEach(entry => {
    if (entry.date !== date) return;
    const payload = parseTaskNote(entry.notes, TASK_STATE_PREFIX);
    if (!payload?.i || !entry.memberEmail) return;
    state.set(`${String(entry.memberEmail).toLowerCase()}::${payload.i}`, Number(entry.value || 0) > 0);
  });
  return state;
}

function taskAssignedTo(task, email) {
  const normalized = String(email || '').toLowerCase();
  return task.assignees.includes('*') || task.assignees.includes(normalized);
}

async function loadDailyTasks(date) {
  const project = getTaskProject();
  if (!project) {
    taskEntries = [];
    renderDailyTasks([], new Map(), date);
    renderTaskMemberSummary([], new Map());
    return;
  }
  try {
    const entries = await fetchTaskEntries();
    const definitions = parseTaskDefinitions(entries, date);
    const states = buildTaskState(entries, date);
    renderDailyTasks(definitions, states, date);
    renderTaskMemberSummary(definitions, states);
  } catch (error) {
    console.error(error);
    elements.dailyTaskList.innerHTML = `<p class="form-message error">${escapeHtml(error.message)}</p>`;
  }
}

function renderDailyTasks(definitions, states, date) {
  const email = String(currentUser?.email || '').toLowerCase();
  const mine = definitions.filter(task => taskAssignedTo(task, email));
  const completed = mine.filter(task => states.get(`${email}::${task.id}`) === true).length;
  elements.taskProgressBadge.textContent = `${completed}/${mine.length} complete${mine.length ? ` · ${Math.round((completed / mine.length) * 100)}%` : ''}`;
  elements.taskProgressBadge.classList.toggle('complete', mine.length > 0 && completed === mine.length);
  elements.dailyTaskList.innerHTML = '';

  if (!mine.length) {
    elements.dailyTaskList.innerHTML = `<p class="empty-state">${currentUser?.role === 'admin' ? 'No daily tasks are assigned for this date. Import a ShareCapsule checklist below.' : 'No tasks have been assigned to you for this date.'}</p>`;
    return;
  }

  mine.forEach(task => {
    const isComplete = states.get(`${email}::${task.id}`) === true;
    const row = document.createElement('label');
    row.className = `daily-task priority-${escapeHtml(task.priority)} ${isComplete ? 'done' : ''}`;
    row.innerHTML = `<input type="checkbox" ${isComplete ? 'checked' : ''}><span class="task-checkmark">✓</span><span class="daily-task-copy"><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(task.source)} · ${escapeHtml(task.priority)} priority</small></span>`;
    const checkbox = row.querySelector('input');
    checkbox.addEventListener('change', async () => {
      checkbox.disabled = true;
      try {
        await setTaskCompletion(task.id, checkbox.checked, date);
        setMessage(elements.taskMessage, checkbox.checked ? 'Task completed.' : 'Task marked incomplete.');
        await loadDailyTasks(date);
      } catch (error) {
        checkbox.checked = !checkbox.checked;
        setMessage(elements.taskMessage, error.message, true);
      } finally { checkbox.disabled = false; }
    });
    elements.dailyTaskList.appendChild(row);
  });
}

function renderTaskMemberSummary(definitions, states) {
  elements.taskMemberGrid.innerHTML = '';
  if (!currentMembers.length || !definitions.length) {
    elements.taskMemberGrid.innerHTML = '<p class="empty-state">Group task completion will appear after the organizer assigns a checklist.</p>';
    return;
  }
  const summaries = currentMembers.map(member => {
    const email = String(member.email || member.id || '').toLowerCase();
    const assigned = definitions.filter(task => taskAssignedTo(task, email));
    const completed = assigned.filter(task => states.get(`${email}::${task.id}`) === true).length;
    return { name: member.name || member.email || member.id, email, total: assigned.length, completed, percent: assigned.length ? Math.round((completed / assigned.length) * 100) : 0 };
  }).sort((a, b) => b.percent - a.percent || a.name.localeCompare(b.name));

  summaries.forEach(summary => {
    const card = document.createElement('article');
    card.className = 'task-member-card';
    card.innerHTML = `<div class="member-row"><h3>${escapeHtml(summary.name)}</h3><strong>${summary.percent}%</strong></div><div class="progress-track"><div class="progress-bar" style="width:${summary.percent}%"></div></div><p class="member-meta">${summary.completed} of ${summary.total} tasks complete</p>`;
    elements.taskMemberGrid.appendChild(card);
  });
}

async function setTaskCompletion(taskId, completed, date) {
  const project = getTaskProject();
  if (!project) throw new Error('Daily checklist is not configured.');
  await request(`/api/projects/${encodeURIComponent(project.projectId)}/entries`, {
    method: 'POST',
    body: JSON.stringify({ value: completed ? 1 : 0, date, notes: encodeTaskNote(TASK_STATE_PREFIX, { i: taskId }) })
  });
}

async function loadTaskTemplates() {
  try {
    const response = await fetch(SHARECAPSULE_TASK_API, { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`ShareCapsule returned ${response.status}`);
    const body = await response.json();
    const boards = Array.isArray(body.items) ? body.items : [];
    elements.taskTemplateSelect.innerHTML = '<option value="">Choose a checklist</option>' + boards.map(board => `<option value="${escapeHtml(board.id)}">${escapeHtml(board.title)}${board.task_count ? ` · ${numberFormatter.format(board.task_count)} tasks` : ''}</option>`).join('');
    if (!boards.length) elements.taskTemplateSelect.innerHTML = '<option value="">No templates available</option>';
  } catch (error) {
    console.error(error);
    elements.taskTemplateSelect.innerHTML = '<option value="">Unable to load ShareCapsule templates</option>';
    setMessage(elements.taskTemplateMessage, 'Could not load the ShareCapsule checklist library. You can still add custom tasks.', true);
  }
}

function renderTaskAssignees() {
  if (!elements.taskAssigneeList) return;
  const members = currentMembers.filter(member => String(member.status || 'active') !== 'disabled');
  elements.taskAssigneeList.innerHTML = members.map(member => {
    const email = String(member.email || member.id || '').toLowerCase();
    return `<label class="assignee-chip"><input type="checkbox" value="${escapeHtml(email)}" checked><span>${escapeHtml(member.name || email)}</span></label>`;
  }).join('');
}

function selectedTaskAssignees() {
  if (elements.taskAssignmentMode.value === 'all') return ['*'];
  return [...elements.taskAssigneeList.querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value);
}

async function importTemplateTasks(templateId, startDate, assignees) {
  const response = await fetch(`${SHARECAPSULE_TASK_API}/${encodeURIComponent(templateId)}`, { cache: 'no-store', headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Unable to load checklist (${response.status})`);
  const board = await response.json();
  const tasks = Array.isArray(board.tasks) ? board.tasks.filter(task => String(task?.title || '').trim()) : [];
  if (!tasks.length) throw new Error('This checklist does not contain any tasks.');
  const project = await ensureTaskProject();
  await fetchTaskEntries();
  const existingDefs = taskEntries.map(entry => parseTaskNote(entry.notes, TASK_DEF_PREFIX)).filter(Boolean);
  let created = 0;
  let skipped = 0;

  for (const sourceTask of tasks) {
    const title = String(sourceTask.title || '').trim().slice(0, 180);
    const taskId = stableTaskId(`${board.id || templateId}|${title}|${startDate}`);
    for (const assignee of assignees) {
      const duplicate = existingDefs.some(def => def.i === taskId && def.d === startDate && Array.isArray(def.a) && def.a.includes(assignee));
      if (duplicate) { skipped += 1; continue; }
      const note = encodeTaskNote(TASK_DEF_PREFIX, { i: taskId, t: title, p: normalizePriority(sourceTask.priority), s: String(board.title || 'ShareCapsule checklist').slice(0, 100), a: [assignee], d: startDate });
      await request(`/api/projects/${encodeURIComponent(project.projectId)}/entries`, { method: 'POST', body: JSON.stringify({ value: 0, date: startDate, notes: note }) });
      existingDefs.push(parseTaskNote(note, TASK_DEF_PREFIX));
      created += 1;
    }
  }
  return { created, skipped, taskCount: tasks.length, boardTitle: board.title || 'Checklist' };
}

async function addCustomTask(title, priority, startDate, assignees) {
  const project = await ensureTaskProject();
  const taskId = stableTaskId(`custom|${title}|${startDate}`);
  let created = 0;
  for (const assignee of assignees) {
    const note = encodeTaskNote(TASK_DEF_PREFIX, { i: taskId, t: title, p: normalizePriority(priority), s: 'Community activity', a: [assignee], d: startDate });
    await request(`/api/projects/${encodeURIComponent(project.projectId)}/entries`, { method: 'POST', body: JSON.stringify({ value: 0, date: startDate, notes: note }) });
    created += 1;
  }
  return created;
}

function normalizePriority(value) {
  const priority = String(value || 'medium').toLowerCase();
  return ['high', 'medium', 'low', 'none'].includes(priority) ? priority : 'medium';
}

function priorityRank(value) { return { high: 0, medium: 1, low: 2, none: 3 }[normalizePriority(value)] ?? 3; }

async function submitForm(form, messageElement, action, success = 'Saved successfully.', refresh = true) {
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  setMessage(messageElement, 'Saving…');
  try {
    const result = await action();
    setMessage(messageElement, success);
    if (refresh) await refreshAll();
    return result;
  } catch (error) {
    console.error(error);
    setMessage(messageElement, error.message, true);
    throw error;
  } finally { button.disabled = false; }
}

function parseEmails(value) {
  return [...new Set(String(value || '').split(/[\s,;]+/).map(item => item.trim().toLowerCase()).filter(Boolean))];
}

function isValidEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function formatTime(value) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function escapeHtml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;'); }

elements.loginButton.addEventListener('click', () => { location.href = api('/auth/google'); });
elements.logoutButton.addEventListener('click', () => { clearSession(); showSignedOut(); });
elements.refreshButton.addEventListener('click', refreshAll);
elements.progressProject.addEventListener('change', () => { if (elements.progressProject.value) selectProject(elements.progressProject.value); });
elements.taskDate.addEventListener('change', () => loadDailyTasks(elements.taskDate.value));
elements.taskAssignmentMode.addEventListener('change', () => { elements.taskAssigneeList.hidden = elements.taskAssignmentMode.value !== 'selected'; });

elements.quickStepsForm.addEventListener('submit', event => {
  event.preventDefault();
  const steps = Number(elements.quickSteps.value);
  const date = elements.quickStepsDate.value;
  if (!Number.isInteger(steps) || steps < 0 || steps > 200000) return setMessage(elements.quickStepsMessage, 'Enter a valid step count from 0 to 200,000.', true);
  const eventId = `community:${String(currentUser?.email || 'member').toLowerCase()}:${date}:${steps}`.slice(0, 100);
  submitForm(elements.quickStepsForm, elements.quickStepsMessage, () => request('/api/steps', { method: 'POST', body: JSON.stringify({ eventId, date, steps, source: 'community-web' }) }), `Updated to ${numberFormatter.format(steps)} steps.`).then(() => { elements.quickSteps.value = ''; }).catch(() => {});
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
      try { await request('/api/group/members', { method: 'POST', body: JSON.stringify({ email, dailyGoal }) }); added += 1; }
      catch (error) { failures.push(`${email}: ${error.message}`); }
    }
    if (failures.length) setMessage(elements.memberMessage, `Added ${added}. ${failures.length} failed: ${failures.join(' | ')}`, true);
    else { setMessage(elements.memberMessage, `${added} participant${added === 1 ? '' : 's'} added. You can now assign tasks and send the participation instructions.`); elements.memberEmail.value = ''; }
    await refreshAll();
  } finally { button.disabled = false; }
});

elements.copyInstructionsButton.addEventListener('click', async () => {
  const text = `You're invited to our community activity on Track Everything.\n\n1. Open ${location.origin}/\n2. Sign in with the Google email address I registered for you.\n3. Complete the tasks under “Daily Checklist” and check them off as you finish.\n4. Check today's steps on your phone/watch and update the total under “Today's Steps.”\n\nYour checklist completion is tracked separately for each day.`;
  try {
    await navigator.clipboard.writeText(text);
    elements.copyInstructionsButton.textContent = 'Instructions copied';
    setTimeout(() => { elements.copyInstructionsButton.textContent = 'Copy participant instructions'; }, 2000);
  } catch (_) { window.prompt('Copy these participant instructions:', text); }
});

elements.taskTemplateForm.addEventListener('submit', async event => {
  event.preventDefault();
  const templateId = elements.taskTemplateSelect.value;
  const startDate = elements.taskStartDate.value || today;
  const assignees = selectedTaskAssignees();
  if (!templateId) return setMessage(elements.taskTemplateMessage, 'Choose a ShareCapsule checklist first.', true);
  if (!assignees.length) return setMessage(elements.taskTemplateMessage, 'Select at least one participant.', true);
  const button = elements.taskTemplateForm.querySelector('button[type="submit"]');
  button.disabled = true;
  setMessage(elements.taskTemplateMessage, 'Importing checklist tasks…');
  try {
    const result = await importTemplateTasks(templateId, startDate, assignees);
    setMessage(elements.taskTemplateMessage, `${result.boardTitle}: ${result.created} assignment${result.created === 1 ? '' : 's'} added${result.skipped ? `, ${result.skipped} existing assignment${result.skipped === 1 ? '' : 's'} skipped` : ''}.`);
    await loadDashboard();
    await loadDailyTasks(elements.taskDate.value || today);
  } catch (error) {
    console.error(error);
    setMessage(elements.taskTemplateMessage, error.message, true);
  } finally { button.disabled = false; }
});

elements.customTaskForm.addEventListener('submit', async event => {
  event.preventDefault();
  const title = String(elements.customTaskTitle.value || '').trim();
  const assignees = selectedTaskAssignees();
  if (!title) return setMessage(elements.customTaskMessage, 'Enter a task title.', true);
  if (!assignees.length) return setMessage(elements.customTaskMessage, 'Select at least one participant.', true);
  const button = elements.customTaskForm.querySelector('button[type="submit"]');
  button.disabled = true;
  setMessage(elements.customTaskMessage, 'Adding task…');
  try {
    const created = await addCustomTask(title, elements.customTaskPriority.value, elements.taskStartDate.value || today, assignees);
    setMessage(elements.customTaskMessage, `Task assigned (${created} assignment${created === 1 ? '' : 's'}).`);
    elements.customTaskTitle.value = '';
    await loadDashboard();
    await loadDailyTasks(elements.taskDate.value || today);
  } catch (error) {
    console.error(error);
    setMessage(elements.customTaskMessage, error.message, true);
  } finally { button.disabled = false; }
});

elements.projectForm.addEventListener('submit', event => {
  event.preventDefault();
  submitForm(elements.projectForm, elements.projectMessage, () => request('/api/projects', { method: 'POST', body: JSON.stringify({ name: elements.projectName.value, type: elements.projectType.value }) }), 'Activity created.').then(result => { elements.projectName.value = ''; selectProject(result.projectId); }).catch(() => {});
});

elements.progressForm.addEventListener('submit', event => {
  event.preventDefault();
  const projectId = elements.progressProject.value;
  if (!projectId) return setMessage(elements.progressMessage, 'Select an activity first.', true);
  submitForm(elements.progressForm, elements.progressMessage, () => request(`/api/projects/${encodeURIComponent(projectId)}/entries`, { method: 'POST', body: JSON.stringify({ value: Number(elements.progressValue.value), date: elements.progressDate.value, notes: elements.progressNotes.value }) }), 'Progress saved.').then(() => { elements.progressValue.value = ''; elements.progressNotes.value = ''; selectProject(projectId); }).catch(() => {});
});

initialize();