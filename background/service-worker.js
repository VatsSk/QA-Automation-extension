// ─── service-worker.js ──────────────────────────────────────────────────────
// Message router and state manager. Coordinates between the Side Panel UI and
// scripts injected on target tabs.

// ── Setup: runs once when extension is installed/updated or Chrome starts ─────
// Wrapped in onInstalled/onStartup so Chrome has fully registered the SW first,
// avoiding the "No SW" error from sidePanel API.
function initExtension() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error('[QA] Side panel config error:', error));

  // Keep service worker alive FOREVER — alarm fires every 25s,
  // resetting Chrome's 30s idle timer so it never kills the SW.
  chrome.alarms.create('keepAlive', { periodInMinutes: 25 / 60 });
}

chrome.runtime.onInstalled.addListener(initExtension);
chrome.runtime.onStartup.addListener(initExtension);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    // No-op — just being woken up resets Chrome's 30s idle timer
  }
});

let targetTabId = null;         // The tab the user is recording against
let pendingMessages = [];       // Queue for messages received while popup is closed
let panelPort = null;            // Persistent port to the side panel
let activeWindowId = null;       // The ID of the window spawned by the extension

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
  await chrome.storage.session.set({ targetTabId, recordingState, pendingMessages, activeWindowId });
}

function updateBadge() {
  if (pendingMessages.length > 0) {
    chrome.action.setBadgeText({ text: pendingMessages.length.toString() });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' }); // Red
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

async function restoreWindowState() {
  const s = await chrome.storage.session.get(['targetTabId', 'recordingState', 'pendingMessages', 'activeWindowId']);
  if (s.targetTabId) targetTabId = s.targetTabId;
  if (s.recordingState) recordingState = s.recordingState;
  if (s.pendingMessages && s.pendingMessages.length > 0) pendingMessages = s.pendingMessages;
  if (s.activeWindowId) activeWindowId = s.activeWindowId;
}

// ── Persistent port connection from side panel ───────────────────────────────
// Instead of unreliable chrome.runtime.sendMessage, the side panel opens a
// long-lived port. We push messages through this port, and instantly know
// if the panel is connected or disconnected.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'qa-panel') {
    console.log('[SW] Side panel connected via port');
    panelPort = port;

    port.onDisconnect.addListener(() => {
      console.log('[SW] Side panel disconnected');
      panelPort = null;
    });
  }
});

// ── Clean up window ID when the user closes the window ───────────────────────
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === activeWindowId) {
    activeWindowId = null;
    persistWindowState();
  }
});

// Track closed tabs to clear state
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === targetTabId) {
    recordingState = {
      isRecording: false,
      isPaused: false,
      isVerification: false,
      isHoverCapture: false,
      lockedTabId: null
    };
    targetTabId = null;
    persistWindowState();
  }
});

// ── Track the active tab ─────────────────────────────────────────────────────
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  await restoreWindowState();

  // Tab Lock: If recording is active and locked to a specific tab, do NOT switch
  if (recordingState.lockedTabId) return;

  targetTabId = tabId;
  await persistWindowState();

  // Notify popup that the tab changed, which will trigger a re-injection if it's recording
  notifyPopup({ type: 'TARGET_TAB_CHANGED', tabId: targetTabId });
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
}});

// ── Listen for Chrome Commands (Global Shortcuts) ──────────────────────────────
chrome.commands.onCommand.addListener(async (command) => {
  await restoreWindowState();
  console.log('[SW] Command received:', command);
  let type;
  if (command === 'toggle-verification') type = 'TOGGLE_VERIFICATION_MODE';
  else if (command === 'toggle-hover') type = 'TOGGLE_HOVER_MODE';
  else if (command === 'toggle-pause') type = 'TOGGLE_PAUSE_MODE';

  if (command === 'capture-url') {
    if (targetTabId) {
      chrome.tabs.get(targetTabId, (tab) => {
        if (tab && tab.url) {
          notifyPopupAsync({ type: 'URL_CAPTURED', data: { url: tab.url } }).then(delivered => {
            if (!delivered) {
              pendingMessages.push({ type: 'URL_CAPTURED', data: { url: tab.url } });
              updateBadge();
            }
          });
        }
      });
    }
    return;
  }

  if (type) {
    notifyPopup({ type });
  }
});

