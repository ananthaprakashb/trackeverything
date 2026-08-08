(() => {
  const GROUP_META_PREFIX = 'TE_GROUP_META:';
  const TASK_PROJECT_NAME = 'Daily Checklist';
  const MAX_GROUP_NAME = 80;

  const byId = id => document.getElementById(id);
  const panel = byId('groupSetupPanel');
  const form = byId('groupSetupForm');
  const nameInput = byId('groupSetupName');
  const emailsInput = byId('groupSetupEmails');
  const goalInput = byId('groupSetupGoal');
  const message = byId('groupSetupMessage');
  const heading = byId('groupSetupHeading');
  const summary = byId('groupSetupSummary');
  const submitButton = byId('groupSetupSubmit');

  if (!panel || !form || !nameInput || !emailsInput || !goalInput || !message || !submitButton) return;

  let profileProject = null;
  let profile = null;
  let syncing = false;

  function setMessage(text, isError = false) {
    message.textContent = text || '';
    message.classList.toggle('error', isError);
  }

  function parseEmails(value) {
    return [...new Set(String(value || '')
      .split(/[\s,;]+/)
      .map(item => item.trim().toLowerCase())
      .filter(Boolean))];
  }

  function validEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  function localDateString() {
    const date = new Date();
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 10);
  }

  function apiRequest(path, options = {}) {
    if (typeof request !== 'function') throw new Error('Track Everything is not ready yet.');
    return request(path, options);
  }

  async function getProfileProject(createIfMissing = false) {
    const dashboard = await apiRequest('/api/dashboard');
    const projects = Array.isArray(dashboard?.projects) ? dashboard.projects : [];
    let project = projects.find(item => String(item?.name || '').trim().toLowerCase() === TASK_PROJECT_NAME.toLowerCase());
    if (!project && createIfMissing) {
      project = await apiRequest('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ name: TASK_PROJECT_NAME, type: 'count' })
      });
    }
    profileProject = project || null;
    return profileProject;
  }

  async function loadProfile() {
    const project = await getProfileProject(false);
    if (!project) return null;
    const data = await apiRequest(`/api/projects/${encodeURIComponent(project.projectId)}/entries`);
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    let latest = null;
    for (const entry of entries) {
      const note = String(entry?.notes || '');
      if (!note.startsWith(GROUP_META_PREFIX)) continue;
      try {
        const parsed = JSON.parse(note.slice(GROUP_META_PREFIX.length));
        if (!parsed?.n) continue;
        const updatedAt = String(entry?.updatedAt || '');
        if (!latest || updatedAt >= latest.updatedAt) latest = { ...parsed, updatedAt };
      } catch (_) {}
    }
    profile = latest;
    return profile;
  }

  function applyProfile() {
    if (!profile?.n) return;
    const groupName = byId('groupName');
    if (groupName) {
      const roleLabel = typeof currentUser !== 'undefined' && currentUser?.role === 'admin' ? 'Organizer' : 'Participant';
      groupName.textContent = `${profile.n} · ${roleLabel}`;
    }
    if (heading) heading.textContent = 'Manage your group';
    if (summary) summary.textContent = `${profile.n} is active. Add more people at any time.`;
    if (!nameInput.value) nameInput.value = profile.n;
    submitButton.textContent = 'Save group & add people';
  }

  async function addMembers(emails, dailyGoal) {
    const failures = [];
    let added = 0;
    for (const [index, email] of emails.entries()) {
      setMessage(`Adding ${index + 1} of ${emails.length}: ${email}`);
      try {
        await apiRequest('/api/group/members', {
          method: 'POST',
          body: JSON.stringify({ email, dailyGoal })
        });
        added += 1;
      } catch (error) {
        failures.push(`${email}: ${error.message}`);
      }
    }
    return { added, failures };
  }

  async function saveProfile(groupName) {
    const project = await getProfileProject(true);
    const payload = {
      n: groupName,
      startedAt: profile?.startedAt || new Date().toISOString(),
      by: typeof currentUser !== 'undefined' ? currentUser?.email || '' : ''
    };
    const note = GROUP_META_PREFIX + JSON.stringify(payload);
    if (note.length > 500) throw new Error('Group name is too long.');
    await apiRequest(`/api/projects/${encodeURIComponent(project.projectId)}/entries`, {
      method: 'POST',
      body: JSON.stringify({ value: 0, date: localDateString(), notes: note })
    });
    profile = { ...payload, updatedAt: new Date().toISOString() };
  }

  async function refreshProfileUI() {
    if (syncing || typeof currentUser === 'undefined' || !currentUser) return;
    syncing = true;
    try {
      const isAdmin = currentUser.role === 'admin';
      panel.hidden = !isAdmin;
      await loadProfile();
      applyProfile();
    } catch (error) {
      console.warn('Unable to load group profile', error);
    } finally {
      syncing = false;
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (typeof currentUser === 'undefined' || currentUser?.role !== 'admin') return;

    const groupName = String(nameInput.value || '').trim();
    const emails = parseEmails(emailsInput.value);
    const invalid = emails.filter(email => !validEmail(email));
    const dailyGoal = Number(goalInput.value || 10000);

    if (!groupName) return setMessage('Enter a group name.', true);
    if (groupName.length > MAX_GROUP_NAME) return setMessage(`Keep the group name under ${MAX_GROUP_NAME} characters.`, true);
    if (invalid.length) return setMessage(`Check these email addresses: ${invalid.join(', ')}`, true);
    if (!Number.isInteger(dailyGoal) || dailyGoal < 1 || dailyGoal > 100000) return setMessage('Daily step goal must be from 1 to 100,000.', true);

    submitButton.disabled = true;
    setMessage(profile ? 'Saving group…' : 'Starting group…');
    try {
      await saveProfile(groupName);
      const result = emails.length ? await addMembers(emails, dailyGoal) : { added: 0, failures: [] };
      applyProfile();
      emailsInput.value = '';

      if (result.failures.length) {
        setMessage(`Group saved. Added ${result.added}; ${result.failures.length} could not be added: ${result.failures.join(' | ')}`, true);
      } else if (result.added) {
        setMessage(`${groupName} is ready. ${result.added} participant${result.added === 1 ? '' : 's'} added.`);
      } else {
        setMessage(`${groupName} is ready. Add people now or later.`);
      }

      if (typeof refreshAll === 'function') await refreshAll();
      await refreshProfileUI();
    } catch (error) {
      console.error(error);
      setMessage(error.message || 'Unable to start the group.', true);
    } finally {
      submitButton.disabled = false;
    }
  });

  const userPanel = byId('userPanel');
  if (userPanel) {
    const observer = new MutationObserver(() => {
      if (!userPanel.hidden) refreshProfileUI();
    });
    observer.observe(userPanel, { attributes: true, attributeFilter: ['hidden'] });
  }

  window.addEventListener('pageshow', () => setTimeout(refreshProfileUI, 300));
  setTimeout(refreshProfileUI, 700);
})();
