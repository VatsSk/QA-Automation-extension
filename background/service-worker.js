// ─── service-worker.js ──────────────────────────────────────────────────────
// Manages the persistent detached recorder window and acts as a message bus
// between that window and content scripts injected on target tabs.

let recorderWindowId = null;   // ID of the detached recorder window
let targetTabId = null;         // The tab the user is recording against
let popupTabId = null;          // The tab inside the recorder window

// ── Open / focus the recorder window when the toolbar icon is clicked ────────
chrome.action.onClicked.addListener(async (tab) => {
  targetTabId = tab.id;

  if (recorderWindowId !== null) {
    // If it already exists, just focus it
    try {
      await chrome.windows.update(recorderWindowId, { focused: true });
      // Let the popup know which tab we're on now
      notifyPopup({ type: 'TARGET_TAB_CHANGED', tabId: targetTabId });
      return;
    } catch (_) {
      recorderWindowId = null; // window was closed externally
    }
  }

  // Create a new detached window — NOT a popup, so it stays open
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(
      `popup/popup.html?tabId=${tab.id}&windowId=SELF`
    ),
    type: 'panel',   // panel stays on top and does not close on page click
    width: 720,
    height: 820,
    focused: true
  });

  recorderWindowId = win.id;
  // The single tab in our new window
  popupTabId = win.tabs?.[0]?.id ?? null;
});

// ── Track when our recorder window is closed ─────────────────────────────────
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === recorderWindowId) {
    recorderWindowId = null;
    popupTabId = null;
  }
});

// ── Track the active tab so the popup always knows which page to record ──────
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  // Ignore activation events from our own recorder window
  if (windowId === recorderWindowId) return;
  targetTabId = tabId;
  notifyPopup({ type: 'TARGET_TAB_CHANGED', tabId });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== targetTabId) return;
  if (changeInfo.status === 'complete') {
    notifyPopup({ type: 'TARGET_TAB_CHANGED', tabId });
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
          csvPath: msg.csvPath
        });

        sendResponse({
          success: true
        });

        break;
    }

    return true;
  }
);


// ── Message bus ──────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    // Popup asks: who is the current target tab?
    case 'POPUP_INIT': {
      ensureContentScript(targetTabId).then(() => {
        sendResponse({ tabId: targetTabId });
      });
      return true; // async
    }

    // Popup wants to start element capture on the target page
    case 'START_CAPTURE': {
      ensureContentScript(targetTabId).then(() => {
        chrome.tabs.sendMessage(targetTabId, {
          type: 'START_CAPTURE',
          captureMode: msg.captureMode   // 'LOCATOR' | 'VALUE' | 'BOTH'
        }).catch(console.warn);
        // Bring the target tab's window to front so user can click elements
        chrome.tabs.get(targetTabId, (tab) => {
          if (tab?.windowId) chrome.windows.update(tab.windowId, { focused: true });
        });
        sendResponse({ ok: true });
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

// ── Helpers ──────────────────────────────────────────────────────────────────
async function ensureContentScript(tabId) {
  if (!tabId) return;
  try {
    // Ping first — if content script already alive, no need to re-inject
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
  } catch (_) {
    // Not injected yet — inject all content files
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/overlay.css'] }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId }, files: ['locator-engine/locator-generator.js'] }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/overlay.js'] }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] }).catch(() => {});
  }
}

function notifyPopup(msg) {
  if (!popupTabId) return;
  chrome.tabs.sendMessage(popupTabId, msg).catch(() => {});
}
