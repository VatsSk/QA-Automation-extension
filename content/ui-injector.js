// ─── ui-injector.js ─────────────────────────────────────────────────────────
// Injects the QA extension UI as an iframe overlay within the webpage.
// Handles minimize/restore, keyboard shortcuts, and floating mode indicator.

(function () {
  'use strict';

  // Guard: prevent double injection
  if (window.__qaUIInjectorLoaded) return;
  window.__qaUIInjectorLoaded = true;

  // ── Configuration ────────────────────────────────────────────────────────
  var IFRAME_WIDTH = 450;
  var Z_BASE = 2147483640;

  // ── State ────────────────────────────────────────────────────────────────
  var isMinimized = false;
  var tabId = window.__qaTargetTabId || null;
  var modes = { recording: false, paused: false, verification: false, hover: false };

  // ── Create DOM Elements ──────────────────────────────────────────────────

  // Overlay container (right sidebar panel)
  var container = document.createElement('div');
  container.id = 'qa-ext-overlay';
  container.style.position = 'fixed';
  container.style.top = '0';
  container.style.right = '0';
  container.style.width = IFRAME_WIDTH + 'px';
  container.style.height = '100vh';
  container.style.zIndex = String(Z_BASE);
  container.style.boxShadow = '-4px 0 24px rgba(0,0,0,0.35)';
  container.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
  container.style.transform = 'translateX(0)';
  container.style.pointerEvents = 'auto';
  container.style.borderLeft = '1px solid rgba(99, 102, 241, 0.2)';

  // Iframe (loads flow.html from extension)
  var iframe = document.createElement('iframe');
  iframe.id = 'qa-ext-iframe';
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = 'none';
  iframe.style.background = '#0f172a';
  iframe.setAttribute('allow', 'clipboard-write');
  container.appendChild(iframe);

  // Restore FAB (floating action button, shown when minimized)
  var fab = document.createElement('div');
  fab.id = 'qa-ext-restore-fab';
  fab.innerHTML = '🧪';
  fab.title = 'Restore QA Recorder (click to open)';
  fab.style.position = 'fixed';
  fab.style.bottom = '24px';
  fab.style.right = '24px';
  fab.style.width = '52px';
  fab.style.height = '52px';
  fab.style.borderRadius = '50%';
  fab.style.background = 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)';
  fab.style.color = 'white';
  fab.style.display = 'none';
  fab.style.alignItems = 'center';
  fab.style.justifyContent = 'center';
  fab.style.fontSize = '24px';
  fab.style.cursor = 'pointer';
  fab.style.zIndex = String(Z_BASE + 2);
  fab.style.boxShadow = '0 4px 16px rgba(99, 102, 241, 0.5)';
  fab.style.transition = 'transform 0.2s ease, box-shadow 0.2s ease';
  fab.style.pointerEvents = 'auto';
  fab.style.userSelect = 'none';

  // Floating Mode Indicator (glass pill, top-right corner)
  var indicator = document.createElement('div');
  indicator.id = 'qa-ext-mode-indicator';
  indicator.style.position = 'fixed';
  indicator.style.top = '12px';
  indicator.style.right = (IFRAME_WIDTH + 16) + 'px';
  indicator.style.zIndex = String(Z_BASE - 1);
  indicator.style.pointerEvents = 'none';
  indicator.style.display = 'none';
  indicator.style.flexDirection = 'column';
  indicator.style.gap = '6px';
  indicator.style.transition = 'right 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease';

  // ── Core Functions ───────────────────────────────────────────────────────

  function init() {
    if (!tabId) {
      console.warn('[QA UI] No tabId available for injection');
      return;
    }
    iframe.src = chrome.runtime.getURL('popup/flow.html?tabId=' + tabId);

    document.documentElement.appendChild(container);
    document.documentElement.appendChild(fab);
    document.documentElement.appendChild(indicator);

    restoreUIState();

    document.addEventListener('mousedown', onClickOutside, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('message', onIframeMessage);
  }

  function minimize() {
    isMinimized = true;
    container.style.transform = 'translateX(' + (IFRAME_WIDTH + 20) + 'px)';
    fab.style.display = 'flex';
    indicator.style.right = '16px';
    persistUIState();
  }

  function restore() {
    isMinimized = false;
    container.style.transform = 'translateX(0)';
    fab.style.display = 'none';
    indicator.style.right = (IFRAME_WIDTH + 16) + 'px';
    persistUIState();
  }

  function destroyUI() {
    isMinimized = false;
    if (container.parentNode) container.remove();
    if (fab.parentNode) fab.remove();
    if (indicator.parentNode) indicator.remove();
    document.removeEventListener('mousedown', onClickOutside, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('message', onIframeMessage);
    window.__qaUIInjectorLoaded = false;
    if (tabId) {
      chrome.storage.session.remove('qa_ui_' + tabId).catch(function () {});
    }
  }

  function updateIndicator() {
    var badges = [];
    if (modes.recording && !modes.paused) {
      badges.push({ label: '\u25cf REC', color: '#ef4444' });
    }
    if (modes.paused) {
      badges.push({ label: '\u23f8 PAUSED', color: '#f59e0b' });
    }
    if (modes.verification) {
      badges.push({ label: '\ud83d\udd0d VERIFY', color: '#f97316' });
    }
    if (modes.hover) {
      badges.push({ label: '\ud83d\udd90 HOVER', color: '#ec4899' });
    }

    if (badges.length === 0) {
      indicator.style.display = 'none';
      return;
    }

    indicator.style.display = 'flex';
    var html = '';
    for (var i = 0; i < badges.length; i++) {
      var b = badges[i];
      html += '<div style="' +
        'background: rgba(15, 23, 42, 0.85);' +
        'backdrop-filter: blur(12px);' +
        '-webkit-backdrop-filter: blur(12px);' +
        'border: 1px solid rgba(255,255,255,0.1);' +
        'border-radius: 8px;' +
        'padding: 6px 14px;' +
        'font-family: Inter, system-ui, sans-serif;' +
        'font-size: 11px;' +
        'font-weight: 600;' +
        'color: ' + b.color + ';' +
        'white-space: nowrap;' +
        'letter-spacing: 0.5px;' +
        '">' + b.label + '</div>';
    }
    indicator.innerHTML = html;
  }

  function persistUIState() {
    if (!tabId) return;
    var obj = {};
    obj['qa_ui_' + tabId] = { isMinimized: isMinimized };
    chrome.storage.session.set(obj).catch(function () {});
  }

  function restoreUIState() {
    if (!tabId) return;
    var key = 'qa_ui_' + tabId;
    chrome.storage.session.get(key).then(function (data) {
      var saved = data[key];
      if (saved && saved.isMinimized) {
        minimize();
      }
    }).catch(function () {});
  }

  // ── Event Handlers ───────────────────────────────────────────────────────

  function onClickOutside(e) {
    if (isMinimized) return;
    if (container.contains(e.target) || fab.contains(e.target) || indicator.contains(e.target)) return;
    minimize();
  }

  var lastShortcutTime = 0;

  function onKeyDown(e) {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;

    var key = e.key.toLowerCase();
    var action = null;

    switch (key) {
      case 'h': action = 'TOGGLE_HOVER'; break;
      case 'y': action = 'TOGGLE_PAUSE'; break;
      case 'q': action = 'TOGGLE_VERIFICATION'; break;
      default: return;
    }

    // Debounce rapid presses
    var now = Date.now();
    if (now - lastShortcutTime < 300) return;
    lastShortcutTime = now;

    e.preventDefault();
    e.stopPropagation();

    // Send to iframe
    sendToIframe({ type: 'QA_SHORTCUT', action: action });
    showShortcutFeedback(action);
  }

  function showShortcutFeedback(action) {
    var labels = {
      'TOGGLE_HOVER': '\ud83d\udd90 Hover Mode',
      'TOGGLE_PAUSE': '\u23f8 Play/Pause',
      'TOGGLE_VERIFICATION': '\ud83d\udd0d Verification Mode'
    };

    var toast = document.createElement('div');
    toast.style.position = 'fixed';
    toast.style.top = '50%';
    toast.style.left = '50%';
    toast.style.transform = 'translate(-50%, -50%) scale(0.8)';
    toast.style.background = 'rgba(15, 23, 42, 0.92)';
    toast.style.backdropFilter = 'blur(16px)';
    toast.style.WebkitBackdropFilter = 'blur(16px)';
    toast.style.color = '#f8fafc';
    toast.style.padding = '14px 28px';
    toast.style.borderRadius = '14px';
    toast.style.fontFamily = 'Inter, system-ui, sans-serif';
    toast.style.fontSize = '15px';
    toast.style.fontWeight = '600';
    toast.style.zIndex = String(Z_BASE + 5);
    toast.style.pointerEvents = 'none';
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
    toast.style.border = '1px solid rgba(99, 102, 241, 0.3)';
    toast.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.3)';
    toast.textContent = labels[action] || action;
    document.documentElement.appendChild(toast);

    requestAnimationFrame(function () {
      toast.style.opacity = '1';
      toast.style.transform = 'translate(-50%, -50%) scale(1)';
    });

    setTimeout(function () {
      toast.style.opacity = '0';
      toast.style.transform = 'translate(-50%, -50%) scale(0.9)';
      setTimeout(function () { if (toast.parentNode) toast.remove(); }, 250);
    }, 900);
  }

  function sendToIframe(msg) {
    if (iframe.contentWindow) {
      iframe.contentWindow.postMessage(msg, '*');
    }
  }

  function onIframeMessage(e) {
    if (e.source !== iframe.contentWindow) return;
    var msg = e.data;
    if (!msg || typeof msg !== 'object' || !msg.type) return;

    switch (msg.type) {
      case 'QA_MODE_CHANGE':
        modes = msg.modes || modes;
        updateIndicator();
        break;
      case 'QA_CLOSE':
        destroyUI();
        break;
      case 'QA_MINIMIZE':
        minimize();
        break;
    }
  }

  // ── Chrome Extension Message Listener ────────────────────────────────────
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.type === 'PING_UI') {
      sendResponse({ alive: true, minimized: isMinimized });
      return true;
    }
    if (msg.type === 'TOGGLE_UI') {
      if (isMinimized) restore();
      else minimize();
    }
    if (msg.type === 'FOCUS_RECORDER') {
      if (isMinimized) restore();
    }
  });

  // ── FAB Events ───────────────────────────────────────────────────────────
  fab.addEventListener('click', function (e) {
    e.stopPropagation();
    e.preventDefault();
    restore();
  });

  fab.addEventListener('mouseenter', function () {
    fab.style.transform = 'scale(1.12)';
    fab.style.boxShadow = '0 6px 24px rgba(99, 102, 241, 0.7)';
  });
  fab.addEventListener('mouseleave', function () {
    fab.style.transform = 'scale(1)';
    fab.style.boxShadow = '0 4px 16px rgba(99, 102, 241, 0.5)';
  });

  // ── Auto-init ────────────────────────────────────────────────────────────
  init();

})();
