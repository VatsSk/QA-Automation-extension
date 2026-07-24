// ─── content.js ──────────────────────────────────────────────────────────────
// Page bridge: listens for commands from the background service worker,
// delegates to QAOverlay, and sends results back.

(function () {
  'use strict';

  if (window.__qaContentLoaded) return;
  window.__qaContentLoaded = true;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {

      case 'PING':
        sendResponse({ alive: true });
        break;

      case 'START_CAPTURE': {
        const mode = msg.captureMode || 'BOTH'; // 'LOCATOR' | 'VALUE' | 'BOTH'

        // Ensure QAOverlay is available (overlay.js injected before content.js)
        if (!window.QAOverlay) {
          console.warn('[QA] overlay.js not yet ready');
          sendResponse({ ok: false, error: 'overlay not ready' });
          return;
        }

        window.QAOverlay.start(mode, (captureMode, result) => {
          try {
            // result is null if user pressed Escape
            chrome.runtime.sendMessage({
              type: 'CAPTURE_RESULT',
              captureMode,
              result
            });
            // Bring the recorder window back into focus after capture
            chrome.runtime.sendMessage({ type: 'FOCUS_RECORDER' });
          } catch (e) {
            if (e.message.includes('Extension context invalidated')) {
              alert('QA Extension was updated. Please refresh this page to continue capturing elements.');
              if (window.QAOverlay) window.QAOverlay.stop();
            } else {
              console.error('[QA] Send message failed:', e);
            }
          }
        });

        sendResponse({ ok: true });
        break;
      }

      case 'STOP_CAPTURE':
        if (window.QAOverlay) window.QAOverlay.stop();
        sendResponse({ ok: true });
        break;

      case 'START_RECORDING':
      case 'STOP_RECORDING':
      case 'PAUSE_RECORDING':
      case 'START_VERIFICATION':
      case 'STOP_VERIFICATION':
      case 'START_HOVER_CAPTURE':
      case 'STOP_HOVER_CAPTURE':
        if (window.QAOverlay && window.QAOverlay.handleSmartCommand) {
          window.QAOverlay.handleSmartCommand(msg.type);
        }
        sendResponse({ ok: true });
        break;

      default:
        break;
    }
  });

  // Listen for custom events from overlay.js and forward them to the background script
  // Use { once: false } but track if we've already sent this specific event
  let lastEventDetail = null;
  let lastEventTime = 0;
  
  document.addEventListener('qa-step-recorded', (e) => {
    const now = Date.now();
    const detail = JSON.stringify(e.detail);
    
    // Prevent duplicate event forwarding within 500ms
    if (detail === lastEventDetail && (now - lastEventTime) < 500) {
      console.log('[Content] Duplicate qa-step-recorded event blocked');
      return;
    }
    
    lastEventDetail = detail;
    lastEventTime = now;
    
    console.log('[Content] Forwarding qa-step-recorded:', e.detail.target?.cssSelector);
    chrome.runtime.sendMessage({ type: 'STEP_RECORDED', data: e.detail });
  });

  document.addEventListener('qa-element-captured', (e) => {
    console.log('[Content] Forwarding qa-element-captured:', e.detail.cssSelector);
    chrome.runtime.sendMessage({ type: 'ELEMENT_CAPTURED', data: e.detail });
  });

  document.addEventListener('qa-ext-shortcut', (e) => {
    console.log('[Content] Forwarding shortcut:', e.detail);
    chrome.runtime.sendMessage({ type: e.detail });
  });

  document.addEventListener('qa-url-captured', (e) => {
    console.log('[Content] Forwarding URL capture:', e.detail.url);
    chrome.runtime.sendMessage({ type: 'URL_CAPTURED', data: e.detail });
  });

})();
