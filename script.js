if (typeof BareMux === 'undefined') {
    BareMux = {
        BareMuxConnection: class {
            constructor() { }
            setTransport() { }
        }
    };
}

const DEFAULT_SEARCH_ENGINES = {
    brave:      { name: 'Brave Search', url: 'https://search.brave.com/search?q=' },
    duckduckgo: { name: 'DuckDuckGo',   url: 'https://duckduckgo.com/?q=' },
    google:     { name: 'Google',        url: 'https://www.google.com/search?safe=active&q=' },
    bing:       { name: 'Bing',          url: 'https://www.bing.com/search?q=' }
};

// Declare scramjet globally so it can be used by createTab and other functions
let scramjet;

// basePath must be defined at top-level so it's available both inside and outside DOMContentLoaded
const basePath = location.pathname.replace(/[^/]*$/, '') || '/';

document.addEventListener('DOMContentLoaded', async function () {
    const { ScramjetController } = $scramjetLoadController();

    scramjet = new ScramjetController({
        prefix: basePath + 'JS/scramjet/',
        files: {
            wasm: basePath + 'JS/scramjet.wasm.wasm',
            all:  basePath + 'JS/scramjet.all.js',
            sync: basePath + 'JS/scramjet.sync.js',
        },
    });

    scramjet.init();

    await navigator.serviceWorker.register(basePath + 'sw.js', { scope: basePath });

    navigator.serviceWorker.ready.then((registration) => {
        registration.active.postMessage({
            type: "config",
            wispurl: localStorage.getItem("proxServer") || _CONFIG.wispurl,
        });
    });
});

const connection = new BareMux.BareMuxConnection(`${basePath}B/worker.js`);
const store = {
    url: "https://",
    wispurl: localStorage.getItem("proxServer") || _CONFIG.wispurl,
    bareurl: _CONFIG?.bareurl || (location.protocol === "https:" ? "https" : "http") + "://" + location.host + "/bare/"
};
connection.setTransport(`${basePath}Ep/index.mjs`, [{ wisp: store.wispurl }]);

// Monitor WISP connection health
setInterval(testWispHealth, 60000);

let tabs = [];
let activeTabId = null;
let nextTabId = 1;
let sortableInstance = null;

// ── Notification system ───────────────────────────────────────────────────────
const NotificationManager = (() => {
    let container;
    function getContainer() {
        if (!container) {
            container = document.createElement('div');
            container.id = 'notification-container';
            container.style.cssText = `
                position: fixed; top: 12px; right: 12px;
                display: flex; flex-direction: column; gap: 8px;
                z-index: 99999; pointer-events: none;
            `;
            document.body.appendChild(container);
        }
        return container;
    }

    return {
        notify(message, type = 'info', duration = 4000) {
            const c = getContainer();
            const el = document.createElement('div');
            const colors = {
                info:    { bg: '#1e2a3a', border: '#3b82f6', icon: 'ℹ' },
                success: { bg: '#0f2a1a', border: '#22c55e', icon: '✓' },
                error:   { bg: '#2a0f0f', border: '#ef4444', icon: '✕' },
                warning: { bg: '#2a1f0f', border: '#f59e0b', icon: '⚠' },
            };
            const { bg, border, icon } = colors[type] || colors.info;
            el.style.cssText = `
                background: ${bg}; border: 1px solid ${border}; border-left: 3px solid ${border};
                color: #e2e8f0; padding: 10px 14px; border-radius: 8px;
                font-family: 'Inter', system-ui, sans-serif; font-size: 0.85rem;
                pointer-events: auto; cursor: pointer;
                display: flex; align-items: center; gap: 8px;
                max-width: 320px; box-shadow: 0 4px 20px rgba(0,0,0,0.5);
                opacity: 0; transform: translateX(20px);
                transition: opacity 0.2s, transform 0.2s;
            `;
            el.innerHTML = `<span style="font-weight:600;color:${border}">${icon}</span><span>${message}</span>`;
            c.appendChild(el);
            requestAnimationFrame(() => {
                el.style.opacity = '1';
                el.style.transform = 'translateX(0)';
            });
            const dismiss = () => {
                el.style.opacity = '0';
                el.style.transform = 'translateX(20px)';
                setTimeout(() => el.remove(), 220);
            };
            el.onclick = dismiss;
            setTimeout(dismiss, duration);
        }
    };
})();

