(() => {
  const config = window.TRACK_EVERYTHING_CONFIG || {};
  const SESSION_KEY = 'trackEverythingSession';
  const ANNOUNCE_URL = 'https://sharecapsule.app/card/announce/';
  const grid = document.getElementById('championGrid');
  if (!grid) return;

  const api = path => `${String(config.apiUrl || '').replace(/\/$/, '')}${path}`;
  async function getCurrentUser() {
    const token = sessionStorage.getItem(SESSION_KEY) || '';
    if (!token || !config.apiUrl) return null;
    try {
      const response = await fetch(api('/api/me'), { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      if (!response.ok) return null;
      const payload = await response.json();
      return payload?.data || null;
    } catch { return null; }
  }

  function installStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .announce-completion { display:flex; align-items:center; justify-content:center; width:100%; min-height:44px; margin-top:14px; border:0; border-radius:13px; background:#17211c; color:#fff; font-weight:850; text-decoration:none; }
      .champion-card.is-champion .announce-completion { background:linear-gradient(135deg,#8a6008,#b68118); }
      .announce-completion:hover { filter:brightness(1.06); }
    `;
    document.head.appendChild(style);
  }

  function completionCounts(card) {
    const text = card.querySelector('.member-completion-row span')?.textContent || '';
    const match = text.match(/(\d+)\s*\/\s*(\d+)/);
    return match ? { completed: Number(match[1]), total: Number(match[2]) } : { completed: 0, total: 0 };
  }

  function addAnnouncementButton(card, currentEmail) {
    if (card.querySelector('.announce-completion')) return;
    const email = String(card.querySelector('.champion-person p')?.textContent || '').trim().toLowerCase();
    if (!email || email !== currentEmail) return;
    const { completed, total } = completionCounts(card);
    if (!completed) return;

    const name = String(card.querySelector('.champion-person h3')?.textContent || 'Community member').trim();
    const date = document.getElementById('dashboardDate')?.value || new Date().toISOString().slice(0, 10);
    const groupLabel = String(document.getElementById('dashboardGroupName')?.textContent || 'Track Everything').trim();
    const group = groupLabel.split(' · ')[0] || groupLabel;
    const activities = [...card.querySelectorAll('.completed-activities li')].map(item => item.textContent.trim()).filter(Boolean);
    const champion = card.classList.contains('is-champion');
    const percent = total ? Math.round((completed / total) * 100) : 0;

    const url = new URL(ANNOUNCE_URL);
    url.searchParams.set('name', name);
    url.searchParams.set('group', group);
    url.searchParams.set('date', date);
    url.searchParams.set('completed', String(completed));
    url.searchParams.set('total', String(total));
    url.searchParams.set('percent', String(percent));
    url.searchParams.set('champion', champion ? '1' : '0');
    url.searchParams.set('return', location.href);
    activities.slice(0, 8).forEach(activity => url.searchParams.append('activity', activity));

    const link = document.createElement('a');
    link.className = 'announce-completion';
    link.href = url.toString();
    link.textContent = champion ? '🏆 Announce Champion completion' : '📣 Announce completion';
    link.setAttribute('aria-label', champion ? 'Announce your Champion completion' : 'Announce your activity completion');
    card.appendChild(link);
  }

  async function enhance() {
    const user = await getCurrentUser();
    const email = String(user?.email || '').trim().toLowerCase();
    if (!email) return;
    [...grid.querySelectorAll('.champion-card')].forEach(card => addAnnouncementButton(card, email));
  }

  installStyles();
  const observer = new MutationObserver(() => enhance());
  observer.observe(grid, { childList: true, subtree: true });
  window.addEventListener('load', () => setTimeout(enhance, 600));
  document.getElementById('dashboardDate')?.addEventListener('change', () => setTimeout(enhance, 300));
})();