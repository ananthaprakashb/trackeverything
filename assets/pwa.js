(() => {
  let deferredInstallPrompt = null;

  function updateNetworkStatus() {
    const badge = document.querySelector('#networkStatus');
    if (!badge) return;
    const online = navigator.onLine;
    badge.textContent = online ? 'Online' : 'Offline';
    badge.classList.toggle('error', !online);
  }

  function setupInstallPrompt() {
    const button = document.querySelector('#installButton');
    if (!button) return;

    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault();
      deferredInstallPrompt = event;
      button.hidden = false;
    });

    button.addEventListener('click', async () => {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      button.hidden = true;
    });

    window.addEventListener('appinstalled', () => {
      deferredInstallPrompt = null;
      button.hidden = true;
    });
  }

  function addPwaStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .health-panel { display:grid; gap:20px; }
      .health-options { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }
      .health-option { border:1px solid var(--line); border-radius:18px; padding:18px; background:var(--surface); }
      .health-option p { color:var(--muted); line-height:1.5; }
      @media (max-width:620px) { .health-options { grid-template-columns:1fr; } }
    `;
    document.head.appendChild(style);
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      await navigator.serviceWorker.register('/service-worker.js', { scope: '/' });
    } catch (error) {
      console.error('Service worker registration failed', error);
    }
  }

  window.addEventListener('online', updateNetworkStatus);
  window.addEventListener('offline', updateNetworkStatus);
  document.addEventListener('DOMContentLoaded', () => {
    updateNetworkStatus();
    setupInstallPrompt();
    addPwaStyles();
    registerServiceWorker();
  });
})();
