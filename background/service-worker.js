// ─── service-worker.js ──────────────────────────────────────────────────────
// Acts as a message bus between the in-tab UI overlay (iframe) and content
// scripts injected on target tabs.

let targetTabId = null;         // The tab the user is recording against
let uiInjectedTabs = new Set(); // Tracks which tabs have the UI overlay

// ── Recording state tracked in the SW so we can auto-reinject after navigation ─
let recordingState = {
  isRecording: false,
  isPaused: false,
  isVerification: false,
  isHoverCapture: false,
  lockedTabId: null    // When recording, we lock to this specific tab
};

// ── Persist / restore state across service-worker restarts ───────────────────
// MV3 service workers are ephemeral — Chrome can terminate them at any time.
async function persistWindowState() {
  await chrome.storage.session.set({ targetTabId, recordingState, uiTabs: Array.from(uiInjectedTabs) });
}

async function restoreWindowState() {
  const s = await chrome.storage.session.get(['targetTabId', 'recordingState', 'uiTabs']);
  if (s.targetTabId) targetTabId = s.targetTabId;
  if (s.recordingState) recordingState = s.recordingState;
  if (s.uiTabs) uiInjectedTabs = new Set(s.uiTabs);
}

async function clearTabUI(tabId) {
  uiInjectedTabs.delete(tabId);
  await chrome.storage.session.remove('qa_ui_' + tabId);
  await persistWindowState();
}

// ── Inject overlay UI into the tab when the toolbar icon is clicked ──────────
chrome.action.onClicked.addListener(async (tab) => {
  await restoreWindowState();

  // Check if UI is already injected in this tab
  if (uiInjectedTabs.has(tab.id)) {
    try {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'PING_UI' });
      if (res?.alive) {
        // UI already injected — toggle minimize/restore
        chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_UI' });
        return;
      }
    } catch (_) {
      uiInjectedTabs.delete(tab.id);
    }
  }

  // Guard: check URL is injectable
  const url = tab.url || '';
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') ||
      url.startsWith('about:') || url.startsWith('edge://') ||
      url.startsWith('devtools://') || url === '') {
    return; // Can't inject on restricted pages
  }

  targetTabId = tab.id;

  // Inject content scripts first (overlay, locator, content)
  await ensureContentScript(tab.id);

  // Set tabId for ui-injector before it loads
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (tid) => { window.__qaTargetTabId = tid; },
    args: [tab.id]
  });

  // Inject UI overlay CSS + JS
  await chrome.scripting.insertCSS({
    target: { tabId: tab.id },
    files: ['content/ui-injector.css']
  }).catch(e => console.warn('[SW] UI CSS inject failed:', e.message));

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content/ui-injector.js']
  });

  uiInjectedTabs.add(tab.id);
  await persistWindowState();
});

// ── Track when a tab with our UI is closed ────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  if (uiInjectedTabs.has(tabId)) {
    uiInjectedTabs.delete(tabId);
    if (tabId === targetTabId) {
      recordingState = {
        isRecording: false,
        isPaused: false,
        isVerification: false,
        isHoverCapture: false,
        lockedTabId: null
      };
      targetTabId = null;
    }
    persistWindowState();
  }
});

// ── Track the active tab ─────────────────────────────────────────────────────
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  await restoreWindowState();

  // Tab Lock: If recording is active and locked to a specific tab, do NOT switch
  if (recordingState.lockedTabId) return;

  // Don't change target unless the activated tab has our UI
  if (!uiInjectedTabs.has(tabId)) return;

  targetTabId = tabId;
  await persistWindowState();
});

// ── Re-inject content scripts after page navigation ──────────────────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Restore state in case SW restarted
  await restoreWindowState();

  if (tabId !== targetTabId) return;

  if (changeInfo.status === 'complete') {
    // ── Auto re-inject if recording was active ────────────────────────────
    // Page navigation destroys all injected scripts. We must re-inject them
    // and restore the recording state so the user doesn't notice any interruption.
    if (recordingState.isRecording) {
      console.log('[SW] Page navigated during recording — re-injecting content scripts...');
      try {
        // Force re-injection by clearing any cached promise for this tab
        injectionPromises.delete(tabId);
        await ensureContentScript(tabId);

        // Restore the recording state on the freshly injected scripts
        // Small delay to let scripts fully initialize
        await new Promise(r => setTimeout(r, 200));
        await chrome.tabs.sendMessage(tabId, { type: 'START_RECORDING' }).catch(() => {});

        if (recordingState.isVerification) {
          await new Promise(r => setTimeout(r, 100));
          await chrome.tabs.sendMessage(tabId, { type: 'START_VERIFICATION' }).catch(() => {});
        }
        if (recordingState.isHoverCapture) {
          await new Promise(r => setTimeout(r, 100));
          await chrome.tabs.sendMessage(tabId, { type: 'START_HOVER_CAPTURE' }).catch(() => {});
        }
        if (recordingState.isPaused) {
          await chrome.tabs.sendMessage(tabId, { type: 'PAUSE_RECORDING' }).catch(() => {});
        }

        console.log('[SW] Content scripts re-injected and recording state restored.');
      } catch (err) {
        console.warn('[SW] Failed to re-inject after navigation:', err.message);
      }
    }

    // ── Re-inject UI overlay if this tab had it ──────────────────────────
    if (uiInjectedTabs.has(tabId)) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (tid) => { window.__qaTargetTabId = tid; },
          args: [tabId]
        });
        await chrome.scripting.insertCSS({
          target: { tabId },
          files: ['content/ui-injector.css']
        }).catch(() => {});
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content/ui-injector.js']
        });
        console.log('[SW] UI overlay re-injected after navigation.');
      } catch (err) {
        console.warn('[SW] Failed to re-inject UI after navigation:', err.message);
      }
    }
  }
});

