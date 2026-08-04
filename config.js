// Public browser configuration only. Never add Google client secrets or refresh tokens here.
window.TRACK_EVERYTHING_CONFIG = {
  apiUrl: "https://track-everything-api-854374277452.us-west1.run.app"
};

const pwaScript = document.createElement('script');
pwaScript.src = 'assets/pwa.js';
pwaScript.defer = true;
document.head.appendChild(pwaScript);
