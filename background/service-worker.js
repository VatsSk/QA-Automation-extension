// ─── service-worker.js ──────────────────────────────────────────────────────
// Manages the persistent detached recorder window and acts as a message bus
// between that window and content scripts injected on target tabs.

let recorderWindowId = null;   // ID of the detached recorder window
let targetTabId = null;         // The tab the user is recording against
let popupTabId = null;          // The tab inside the recorder window
let isCreatingWindow = false;   // Guard against onActivated race during window creation

// ── Recording state tracked in the SW so we can auto-reinject after navigation ─
let recordingState = {
  isRecording: false,
  isPaused: false,
  isVerification: false,
  isHoverCapture: false,
  lockedTabId: null    // When recording, we lock to this specific tab
};

// ── Persist / restore window IDs across service-worker restarts ──────────────
// MV3 service workers are ephemeral — Chrome can terminate them at any time.
// We persist recorderWindowId & popupTabId in chrome.storage.session so that
// a restarted service worker can re-adopt an already-open recorder window
// instead of creating a duplicate.
async function persistWindowState() {
  await chrome.storage.session.set({ recorderWindowId, popupTabId, targetTabId, recordingState });
}

async function restoreWindowState() {
  const s = await chrome.storage.session.get(['recorderWindowId', 'popupTabId', 'targetTabId', 'recordingState']);
  if (s.recorderWindowId) recorderWindowId = s.recorderWindowId;
  if (s.popupTabId) popupTabId = s.popupTabId;
  if (s.targetTabId) targetTabId = s.targetTabId;
  if (s.recordingState) recordingState = s.recordingState;
}

async function clearWindowState() {
  recorderWindowId = null;
  popupTabId = null;
  await chrome.storage.session.remove(['recorderWindowId', 'popupTabId']);
}

// ── Verify that the in-memory / restored window is still alive ───────────────
async function isRecorderWindowAlive() {
  if (recorderWindowId === null) return false;
  try {
    await chrome.windows.get(recorderWindowId);
    return true;
  } catch (_) {
    return false;
  }
}

// ── Open / focus the recorder window when the toolbar icon is clicked ────────
chrome.action.onClicked.addListener(async (tab) => {
  if (isCreatingWindow) return;

  // Restore persisted state in case the service worker was restarted
  await restoreWindowState();

  if (await isRecorderWindowAlive()) {
    // Window is already open — just focus it
    // Do NOT change targetTabId if we are locked to a specific tab (recording in progress)
    try {
      await chrome.windows.update(recorderWindowId, { focused: true });
      if (!recordingState.lockedTabId) {
        // Not locked — safe to switch target to the clicked tab
        targetTabId = tab.id;
        await persistWindowState();
        notifyPopup({ type: 'TARGET_TAB_CHANGED', tabId: targetTabId });
      }
      // If locked, we just focus the window without changing the target
      return;
    } catch (_) {
      await clearWindowState();
    }
  }

  // Save the real target tab before async window creation
  const savedTargetTabId = tab.id;
  targetTabId = tab.id;
  isCreatingWindow = true;

  // Create a new detached window — NOT a popup, so it stays open
  const saved = await chrome.storage.local.get(['winW', 'winH', 'mode']);
  const currentMode = saved.mode || 'FLOW';
  const htmlFile = currentMode === 'FLOW' ? 'popup/flow.html' : 'popup/popup.html';
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(
      `${htmlFile}?tabId=${tab.id}&windowId=SELF`
    ),
    type: 'popup',   // 'popup' opens a clean detached window without tabs
    width:  saved.winW || 720,
    height: saved.winH || 820,
    focused: true
  });

  recorderWindowId = win.id;
  // The single tab in our new window
  popupTabId = win.tabs?.[0]?.id ?? null;

  // Restore targetTabId — onActivated may have overwritten it during await
  targetTabId = savedTargetTabId;
  isCreatingWindow = false;

  // Persist so future SW wake-ups can re-adopt this window
  await persistWindowState();
});

// ── Track when our recorder window is closed ─────────────────────────────────
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === recorderWindowId) {
    // Reset recording state when popup window is closed
    recordingState = {
      isRecording: false,
      isPaused: false,
      isVerification: false,
      isHoverCapture: false,
      lockedTabId: null
    };
    clearWindowState();
  }
});

// ── Track the active tab so the popup always knows which page to record ──────
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  // Ignore activation events from our own recorder window
  if (windowId === recorderWindowId) return;
  // Ignore activations triggered by window creation (recorderWindowId not yet set)
  if (isCreatingWindow) return;

  // Restore state in case SW restarted
  await restoreWindowState();

  // ── Tab Lock: If recording is active and locked to a specific tab, do NOT switch ──
  if (recordingState.lockedTabId) {
    // Don't change targetTabId — recording stays on the locked tab
    return;
  }

  targetTabId = tabId;
  await persistWindowState();
  notifyPopup({ type: 'TARGET_TAB_CHANGED', tabId });
});

// ── Re-inject content scripts after page navigation ──────────────────────────
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Restore state in case SW restarted
  await restoreWindowState();

  if (tabId !== targetTabId) return;

  if (changeInfo.status === 'complete') {
    // Always notify popup about tab update (URL change, title change, etc.)
    notifyPopup({ type: 'TARGET_TAB_CHANGED', tabId, url: tab.url, title: tab.title });

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
  } else if (changeInfo.url) {
    // URL changed but page hasn't finished loading yet — just notify popup
    notifyPopup({ type: 'TARGET_TAB_CHANGED', tabId, url: tab.url, title: tab.title });
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

        sendResponse({ success: true });
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


    // Content script requests focus back on the recorder window after capture
    case 'FOCUS_RECORDER': {
      if (recorderWindowId) {
        chrome.windows.update(recorderWindowId, { focused: true }).catch(() => {});
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
  if (!popupTabId) return;
  chrome.tabs.sendMessage(popupTabId, msg).catch(() => {});
}