// ── Listen for messages from external sources (e.g. spring boot application) ─────────────────
chrome.runtime.onMessageExternal.addListener(
  (msg, sender, sendResponse) => {

    console.log("External message:", msg);

    switch (msg.action) {

      case 'START_RECORDING':
        const launchNewSession = () => {
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
            const launchMode = msg.flag || msg.mode || 'RUN';
            const sidePanelPath = launchMode === 'FLOW' ? 'popup/flow.html' : 'popup/popup.html';
            return chrome.sidePanel.setOptions({ path: sidePanelPath });
          }).then(() => {
            return chrome.storage.local.remove(['flow_draft']); // Clear local draft on fresh server launch
          }).then(() => {
            notifyPopup({ type: 'RELOAD_SESSION' });
            
            // Tell Chrome to spawn a brand new window with extensions enabled!
            chrome.windows.create({
                type: "normal", // This is the most important part! It forces the full browser UI.
                url: msg.url,
                focused: true
            }, (win) => {
                if (win) {
                  activeWindowId = win.id;
                  persistWindowState();
                }
            });
            sendResponse({ success: true, message: "Window opened by extension" });
          });
        };

        // Guard: Prevent overwriting an active session if the extension is already open.
        if (activeWindowId) {
          chrome.windows.get(activeWindowId, (win) => {
            if (chrome.runtime.lastError || !win) {
              // The window was closed, so clear the ID and launch a new session
              activeWindowId = null;
              persistWindowState();
              launchNewSession();
            } else {
              // The window is still open! Just block the request so the web app can show the error.
              console.warn("[SW] Blocked duplicate launch: extension window is already open.");
              sendResponse({ 
                success: false, 
                message: "QA Extension is already open in another window. Please close it first before starting a new session." 
              });
            }
          });
        } else if (panelPort !== null || recordingState.isRecording) {
          // If we don't have the window ID but we know it's active
          console.warn("[SW] Blocked duplicate launch: extension is already active.");
          sendResponse({ 
            success: false, 
            message: "QA Extension is already active in another tab or window. Please close it first before starting a new session." 
          });
        } else {
          // Clean slate, launch new session
          launchNewSession();
        }
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

    case 'GET_PENDING_MESSAGES': {
      sendResponse({ messages: pendingMessages });
      pendingMessages = [];
      persistWindowState();
      updateBadge();
      return true;
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
      restoreWindowState().then(() => {
        // If no target tab, try to find the active tab
        if (!targetTabId) {
          chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
            if (tabs[0]) {
              targetTabId = tabs[0].id;
              persistWindowState();
            }
            ensureContentScript(targetTabId)
              .then(() => sendResponse({ tabId: targetTabId, recordingState }))
              .catch(() => sendResponse({ tabId: targetTabId, recordingState }));
          });
        } else {
          ensureContentScript(targetTabId)
            .then(() => sendResponse({ tabId: targetTabId, recordingState }))
            .catch(() => sendResponse({ tabId: targetTabId, recordingState }));
        }
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
      notifyPopupAsync({ type: 'STEP_RECORDED', data: msg.data }).then(delivered => {
        if (!delivered) {
          pendingMessages.push(msg);
          persistWindowState();
          updateBadge();
        }
      });
      sendResponse({ ok: true });
      break;
    }

    // Forward element captures from content script to popup
    case 'ELEMENT_CAPTURED': {
      console.log('[SW] Forwarding ELEMENT_CAPTURED:', msg.data?.cssSelector);
      notifyPopupAsync({ type: 'ELEMENT_CAPTURED', data: msg.data }).then(delivered => {
        if (!delivered) {
          pendingMessages.push(msg);
          persistWindowState();
          updateBadge();
        }
      });
      sendResponse({ ok: true });
      break;
    }

    // Forward URL captures from content script to popup
    case 'URL_CAPTURED': {
      console.log('[SW] Forwarding URL_CAPTURED:', msg.data?.url);
      notifyPopupAsync({ type: 'URL_CAPTURED', data: msg.data }).then(delivered => {
        if (!delivered) {
          pendingMessages.push(msg);
          updateBadge();
        }
      });
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

    case 'TOGGLE_VERIFICATION_MODE':
    case 'TOGGLE_HOVER_MODE':
    case 'TOGGLE_PAUSE_MODE': {
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

async function notifyPopupAsync(msg) {
  if (!targetTabId) return false;
  msg._targetTabId = targetTabId;
  
  // Use the persistent port if connected (reliable)
  if (panelPort) {
    try {
      panelPort.postMessage(msg);
      return true;
    } catch (err) {
      console.warn('[SW] Port send failed:', err.message);
      panelPort = null; // Port is dead, clear it
      return false;
    }
  }
  
  // Fallback: try chrome.runtime.sendMessage (less reliable)
  try {
    await chrome.runtime.sendMessage(msg);
    return true;
  } catch (err) {
    return false;
  }
}

function notifyPopup(msg) {
  notifyPopupAsync(msg).catch(() => {});
}
