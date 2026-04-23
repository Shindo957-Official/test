// Dynamic WISP URL Configuration
// Default WISP URL: wss://wisp.rhw.one/wisp/
// This can be changed via the settings UI which updates localStorage 'proxServer' key

const basePath = location.pathname.replace(/[^/]*$/, '') || '/';

// Valid URL patterns for WISP servers
const validWispPatterns = [
  /^wss?:\/\/.+\.\w+\/wisp\/?$/,
  /^wss?:\/\/[\d.]+:\d+\/wisp\/?$/,
  /^wss?:\/\/localhost(:\d+)?\/wisp\/?$/
];

/**
 * Validates if a URL is a valid WISP server URL
 * @param {string} url - The URL to validate
 * @returns {boolean}
 */
function isValidWispUrl(url) {
  try {
    if (!url || typeof url !== 'string') return false;
    const urlObj = new URL(url);
    if (urlObj.protocol !== 'wss:' && urlObj.protocol !== 'ws:') return false;
    return validWispPatterns.some(pattern => pattern.test(url));
  } catch (e) {
    return false;
  }
}

let _CONFIG = {
  wispurl: localStorage.getItem("proxServer") || "wss://wisp.rhw.one/wisp/",
  bareurl: undefined
};

/**
 * Updates the WISP URL in configuration when localStorage changes
 */
function updateWispUrl(newUrl) {
  try {
    if (!newUrl || newUrl === _CONFIG.wispurl) return;
    if (!isValidWispUrl(newUrl)) {
      console.warn('Invalid WISP URL format:', newUrl);
      return;
    }
    const oldUrl = _CONFIG.wispurl;
    _CONFIG.wispurl = newUrl;
    console.log(`WISP URL updated: ${oldUrl} → ${newUrl}`);

    if (navigator?.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'config', wispurl: newUrl });
    }
    window.dispatchEvent(new CustomEvent('wispUrlUpdated', { detail: { oldUrl, newUrl } }));
  } catch (error) {
    console.error('Error updating WISP URL:', error);
  }
}

window.addEventListener('storage', (event) => {
  if (event.key === 'proxServer') updateWispUrl(event.newValue);
});

window.addEventListener('localStorageUpdate', (event) => {
  if (event.detail?.key === 'proxServer') updateWispUrl(event.detail.newValue);
});
