(() => {
  const config = window.TRACK_EVERYTHING_CONFIG || {};
  const SESSION_KEY = 'trackEverythingSession';
  const TASK_PROJECT_NAME = 'Daily Checklist';
  const PROFILE_PREFIX = 'TE_MEMBER_PROFILE:';

  function api(path) {
    if (!config.apiUrl) return '';
    return `${String(config.apiUrl).replace(/\/$/, '')}${path}`;
  }

  async function request(path, options = {}) {
    const session = sessionStorage.getItem(SESSION_KEY) || '';
    if (!session || !config.apiUrl) return null;
    const headers = { ...(options.headers || {}), Authorization: `Bearer ${session}` };
    if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const response = await fetch(api(path), { ...options, headers, cache: 'no-store' });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => ({}));
    return payload?.data ?? null;
  }

  function localDateString() {
    const date = new Date();
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 10);
  }

  function parseProfile(note) {
    const value = String(note || '');
    if (!value.startsWith(PROFILE_PREFIX)) return null;
    try { return JSON.parse(value.slice(PROFILE_PREFIX.length)); } catch { return null; }
  }

  async function syncProfile() {
    const session = sessionStorage.getItem(SESSION_KEY) || '';
    if (!session) return;

    try {
      const [user, dashboard] = await Promise.all([request('/api/me'), request('/api/dashboard')]);
      if (!user?.email || !dashboard) return;
      const project = (dashboard.projects || []).find(item => String(item.name || '').trim().toLowerCase() === TASK_PROJECT_NAME.toLowerCase());
      if (!project?.projectId) return;

      const projectData = await request(`/api/projects/${encodeURIComponent(project.projectId)}/entries`);
      const entries = Array.isArray(projectData?.entries) ? projectData.entries : [];
      const email = String(user.email).toLowerCase();
      const latest = [...entries].reverse().map(entry => ({ entry, profile: parseProfile(entry.notes) })).find(item => String(item.profile?.e || '').toLowerCase() === email)?.profile;
      const next = {
        e: email,
        n: String(user.name || email).slice(0, 100),
        p: String(user.picture || '').slice(0, 350)
      };

      if (latest && latest.n === next.n && latest.p === next.p) return;
      const note = PROFILE_PREFIX + JSON.stringify(next);
      if (note.length > 500) return;

      await request(`/api/projects/${encodeURIComponent(project.projectId)}/entries`, {
        method: 'POST',
        body: JSON.stringify({ value: 0, date: localDateString(), notes: note })
      });
    } catch (error) {
      console.warn('Unable to sync member profile metadata', error);
    }
  }

  window.addEventListener('load', () => {
    setTimeout(syncProfile, 1200);
  });
})();