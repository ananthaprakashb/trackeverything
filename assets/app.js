const demoData = {
  generatedAt: new Date().toISOString(),
  date: new Date().toISOString().slice(0, 10),
  members: [
    { memberId: "member-1", name: "Anantha", steps: 8240, goal: 10000, syncedAt: new Date().toISOString() },
    { memberId: "member-2", name: "Family Member 2", steps: 6350, goal: 8000, syncedAt: new Date().toISOString() },
    { memberId: "member-3", name: "Family Member 3", steps: 10120, goal: 10000, syncedAt: new Date().toISOString() }
  ],
  trend: [
    { date: "2026-07-27", steps: 20100 },
    { date: "2026-07-28", steps: 22750 },
    { date: "2026-07-29", steps: 18920 },
    { date: "2026-07-30", steps: 25140 },
    { date: "2026-07-31", steps: 27980 },
    { date: "2026-08-01", steps: 23860 },
    { date: "2026-08-02", steps: 24710 }
  ]
};

const config = window.TRACK_EVERYTHING_CONFIG || {};
const elements = {
  familySteps: document.querySelector("#familySteps"),
  familyGoalProgress: document.querySelector("#familyGoalProgress"),
  activeMembers: document.querySelector("#activeMembers"),
  goalsReached: document.querySelector("#goalsReached"),
  lastSync: document.querySelector("#lastSync"),
  statusBadge: document.querySelector("#statusBadge"),
  memberGrid: document.querySelector("#memberGrid"),
  emptyState: document.querySelector("#emptyState"),
  trendChart: document.querySelector("#trendChart"),
  refreshButton: document.querySelector("#refreshButton")
};

const numberFormatter = new Intl.NumberFormat();

function setStatus(label, isError = false) {
  elements.statusBadge.textContent = label;
  elements.statusBadge.classList.toggle("error", isError);
}

function buildApiUrl() {
  if (!config.apiUrl) return null;
  const url = new URL(config.apiUrl);
  url.searchParams.set("action", "dashboard");
  if (config.familyId) url.searchParams.set("familyId", config.familyId);
  if (config.readKey) url.searchParams.set("readKey", config.readKey);
  return url.toString();
}

async function loadDashboard() {
  elements.refreshButton.disabled = true;
  setStatus("Syncing");

  try {
    const apiUrl = buildApiUrl();
    if (!apiUrl) {
      renderDashboard(demoData);
      setStatus("Demo data");
      return;
    }

    const response = await fetch(apiUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`API request failed (${response.status})`);
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || "API returned an error");

    renderDashboard(payload.data);
    setStatus("Live");
  } catch (error) {
    console.error(error);
    renderDashboard(demoData);
    setStatus("API unavailable — demo shown", true);
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
  elements.familyGoalProgress.textContent = familyGoal
    ? `${Math.round((familySteps / familyGoal) * 100)}% of the combined daily goal`
    : "No family goal configured";
  elements.activeMembers.textContent = numberFormatter.format(members.length);
  elements.goalsReached.textContent = `${goalsReached}/${members.length}`;
  elements.lastSync.textContent = formatTime(data.generatedAt);

  renderMembers(members);
  renderTrend(Array.isArray(data.trend) ? data.trend : []);
}

function renderMembers(members) {
  elements.memberGrid.innerHTML = "";
  elements.emptyState.hidden = members.length > 0;

  members.forEach(member => {
    const steps = Number(member.steps || 0);
    const goal = Number(member.goal || 0);
    const percent = goal ? Math.min(100, Math.round((steps / goal) * 100)) : 0;
    const card = document.createElement("article");
    card.className = "member-card";
    card.innerHTML = `
      <div class="member-row">
        <h3>${escapeHtml(member.name || member.memberId || "Family member")}</h3>
        <span class="member-meta">${percent}%</span>
      </div>
      <div class="member-steps">${numberFormatter.format(steps)}</div>
      <div class="progress-track" aria-label="${percent}% of step goal">
        <div class="progress-bar" style="width:${percent}%"></div>
      </div>
      <p class="member-meta">Goal ${numberFormatter.format(goal)} · synced ${formatTime(member.syncedAt)}</p>
    `;
    elements.memberGrid.appendChild(card);
  });
}

function renderTrend(trend) {
  elements.trendChart.innerHTML = "";
  const maximum = Math.max(...trend.map(item => Number(item.steps || 0)), 1);

  trend.forEach(item => {
    const steps = Number(item.steps || 0);
    const height = Math.max(2, Math.round((steps / maximum) * 100));
    const date = new Date(`${item.date}T12:00:00`);
    const column = document.createElement("div");
    column.className = "trend-column";
    column.innerHTML = `
      <div class="trend-bar-wrap"><div class="trend-bar" style="height:${height}%"></div></div>
      <div class="trend-value">${numberFormatter.format(steps)}</div>
      <div class="trend-label">${date.toLocaleDateString(undefined, { weekday: "short" })}</div>
    `;
    elements.trendChart.appendChild(column);
  });
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

elements.refreshButton.addEventListener("click", loadDashboard);
loadDashboard();
