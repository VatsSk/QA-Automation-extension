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
          // result is null if user pressed Escape
          chrome.runtime.sendMessage({
            type: 'CAPTURE_RESULT',
            captureMode,
            result
          });

          // Bring the recorder window back into focus after capture
          chrome.runtime.sendMessage({ type: 'FOCUS_RECORDER' });
        });

        sendResponse({ ok: true });
        break;
      }

      case 'STOP_CAPTURE':
        if (window.QAOverlay) window.QAOverlay.stop();
        sendResponse({ ok: true });
        break;

      default:
        break;
    }
  });

})();