// ── Tab management ────────────────────────────────────────────────────────────
function createTab(makeActive = true) {
    const frame = scramjet.createFrame();
    const tab = {
        id: nextTabId++,
        title: "Loading...",
        url: "",
        frame: frame,
        favicon: "",
        loading: true,
        progress: 10,
        faviconTimeout: null,
        progressInterval: null
    };

    updateLoadingBar(tab);
    frame.frame.src = `${basePath}NT.html`;

    frame.addEventListener("urlchange", (e) => {
        if (!e.url || e.url === "about:blank") return;
        tab.url = e.url;
        tab.loading = true;
        tab.progress = 10;
        updateLoadingBar(tab);
        try { tab.favicon = new URL(e.url).origin + '/favicon.ico'; } catch { /* ignore */ }
        try {
            tab.title = isSameOrigin(e.url)
                ? (frame.frame.contentWindow.document.title || new URL(e.url).hostname)
                : new URL(e.url).hostname;
        } catch { tab.title = new URL(e.url).hostname; }
        updateTabsUI();
        updateAddressBar();
    });

    frame.addEventListener("connectionerror", () => testWispHealth());

    if (tab.favicon) {
        tab.faviconTimeout = setTimeout(() => {
            if (tab.favicon) { tab.favicon = ""; updateTabsUI(); }
        }, 2000);
    }

    frame.frame.addEventListener('load', () => {
        try {
            const newTitle = frame.frame.contentWindow.document.title;
            tab.title = newTitle || "New Tab";
        } catch { tab.title = "New Tab"; }
        tab.loading = false;
        tab.progress = 100;
        updateLoadingBar(tab);
        updateTabsUI();
    });

    tabs.push(tab);
    if (makeActive) activeTabId = tab.id;
    return tab;
}

function getActiveTab() {
    return tabs.find((tab) => tab.id === activeTabId);
}

function switchTab(tabId) {
    if (activeTabId === tabId) return;
    tabs.forEach((tab) => tab.frame.frame.classList.add("hidden"));
    activeTabId = tabId;
    const activeTab = getActiveTab();
    if (activeTab) activeTab.frame.frame.classList.remove("hidden");
    updateTabsUI();
    updateAddressBar();
    updateLoadingBar(activeTab);
}

function closeTab(tabId) {
    const tabIndex = tabs.findIndex((tab) => tab.id === tabId);
    if (tabIndex === -1) return;
    const tabToRemove = tabs[tabIndex];
    if (tabToRemove.faviconTimeout)  clearTimeout(tabToRemove.faviconTimeout);
    if (tabToRemove.progressInterval) clearInterval(tabToRemove.progressInterval);
    if (tabToRemove.frame.frame.parentNode) {
        tabToRemove.frame.frame.parentNode.removeChild(tabToRemove.frame.frame);
    }
    tabs.splice(tabIndex, 1);
    if (activeTabId === tabId) {
        if (tabs.length > 0) {
            switchTab(tabs[Math.min(tabIndex, tabs.length - 1)].id);
        } else {
            activeTabId = null;
            const newTab = createTab(true);
            document.getElementById("iframe-container").appendChild(newTab.frame.frame);
        }
    }
    updateTabsUI();
    updateAddressBar();
}

function updateTabsUI() {
    const tabsContainer = document.getElementById("tabs-container");
    if (!tabsContainer) return;

    // Preserve children to avoid Sortable re-init every frame
    tabsContainer.innerHTML = '';

    tabs.forEach((tab) => {
        const tabElement = document.createElement("div");
        tabElement.className = `tab ${tab.id === activeTabId ? "active" : ""}`;
        tabElement.setAttribute("data-tab-id", tab.id);
        tabElement.onclick = () => switchTab(tab.id);

        const faviconImg = document.createElement("img");
        faviconImg.className = "tab-favicon";
        if (tab.favicon?.trim()) faviconImg.src = tab.favicon;
        faviconImg.onerror = () => { faviconImg.src = ""; };

        const titleSpan = document.createElement("span");
        titleSpan.className = `tab-title ${tab.loading ? "tab-loading" : ""}`;
        titleSpan.textContent = tab.title;

        const closeButton = document.createElement("button");
        closeButton.className = "tab-close";
        closeButton.innerHTML = "&times;";
        closeButton.onclick = (e) => { e.stopPropagation(); closeTab(tab.id); };

        tabElement.appendChild(faviconImg);
        tabElement.appendChild(titleSpan);
        tabElement.appendChild(closeButton);
        tabsContainer.appendChild(tabElement);
    });

    const newBtn = document.createElement("button");
    newBtn.className = "new-tab";
    newBtn.textContent = "+";
    newBtn.onclick = () => {
        const newTab = createTab(false);
        document.getElementById("iframe-container").appendChild(newTab.frame.frame);
        switchTab(newTab.id);
    };
    tabsContainer.appendChild(newBtn);

    if (sortableInstance) sortableInstance.destroy();
    sortableInstance = new Sortable(tabsContainer, {
        animation: 200,
        direction: "horizontal",
        ghostClass: "sortable-ghost",
        dragClass: "sortable-drag",
        filter: ".new-tab",
        onEnd: (evt) => {
            if (evt.oldIndex !== evt.newIndex) {
                const movedTab = tabs.splice(evt.oldIndex, 1)[0];
                tabs.splice(evt.newIndex, 0, movedTab);
            }
        }
    });
}

