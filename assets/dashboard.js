const config = window.TRACK_EVERYTHING_CONFIG || {};
const SESSION_KEY = 'trackEverythingSession';
const TASK_PROJECT_NAME = 'Daily Checklist';
const TASK_DEF_PREFIX = 'TE_TASK_DEF:';
const TASK_STATE_PREFIX = 'TE_TASK_STATE:';
const PROFILE_PREFIX = 'TE_MEMBER_PROFILE:';
const GROUP_META_PREFIX = 'TE_GROUP_META:';

const $ = selector => document.querySelector(selector);
const elements = {
  authRequired: $('#dashboardAuthRequired'), dashboard: $('#groupDashboard'), groupName: $('#dashboardGroupName'), refresh: $('#dashboardRefresh'), date: $('#dashboardDate'), status: $('#dashboardStatus'),
  percent: $('#groupCompletionPercent'), detail: $('#groupCompletionDetail'), champions: $('#championCount'), completed: $('#completedActivityCount'), members: $('#dashboardMemberCount'), progressBar: $('#groupProgressBar'), grid: $('#championGrid'), empty: $('#dashboardEmpty')
};

let currentUser = null;
let members = [];
let entries = [];

function localDateString() {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

elements.date.value = localDateString();

function api(path) {
  if (!config.apiUrl) throw new Error('Backend API URL is not configured');
  return `${String(config.apiUrl).replace(/\/$/, '')}${path}`;
}

async function request(path) {
  const session = sessionStorage.getItem(SESSION_KEY) || '';
  if (!session) throw Object.assign(new Error('Authentication required'), { status: 401 });
  const response = await fetch(api(path), { headers: { Authorization: `Bearer ${session}` }, cache: 'no-store' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw Object.assign(new Error(payload.error || `Request failed (${response.status})`), { status: response.status });
  return payload.data;
}

function parseNote(note, prefix) {
  const value = String(note || '');
  if (!value.startsWith(prefix)) return null;
  try { return JSON.parse(value.slice(prefix.length)); } catch { return null; }
}

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function initials(name, email) {
  const source = String(name || email || '?').trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length > 1) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

function priorityRank(value) { return { high: 0, medium: 1, low: 2, none: 3 }[String(value || 'medium').toLowerCase()] ?? 3; }

function taskAssignedTo(task, email) {
  const normalized = String(email || '').toLowerCase();
  return task.assignees.includes('*') || task.assignees.includes(normalized);
}

function parseDefinitions(date) {
  const byId = new Map();
  entries.forEach(entry => {
    const def = parseNote(entry.notes, TASK_DEF_PREFIX);
    if (!def?.i || !def?.t || !def?.d || def.d > date) return;
    const existing = byId.get(def.i) || { id: def.i, title: def.t, priority: def.p || 'medium', source: def.s || 'Community activity', startDate: def.d, assignees: new Set() };
    (Array.isArray(def.a) ? def.a : ['*']).forEach(email => existing.assignees.add(String(email).toLowerCase()));
    byId.set(def.i, existing);
  });
  return [...byId.values()].map(task => ({ ...task, assignees: [...task.assignees] })).sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.title.localeCompare(b.title));
}

function parseStates(date) {
  const state = new Map();
  entries.forEach(entry => {
    if (String(entry.date || '') !== date) return;
    const payload = parseNote(entry.notes, TASK_STATE_PREFIX);
    if (!payload?.i || !entry.memberEmail) return;
    state.set(`${String(entry.memberEmail).toLowerCase()}::${payload.i}`, Number(entry.value || 0) > 0);
  });
  return state;
}

function parseProfiles() {
  const profiles = new Map();
  entries.forEach(entry => {
    const profile = parseNote(entry.notes, PROFILE_PREFIX);
    const email = String(profile?.e || '').toLowerCase();
    if (!email) return;
    profiles.set(email, { email, name: profile.n || email, picture: profile.p || '' });
  });
  if (currentUser?.email) {
    const email = String(currentUser.email).toLowerCase();
    const existing = profiles.get(email) || {};
    profiles.set(email, { email, name: currentUser.name || existing.name || email, picture: currentUser.picture || existing.picture || '' });
  }
  return profiles;
}

function parseGroupName() {
  let latest = null;
  entries.forEach(entry => {
    const meta = parseNote(entry.notes, GROUP_META_PREFIX);
    if (!meta?.n) return;
    latest = meta.n;
  });
  return latest;
}

function render(date) {
  const definitions = parseDefinitions(date);
  const states = parseStates(date);
  const profiles = parseProfiles();
  const groupName = parseGroupName();
  if (groupName) elements.groupName.textContent = `${groupName} · ${date}`;

  const activeMembers = members.filter(member => String(member.status || 'active') !== 'disabled');
  const summaries = activeMembers.map(member => {
    const email = String(member.email || member.id || '').toLowerCase();
    const profile = profiles.get(email) || {};
    const assigned = definitions.filter(task => taskAssignedTo(task, email));
    const completedTasks = assigned.filter(task => states.get(`${email}::${task.id}`) === true);
    const completedCount = completedTasks.length;
    const totalCount = assigned.length;
    const percent = totalCount ? Math.round((completedCount / totalCount) * 100) : 0;
    return {
      email,
      name: profile.name || member.name || email,
      picture: profile.picture || member.picture || '',
      completedTasks,
      completedCount,
      totalCount,
      percent,
      champion: totalCount > 0 && completedCount === totalCount
    };
  }).sort((a, b) => Number(b.champion) - Number(a.champion) || b.percent - a.percent || b.completedCount - a.completedCount || a.name.localeCompare(b.name));

  const assignedTotal = summaries.reduce((sum, member) => sum + member.totalCount, 0);
  const completedTotal = summaries.reduce((sum, member) => sum + member.completedCount, 0);
  const championTotal = summaries.filter(member => member.champion).length;
  const groupPercent = assignedTotal ? Math.round((completedTotal / assignedTotal) * 100) : 0;

  elements.percent.textContent = `${groupPercent}%`;
  elements.detail.textContent = assignedTotal ? `${completedTotal} of ${assignedTotal} assigned activities completed` : 'No activities assigned for this date';
  elements.champions.textContent = String(championTotal);
  elements.completed.textContent = String(completedTotal);
  elements.members.textContent = String(summaries.length);
  elements.progressBar.style.width = `${groupPercent}%`;
  elements.grid.innerHTML = '';
  elements.empty.hidden = definitions.length > 0;

  if (!definitions.length) {
    elements.status.textContent = 'No checklist';
    return;
  }

  summaries.forEach(member => {
    const card = document.createElement('article');
    card.className = `champion-card ${member.champion ? 'is-champion' : ''}`;
    const avatar = member.picture
      ? `<img class="champion-avatar" src="${escapeHtml(member.picture)}" alt="${escapeHtml(member.name)}" referrerpolicy="no-referrer" />`
      : `<div class="champion-avatar-fallback" aria-hidden="true">${escapeHtml(initials(member.name, member.email))}</div>`;
    const activities = member.completedTasks.length
      ? `<ul class="completed-activities">${member.completedTasks.map(task => `<li>${escapeHtml(task.title)}</li>`).join('')}</ul>`
      : '<p class="completed-activities-empty">No activities completed yet.</p>';
    card.innerHTML = `
      <div class="champion-card-header">
        ${avatar}
        <div class="champion-person"><h3>${escapeHtml(member.name)}</h3><p>${escapeHtml(member.email)}</p></div>
      </div>
      ${member.champion ? '<div class="champion-badge"><span class="trophy">🏆</span> Champion</div>' : ''}
      <div class="member-completion-row"><strong>${member.percent}%</strong><span>${member.completedCount}/${member.totalCount} complete</span></div>
      <div class="progress-track"><div class="progress-bar" style="width:${member.percent}%"></div></div>
      <div><p class="eyebrow">COMPLETED ACTIVITIES</p>${activities}</div>`;
    elements.grid.appendChild(card);
  });

  elements.status.textContent = championTotal ? `${championTotal} Champion${championTotal === 1 ? '' : 's'}` : 'In progress';
}

async function load() {
  const session = sessionStorage.getItem(SESSION_KEY) || '';
  if (!session) {
    elements.authRequired.hidden = false;
    elements.dashboard.hidden = true;
    elements.refresh.hidden = true;
    return;
  }

  elements.refresh.disabled = true;
  elements.status.textContent = 'Loading';
  try {
    const [user, dashboardData, memberData] = await Promise.all([request('/api/me'), request('/api/dashboard'), request('/api/group/members')]);
    currentUser = user;
    members = Array.isArray(memberData) ? memberData : [];
    const project = (dashboardData?.projects || []).find(item => String(item.name || '').trim().toLowerCase() === TASK_PROJECT_NAME.toLowerCase());
    elements.groupName.textContent = `${user.groupName || dashboardData?.group?.name || 'Community group'} · daily completion`;
    if (project?.projectId) {
      const projectData = await request(`/api/projects/${encodeURIComponent(project.projectId)}/entries`);
      entries = Array.isArray(projectData?.entries) ? projectData.entries : [];
    } else {
      entries = [];
    }
    elements.authRequired.hidden = true;
    elements.dashboard.hidden = false;
    render(elements.date.value || localDateString());
  } catch (error) {
    console.error(error);
    if (error.status === 401) {
      elements.authRequired.hidden = false;
      elements.dashboard.hidden = true;
      elements.refresh.hidden = true;
    } else {
      elements.dashboard.hidden = false;
      elements.status.textContent = 'Unable to load';
      elements.grid.innerHTML = `<p class="form-message error">${escapeHtml(error.message)}</p>`;
    }
  } finally {
    elements.refresh.disabled = false;
  }
}

elements.date.addEventListener('change', () => render(elements.date.value || localDateString()));
elements.refresh.addEventListener('click', load);
load();