// ── Listen for messages from external sources (e.g. spring boot application) ─────────────────
chrome.runtime.onMessageExternal.addListener(
  (msg, sender, sendResponse) => {

    console.log("External message:", msg);

    switch (msg.action) {

      case 'START_RECORDING':

        chrome.storage.local.set({
          projectId: msg.projectId,
          moduleId: msg.moduleId,
          createdBy: msg.createdBy,
          url: msg.url,
          csvPath: msg.csvPath,
          runId: msg.runId || null,
          existingRun: msg.existingRun || null,
          flowId: msg.flowId || null,
          existingFlow: msg.existingFlow || null,
          mode: msg.flag || msg.mode || 'RUN', // flag from web-app, mode as fallback
        }).then(() => {
          return chrome.storage.local.remove(['flow_draft']); // Clear local draft on fresh server launch
        }).then(() => {
          notifyPopup({ type: 'RELOAD_SESSION' });
        });

          // Tell Chrome to spawn a brand new window with extensions enabled!
        chrome.windows.create({
            type: "normal", // This is the most important part! It forces the full browser UI.
            url: msg.url,
            focused: true
        });
 
        sendResponse({ success: true, message: "Window opened by extension" });
        break;
    }

    return true;
  }
);


// ── Message bus ──────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    case 'START_RECORDING': {
      if (!targetTabId) {
        sendResponse({ ok: false, error: 'No target tab' });
        break;
      }

      // ── Lock to this tab so switching tabs doesn't break recording ──
      recordingState.isRecording = true;
      recordingState.isPaused = false;
      recordingState.lockedTabId = targetTabId;
      persistWindowState();

      ensureContentScript(targetTabId)
        .then(() => chrome.tabs.sendMessage(targetTabId, { type: msg.type }))
        .catch(() => {});
      sendResponse({ ok: true });
      return true;
    }

    case 'STOP_RECORDING': {
      // ── Unlock the tab when recording stops ──
      recordingState.isRecording = false;
      recordingState.isPaused = false;
      recordingState.isVerification = false;
      recordingState.isHoverCapture = false;
      recordingState.lockedTabId = null;
      persistWindowState();

      if (targetTabId) {
        chrome.tabs.sendMessage(targetTabId, { type: msg.type }).catch(() => {});
      }
      sendResponse({ ok: true });
      break;
    }

    case 'PAUSE_RECORDING': {
      recordingState.isPaused = true;
      persistWindowState();

      if (targetTabId) {
        ensureContentScript(targetTabId)
          .then(() => chrome.tabs.sendMessage(targetTabId, { type: msg.type }))
          .catch(() => {});
      }
      sendResponse({ ok: true });
      return true;
    }

    case 'START_VERIFICATION': {
      recordingState.isVerification = true;
      persistWindowState();

      if (targetTabId) {
        ensureContentScript(targetTabId)
          .then(() => chrome.tabs.sendMessage(targetTabId, { type: msg.type }))
          .catch(() => {});
      }
      sendResponse({ ok: true });
      return true;
    }

    case 'STOP_VERIFICATION': {
      recordingState.isVerification = false;
      persistWindowState();

      if (targetTabId) {
        chrome.tabs.sendMessage(targetTabId, { type: msg.type }).catch(() => {});
      }
      sendResponse({ ok: true });
      break;
    }

    case 'START_HOVER_CAPTURE': {
      recordingState.isHoverCapture = true;
      persistWindowState();

      if (targetTabId) {
        ensureContentScript(targetTabId)
          .then(() => chrome.tabs.sendMessage(targetTabId, { type: msg.type }))
          .catch(() => {});
      }
      sendResponse({ ok: true });
      return true;
    }

    case 'STOP_HOVER_CAPTURE': {
      recordingState.isHoverCapture = false;
      persistWindowState();

      if (targetTabId) {
        chrome.tabs.sendMessage(targetTabId, { type: msg.type }).catch(() => {});
      }
      sendResponse({ ok: true });
      break;
    }

    // Popup asks: who is the current target tab?
    case 'POPUP_INIT': {
      ensureContentScript(targetTabId)
        .then(() => {
          sendResponse({ tabId: targetTabId });
        })
        .catch((err) => {
          console.warn('[QA] Initial injection skipped:', err.message);
          sendResponse({ tabId: targetTabId });
        });
      return true; // async
    }

    // Popup wants to start element capture on the target page
    case 'START_CAPTURE': {
      if (!targetTabId) {
        sendResponse({ ok: false, error: 'No target tab' });
        break;
      }
      ensureContentScript(targetTabId)
        .then(() => chrome.tabs.sendMessage(targetTabId, {
          type: 'START_CAPTURE',
          captureMode: msg.captureMode   // 'LOCATOR' | 'VALUE' | 'BOTH'
        }))
        .then(() => {
          // Bring the target tab's window to front so user can click elements
          chrome.tabs.get(targetTabId, (tab) => {
            if (tab?.windowId) chrome.windows.update(tab.windowId, { focused: true });
          });
          sendResponse({ ok: true });
        })
        .catch((err) => {
          console.warn('[QA] START_CAPTURE failed:', err);
          sendResponse({ ok: false, error: err?.message ?? String(err) });
        });
      return true;
    }

    // Popup cancels capture
    case 'STOP_CAPTURE': {
      if (targetTabId) {
        chrome.tabs.sendMessage(targetTabId, { type: 'STOP_CAPTURE' }).catch(() => {});
      }
      sendResponse({ ok: true });
      break;
    }

    // Content script finished capturing — relay to popup
    case 'CAPTURE_RESULT': {
      notifyPopup({ type: 'CAPTURE_RESULT', captureMode: msg.captureMode, result: msg.result });
      sendResponse({ ok: true });
      break;
    }

    // Forward step recordings from content script to popup
    case 'STEP_RECORDED': {
      console.log('[SW] Forwarding STEP_RECORDED:', msg.data?.target?.cssSelector);
      notifyPopup({ type: 'STEP_RECORDED', data: msg.data });
      sendResponse({ ok: true });
      break;
    }

    // Forward element captures from content script to popup
    case 'ELEMENT_CAPTURED': {
      console.log('[SW] Forwarding ELEMENT_CAPTURED:', msg.data?.cssSelector);
      notifyPopup({ type: 'ELEMENT_CAPTURED', data: msg.data });
      sendResponse({ ok: true });
      break;
    }
    
    case 'TOGGLE_HOVER_MODE_OFF': {
      recordingState.isHoverCapture = false;
      persistWindowState();
      notifyPopup(msg);
      sendResponse({ ok: true });
      break;
    }

    case 'TOGGLE_VERIFICATION_MODE': {
      recordingState.isVerification = false;
      persistWindowState();
      notifyPopup(msg);
      sendResponse({ ok: true });
      break;
    }


    // Content script requests focus back on the recorder — restore overlay if minimized
    case 'FOCUS_RECORDER': {
      if (targetTabId) {
        chrome.tabs.sendMessage(targetTabId, { type: 'FOCUS_RECORDER' }).catch(() => {});
      }
      break;
    }

    default:
      break;
  }
});