function updateAddressBar() {
    const addressBar = document.getElementById("address-bar");
    const activeTab = getActiveTab();
    if (addressBar) addressBar.value = activeTab ? activeTab.url : "";
}

function isSameOrigin(url) {
    try {
        return new URL(url).origin === window.location.origin;
    } catch { return false; }
}

function toggleDevTools() {
    const activeTab = getActiveTab();
    if (!activeTab) return;
    const frameWindow = activeTab.frame.frame.contentWindow;
    if (!frameWindow) return;

    if (!isSameOrigin(activeTab.frame.frame.src)) {
        NotificationManager.notify('Dev tools unavailable for cross-origin content.', 'warning');
        return;
    }

    if (frameWindow.eruda) {
        frameWindow.eruda.destroy();
        delete frameWindow.eruda;
    } else {
        const script = frameWindow.document.createElement('script');
        script.src = "https://cdn.jsdelivr.net/npm/eruda";
        script.onload = function () {
            let attempts = 0;
            const tryInit = setInterval(() => {
                if (frameWindow.eruda?.init) {
                    frameWindow.eruda.init();
                    frameWindow.eruda.show();
                    clearInterval(tryInit);
                } else if (attempts++ > 10) clearInterval(tryInit);
            }, 100);
        };
        frameWindow.document.body.appendChild(script);
    }
}

window.addEventListener('message', (event) => {
    if (event.data?.type === 'navigate' && event.data.url) {
        getActiveTab()?.frame.go(event.data.url);
    }
});

async function initializeBrowser() {
    const root = document.getElementById("app");
    root.innerHTML = `
        <div class="browser-container">
            <div class="flex tabs" id="tabs-container"></div>
            <div class="flex nav">
                <button id="back-btn"    title="Back"><i class="fa-solid fa-chevron-left"></i></button>
                <button id="fwd-btn"     title="Forward"><i class="fa-solid fa-chevron-right"></i></button>
                <button id="reload-btn"  title="Reload"><i class="fa-solid fa-rotate-right"></i></button>
                <input  class="bar" id="address-bar" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Search or enter URL...">
                <button id="devtools-btn"       title="Dev Tools"><i class="fa-solid fa-code"></i></button>
                <button id="wisp-settings-btn"  title="WISP Settings"><i class="fa-solid fa-cog"></i></button>
                <button id="open-new-window-btn" title="Open in new window"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>
            </div>
            <div class="loading-bar-container">
                <div class="loading-bar" id="loading-bar"></div>
            </div>
            <div class="iframe-container" id="iframe-container"></div>
        </div>`;

    document.getElementById('back-btn').onclick   = () => getActiveTab()?.frame.back();
    document.getElementById('fwd-btn').onclick    = () => getActiveTab()?.frame.forward();
    document.getElementById('reload-btn').onclick = () => getActiveTab()?.frame.reload();
    document.getElementById('address-bar').onkeyup = (e) => { if (e.key === 'Enter') handleSubmit(); };
    document.getElementById('open-new-window-btn').onclick = () => {
        const url = getActiveTab()?.url;
        if (url) window.open(scramjet.encodeUrl(url));
    };
    document.getElementById('devtools-btn').onclick = toggleDevTools;

    const initialTab = createTab(true);
    document.getElementById("iframe-container").appendChild(initialTab.frame.frame);
    updateTabsUI();
    updateAddressBar();
    await checkHashParameters();
    initializeWISPEvents();
}

