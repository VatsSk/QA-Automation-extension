// ─── content.js ──────────────────────────────────────────────────────────────
// Page bridge: listens for commands from the background service worker,
// delegates to QAOverlay, and sends results back.

(function () {
  'use strict';

  // ── Re-injection safe: clean up previous instance before initializing ──────
  if (window.__qaContentCleanup) {
    try { window.__qaContentCleanup(); } catch (_) {}
  }
  window.__qaContentLoaded = true;

  // ── Frame Path Discovery (Bubble Architecture) ─────────────────────────────
  // Instead of passing framePaths down and dealing with race conditions, 
  // we bubble events UP to window.top. Each parent prepends its locator for the child.

  const getAllIframes = (root = document) => {
    let iframes = Array.from(root.querySelectorAll('iframe, frame'));
    const allElements = root.querySelectorAll('*');
    for (const el of allElements) {
      if (el.shadowRoot) {
        iframes = iframes.concat(getAllIframes(el.shadowRoot));
      }
    }
    return iframes;
  };

  const bubbleUpMessageHandler = (event) => {
    if (event.data && event.data.type === 'QA_EXTENSION_BUBBLE_UP') {
      const childWindow = event.source;
      const iframes = getAllIframes();
      let iframeElement = null;
      let index = -1;
      
      for (let i = 0; i < iframes.length; i++) {
        if (iframes[i].contentWindow === childWindow) {
          iframeElement = iframes[i];
          index = i;
          break;
        }
      }
      
      if (!iframeElement && event.data.href) {
        for (let i = 0; i < iframes.length; i++) {
          if (iframes[i].src && iframes[i].src !== '' && event.data.href.includes(iframes[i].src)) {
            iframeElement = iframes[i];
            index = i;
            break;
          }
        }
      }
      
      if (iframeElement && window.LocatorGenerator) {
        const loc = window.LocatorGenerator.generate(iframeElement);
        const info = window.LocatorGenerator.getElementInfo(iframeElement);
        const frameLocator = {
          selector: loc.bestLocator,
          selectorType: 'css',
          index: index,
          id: info.id || null,
          name: info.name || null,
          title: iframeElement.getAttribute('title') || null,
          src: iframeElement.src || null
        };
        
        // Prepend this frame's locator to the child's framePath
        const payload = event.data.payload;
        payload.framePath = [frameLocator, ...(payload.framePath || [])];
        
        if (window !== window.top) {
          window.parent.postMessage({ type: 'QA_EXTENSION_BUBBLE_UP', payload: payload, originalType: event.data.originalType, href: window.location.href }, '*');
        } else {
          // Reached top, send to background
          chrome.runtime.sendMessage({ type: event.data.originalType, data: payload });
        }
      } else if (!iframeElement) {
        // Failed to find child iframe, but we must keep bubbling to avoid dropping the event
        console.warn('[QA] Failed to find child iframe during bubble up. Continuing bubble...');
        if (window !== window.top) {
          window.parent.postMessage({ type: 'QA_EXTENSION_BUBBLE_UP', payload: event.data.payload, originalType: event.data.originalType, href: window.location.href }, '*');
        } else {
          chrome.runtime.sendMessage({ type: event.data.originalType, data: event.data.payload });
        }
      }
    }
  };
  window.addEventListener('message', bubbleUpMessageHandler);

  // Store references to event listeners so we can remove them on re-injection
  let stepRecordedHandler = null;
  let elementCapturedHandler = null;
  let shortcutHandler = null;
  let messageHandler = null;

  messageHandler = (msg, sender, sendResponse) => {
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
  };
  chrome.runtime.onMessage.addListener(messageHandler);

  // Listen for custom events from overlay.js and forward them to the background script
  // Use { once: false } but track if we've already sent this specific event
  let lastEventDetail = null;
  let lastEventTime = 0;
  
  stepRecordedHandler = (e) => {
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
    
    if (window !== window.top) {
      window.parent.postMessage({ type: 'QA_EXTENSION_BUBBLE_UP', payload: e.detail, originalType: 'STEP_RECORDED', href: window.location.href }, '*');
    } else {
      chrome.runtime.sendMessage({ type: 'STEP_RECORDED', data: e.detail });
    }
  };
  document.addEventListener('qa-step-recorded', stepRecordedHandler);

  elementCapturedHandler = (e) => {
    console.log('[Content] Forwarding qa-element-captured:', e.detail.cssSelector);
    
    if (window !== window.top) {
      window.parent.postMessage({ type: 'QA_EXTENSION_BUBBLE_UP', payload: e.detail, originalType: 'ELEMENT_CAPTURED', href: window.location.href }, '*');
    } else {
      chrome.runtime.sendMessage({ type: 'ELEMENT_CAPTURED', data: e.detail });
    }
  };
  document.addEventListener('qa-element-captured', elementCapturedHandler);

  shortcutHandler = (e) => {
    console.log('[Content] Forwarding shortcut:', e.detail);
    chrome.runtime.sendMessage({ type: e.detail });
  };
  document.addEventListener('qa-ext-shortcut', shortcutHandler);

  // Expose cleanup for re-injection
  window.__qaContentCleanup = function () {
    if (messageHandler) chrome.runtime.onMessage.removeListener(messageHandler);
    if (stepRecordedHandler) document.removeEventListener('qa-step-recorded', stepRecordedHandler);
    if (elementCapturedHandler) document.removeEventListener('qa-element-captured', elementCapturedHandler);
    if (shortcutHandler) document.removeEventListener('qa-ext-shortcut', shortcutHandler);
    window.removeEventListener('message', bubbleUpMessageHandler);
  };

  document.addEventListener('qa-url-captured', (e) => {
    console.log('[Content] Forwarding URL capture:', e.detail.url);
    chrome.runtime.sendMessage({ type: 'URL_CAPTURED', data: e.detail });
  });

})();