const injectionPromises = new Map();

async function ensureContentScript(tabId) {
  if (!tabId) return;

  if (injectionPromises.has(tabId)) {
    return injectionPromises.get(tabId);
  }

  const promise = (async () => {
    // ── Guard: check if the tab exists and is on an injectable page ───────────
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (_) {
      throw new Error('Tab no longer exists');
    }

    const url = tab.url || '';
    if (
      url.startsWith('chrome://') ||
      url.startsWith('chrome-extension://') ||
      url.startsWith('about:') ||
      url.startsWith('edge://') ||
      url.startsWith('devtools://') ||
      url === '' // new tab page before URL loads
    ) {
      throw new Error(
        `Cannot inject scripts on restricted page: ${url || '(new tab)'}.\\nNavigate to a regular website first.`
      );
    }

    // ── Ping first — if content script is already alive, no need to re-inject ─
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      return; // already injected and responsive
    } catch (_) {
      // Not injected yet — fall through to injection
    }

    // ── Inject all content files ──────────────────────────────────────────────
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/overlay.css']
    }).catch((e) => console.warn('[QA] CSS inject failed:', e.message));

    for (const file of [
      'locator-engine/locator-generator.js',
      'content/overlay.js',
      'content/content.js'
    ]) {
      await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
    }

    // ── Verify the scripts are actually live with a post-inject PING ──────────
    // Retry a few times since scripts may not register their listener instantly
    let alive = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await chrome.tabs.sendMessage(tabId, { type: 'PING' });
        alive = true;
        break;
      } catch (_) {
        await new Promise(r => setTimeout(r, 150));
      }
    }
    if (!alive) {
      throw new Error('Scripts injected but content script did not respond. Try clicking the element again.');
    }
  })();

  injectionPromises.set(tabId, promise);
  try {
    await promise;
  } finally {
    injectionPromises.delete(tabId);
  }
}

function notifyPopup(msg) {
  if (!targetTabId) return;
  msg._targetTabId = targetTabId;
  chrome.runtime.sendMessage(msg).catch(() => {});
}