async function handleIncomingSearch() {
    const hash = window.location.hash.substring(1);
    if (!hash) return;
    try {
        let decoded = decodeURIComponent(hash);
        // Handle double-encoded URLs
        try { if (new URL(decoded) && decoded !== hash) decoded = decodeURIComponent(decoded); } catch {}

        const addressBar = document.getElementById('address-bar');
        if (!addressBar) return;

        if (decoded.startsWith('search=')) {
            const params = new URLSearchParams(decoded);
            const query  = params.get('search');
            const engine = params.get('engine') || 'duckduckgo';
            if (query) {
                const eng = (window.searchEngines || DEFAULT_SEARCH_ENGINES)[engine] || DEFAULT_SEARCH_ENGINES.brave;
                const searchUrl = eng.url + encodeURIComponent(query);
                addressBar.value = searchUrl;
                handleSubmit(searchUrl);
            }
        } else if (decoded.startsWith('url=')) {
            const url = decoded.substring(4);
            addressBar.value = url;
            handleSubmit();
        } else if (/^https?:\/\//i.test(decoded)) {
            addressBar.value = decoded;
            handleSubmit();
        }
    } catch (err) {
        console.warn('Error processing hash parameter:', err);
    } finally {
        history.replaceState(null, null, location.pathname + location.search);
    }
}

async function checkHashParameters() {
    if (location.hash) await handleIncomingSearch();
}

function handleSubmit(url = null) {
    const activeTab  = getActiveTab();
    const addressBar = document.getElementById("address-bar");
    if (!activeTab || !addressBar) return;

    let inputUrl = url || addressBar.value.trim();
    if (!inputUrl) return;

    try { inputUrl = decodeURIComponent(inputUrl); } catch {}

    if (!/^https?:\/\//i.test(inputUrl)) {
        inputUrl = (inputUrl.includes('.') && !inputUrl.includes(' '))
            ? 'https://' + inputUrl
            : 'https://search.brave.com/search?q=' + encodeURIComponent(inputUrl);
    }

    try { new URL(inputUrl); }
    catch { inputUrl = 'https://search.brave.com/search?q=' + encodeURIComponent(inputUrl); }

    addressBar.value = inputUrl;
    activeTab.frame.go(inputUrl);
}

window.addEventListener("load", async () => {
    await initializeBrowser();
});

// ── WISP Settings Modal ───────────────────────────────────────────────────────
function openWISPSettingsModal() {
    const modal           = document.getElementById('wisp-settings-modal');
    const currentUrlDisplay = document.getElementById('current-wisp-url');
    const customUrlInput  = document.getElementById('custom-wisp-url');
    const currentUrl      = localStorage.getItem('proxServer') || _CONFIG.wispurl;

    currentUrlDisplay.textContent = currentUrl;
    customUrlInput.value = currentUrl;
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    document.querySelectorAll('.wisp-option-btn').forEach(btn => { btn.textContent = 'Select'; });
    const selectedOption = document.querySelector(`[data-url="${currentUrl}"]`);
    if (selectedOption) selectedOption.querySelector('.wisp-option-btn').textContent = 'Selected ✓';

    updateWispStatus('info', 'Ready to configure');
    updateApplyButton();
}

function closeWISPSettingsModal() {
    document.getElementById('wisp-settings-modal').classList.add('hidden');
    document.body.style.overflow = 'auto';
}

function selectWispUrl(url) {
    document.querySelectorAll('.wisp-option-btn').forEach(btn => { btn.textContent = 'Select'; });
    const opt = document.querySelector(`[data-url="${url}"]`);
    if (opt) opt.querySelector('.wisp-option-btn').textContent = 'Selected ✓';
    document.getElementById('custom-wisp-url').value = url;
    document.getElementById('current-wisp-url').textContent = url;
    updateWispStatus('success', `Selected: ${url}`);
    updateApplyButton();
}

function saveCustomWisp() {
    const customUrl = document.getElementById('custom-wisp-url').value.trim();
    if (!customUrl) { updateWispStatus('error', 'Please enter a WISP URL'); return; }
    if (!/^wss?:\/\//.test(customUrl)) {
        updateWispStatus('error', 'URL must start with wss:// or ws://');
        return;
    }
    document.getElementById('current-wisp-url').textContent = customUrl;
    updateWispStatus('success', `Custom WISP URL set`);
    updateApplyButton();
}

function testWispConnection() {
    const testUrl = document.getElementById('custom-wisp-url').value.trim();
    if (!testUrl) { updateWispStatus('error', 'Enter a WISP URL to test'); return; }
    updateWispStatus('loading', 'Testing connection...');
    try {
        const ws = new WebSocket(testUrl);
        const timeout = setTimeout(() => { ws.close(); updateWispStatus('error', 'Timeout — server may be offline'); }, 5000);
        ws.onopen  = () => { clearTimeout(timeout); ws.close(); updateWispStatus('success', 'Connection successful!'); };
        ws.onerror = () => { clearTimeout(timeout); updateWispStatus('error', 'Connection failed — check URL and server'); };
    } catch { updateWispStatus('error', 'Invalid WISP URL format'); }
}

function applyWispSettings() {
    const newWispUrl = document.getElementById('current-wisp-url').textContent;
    localStorage.setItem('proxServer', newWispUrl);
    window.dispatchEvent(new CustomEvent('localStorageUpdate', { detail: { key: 'proxServer', newValue: newWispUrl } }));
    if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'config', wispurl: newWispUrl });
    }
    store.wispurl = newWispUrl;
    connection.setTransport(`${basePath}Ep/index.mjs`, [{ wisp: newWispUrl }]);
    updateWispStatus('success', 'Settings applied!');
    NotificationManager.notify('WISP settings updated successfully.', 'success');
    setTimeout(closeWISPSettingsModal, 1000);
}

function updateWispStatus(type, message) {
    const indicator = document.getElementById('wisp-status-indicator');
    const text      = document.getElementById('wisp-status-text');
    indicator.className = 'status-indicator';
    text.className      = 'status-text';
    const cls = { success: 'status-success', error: 'status-error', loading: 'status-loading', info: 'status-info' };
    if (cls[type]) { indicator.classList.add(cls[type]); text.classList.add(cls[type]); }
    text.textContent = message;
}

function updateApplyButton() {
    const applyBtn    = document.getElementById('apply-wisp-btn');
    const currentUrl  = document.getElementById('current-wisp-url').textContent;
    const originalUrl = localStorage.getItem('proxServer') || _CONFIG.wispurl;
    applyBtn.disabled = (currentUrl === originalUrl);
}

function initializeWISPEvents() {
    document.getElementById('wisp-settings-btn').addEventListener('click', openWISPSettingsModal);
    document.getElementById('close-wisp-modal').addEventListener('click', closeWISPSettingsModal);
    document.getElementById('close-wisp-modal-footer').addEventListener('click', closeWISPSettingsModal);
    document.querySelectorAll('[data-action="select-wisp"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            selectWispUrl(e.target.closest('.wisp-option').dataset.url);
        });
    });
    document.getElementById('save-custom-wisp-btn').addEventListener('click', saveCustomWisp);
    document.getElementById('test-wisp-btn').addEventListener('click', testWispConnection);
    document.getElementById('apply-wisp-btn').addEventListener('click', applyWispSettings);

    const customUrlInput = document.getElementById('custom-wisp-url');
    customUrlInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveCustomWisp(); } });
    customUrlInput.addEventListener('input', updateApplyButton);

    document.getElementById('wisp-settings-modal').addEventListener('click', (e) => {
        if (e.target.id === 'wisp-settings-modal') closeWISPSettingsModal();
    });
}

function showWispBrokenNotification() {
    NotificationManager.notify('WISP connection issue. Check settings.', 'error', 5000);
}

function testWispHealth() {
    const wispUrl = localStorage.getItem('proxServer') || _CONFIG.wispurl;
    try {
        const ws = new WebSocket(wispUrl);
        const timeout = setTimeout(() => { ws.close(); showWispBrokenNotification(); }, 5000);
        ws.onopen  = () => { clearTimeout(timeout); ws.close(); };
        ws.onerror = () => { clearTimeout(timeout); showWispBrokenNotification(); };
    } catch { showWispBrokenNotification(); }
}

function updateLoadingBar(tab) {
    const loadingBar = document.getElementById("loading-bar");
    if (!loadingBar || !tab || tab.id !== activeTabId) return;

    if (tab.loading) {
        loadingBar.style.width   = `${tab.progress}%`;
        loadingBar.style.opacity = "1";
        if (tab.progress < 90 && !tab.progressInterval) {
            tab.progressInterval = setInterval(() => {
                if (!tab.loading || tab.progress >= 90) {
                    clearInterval(tab.progressInterval);
                    tab.progressInterval = null;
                    return;
                }
                tab.progress = Math.min(tab.progress + Math.random() * 10, 90);
                if (activeTabId === tab.id) loadingBar.style.width = `${tab.progress}%`;
            }, 500);
        }
    } else {
        loadingBar.style.width = "100%";
        setTimeout(() => {
            if (activeTabId === tab.id && !tab.loading) {
                loadingBar.style.opacity = "0";
                setTimeout(() => {
                    if (activeTabId === tab.id && !tab.loading) loadingBar.style.width = "0%";
                }, 200);
            }
        }, 200);
        if (tab.progressInterval) { clearInterval(tab.progressInterval); tab.progressInterval = null; }
    }
}
