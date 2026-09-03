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
// tabId -> { scenarioId, isRecording, isPaused, tabRef, parentTabId, isVerification, isHoverCapture }
let recordingState = new Map();

// scenarioId -> ordered array of recorded steps
let scenarioSteps = new Map();

// scenarioId -> next tabRef counter
let tabRefCounters = new Map();

const recentClicks = new Map(); // tabId -> { timestamp, locator }
const injectionWatches = new Map(); // tabId -> timeoutId

// ── Persist / restore state across service-worker restarts ───────────────────
async function persistWindowState() {
  await chrome.storage.session.set({ 
    targetTabId, 
    recordingState: Array.from(recordingState.entries()), 
    scenarioSteps: Array.from(scenarioSteps.entries()),
    tabRefCounters: Array.from(tabRefCounters.entries()),
    pendingMessages, 
    activeWindowId 
  });
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
  const s = await chrome.storage.session.get(['targetTabId', 'recordingState', 'scenarioSteps', 'tabRefCounters', 'pendingMessages', 'activeWindowId']);
  if (s.targetTabId) targetTabId = s.targetTabId;
  if (s.recordingState) recordingState = new Map(s.recordingState);
  if (s.scenarioSteps) scenarioSteps = new Map(s.scenarioSteps);
  if (s.tabRefCounters) tabRefCounters = new Map(s.tabRefCounters);
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
  if (recordingState.has(tabId)) {
    recordingState.delete(tabId);
    clearInjectionWatch(tabId);
  }
  if (tabId === targetTabId) {
    targetTabId = null;
  }
  persistWindowState();
});

// ── Track the active tab ─────────────────────────────────────────────────────
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  console.log(`[multi-tab][${Date.now()}] onActivated: tabId=${tabId}`);
  await restoreWindowState();

  // Tab Lock: If recording is active and locked to a specific tab, do NOT switch
  if (recordingState.lockedTabId) return;

  const previousTabId = targetTabId;
  targetTabId = tabId;
  await persistWindowState();

  if (previousTabId && previousTabId !== tabId) {
    const prevState = recordingState.get(previousTabId);
    const newState = recordingState.get(tabId);
    if (prevState && newState && prevState.scenarioId === newState.scenarioId && prevState.isRecording && newState.isRecording) {
      if (prevState.tabRef && newState.tabRef && prevState.tabRef !== newState.tabRef) {
        // Skip logging a SWITCH_TAB if the target tab was just created (NEW_TAB_OPENED handles this)
        const isNewlyCreated = newState.createdAt && (Date.now() - newState.createdAt) < 1500;
        if (!isNewlyCreated) {
          appendStep(newState.scenarioId, {
            action: 'SWITCH_TAB',
            fromTabRef: prevState.tabRef,
            toTabRef: newState.tabRef,
            tabRef: newState.tabRef,
            timestamp: Date.now()
          });
        }
      }
    }
  }

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
    if (recordingState.get(tabId)?.isRecording) {
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
          const launchMode = msg.flag || msg.mode || 'RUN';
          const sessionData = {
            projectId: msg.projectId,
            createdBy: msg.createdBy,
            url: msg.url,
            mode: launchMode
          };

          if (launchMode === 'COMPONENT' || launchMode === 'EDIT_COMPONENT') {
            console.log("[SW] Launching Component Recorder");
            console.log("[SW] Captured compModuleId from web:", msg.compModuleId);
            sessionData.compModuleId = msg.compModuleId;
            sessionData.compId = msg.compId || null;
            sessionData.compName = msg.name || null;
            sessionData.compDesc = msg.description || null;
            
            if (launchMode === 'EDIT_COMPONENT') {
              sessionData.existingComponent = {
                name: msg.name,
                defaultWait: 5000,
                steps: msg.steps || []
              };
            }
          } else if (launchMode === 'FLOW') {
            sessionData.moduleId = msg.moduleId;
            sessionData.flowId = msg.flowId || null;
            sessionData.existingFlow = msg.existingFlow || null;
            sessionData.csvPath = msg.csvPath || null;
          } else {
            // Default (RUN)
            sessionData.moduleId = msg.moduleId;
            sessionData.runId = msg.runId || null;
            sessionData.existingRun = msg.existingRun || null;
            sessionData.csvPath = msg.csvPath || null;
          }

          chrome.storage.local.remove(['flow_draft', 'component_draft', 'existingComponent', 'existingFlow', 'existingRun']).then(() => {
            return chrome.storage.local.set(sessionData);
          }).then(() => {
            const launchMode = msg.flag || msg.mode || 'RUN';
            let sidePanelPath = 'popup/popup.html';
            if (launchMode === 'FLOW') {
                sidePanelPath = 'popup/flow.html';
            } else if (launchMode === 'COMPONENT' || launchMode === 'EDIT_COMPONENT') {
                sidePanelPath = 'popup/component.html';
            }
            return chrome.sidePanel.setOptions({ path: sidePanelPath });
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
        } else if (panelPort !== null || recordingState.size > 0) {
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
      console.log(`[multi-tab][${Date.now()}] START_RECORDING: targetTabId=${targetTabId}, recordingState.has=${recordingState.has(targetTabId)}`);
      if (!targetTabId) {
        sendResponse({ ok: false, error: 'No target tab' });
        break;
      }

      const existingState = recordingState.get(targetTabId);
      const scenarioId = msg.scenarioId || existingState?.scenarioId || 'default';

      if (existingState && existingState.parentTabId !== null) {
        // This is a child tab already set up by onCreated — just mark it active.
        // Never re-allocate its tabRef or parentTabId.
        console.log(`[multi-tab] START_RECORDING for child tab ${targetTabId}, preserving tabRef=${existingState.tabRef}`);
        existingState.isRecording = true;
        existingState.isPaused = false;
        recordingState.set(targetTabId, existingState);
      } else {
        const tabRef = existingState ? existingState.tabRef : allocateNextTabRef(scenarioId);
        const parentTabId = existingState ? existingState.parentTabId : null;
        recordingState.set(targetTabId, {
          scenarioId,
          isRecording: true,
          isPaused: false,
          isVerification: false,
          isHoverCapture: false,
          tabRef,
          parentTabId
        });
      }
      persistWindowState();

      ensureContentScript(targetTabId)
        .then(() => chrome.tabs.sendMessage(targetTabId, { type: msg.type }))
        .catch(() => {});
      sendResponse({ ok: true });
      return true;
    }

    case 'STOP_RECORDING': {
      const scenarioId = msg.scenarioId || 'default';
      const tabsToStop = [];
      for (const [tId, state] of recordingState.entries()) {
        if (state.scenarioId === scenarioId) {
          tabsToStop.push(tId);
          recordingState.delete(tId);
        }
      }
      tabRefCounters.delete(scenarioId);
      persistWindowState();

      for (const tId of tabsToStop) {
        chrome.tabs.sendMessage(tId, { type: msg.type }).catch(() => {});
      }
      sendResponse({ ok: true });
      break;
    }

    case 'GET_RECORDING_STATE': {
      sendResponse(recordingState);
      break;
    }

    case 'UPDATE_LAST_URL': {
      recordingState.lastUrl = msg.url;
      persistWindowState();
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
      const scenarioId = msg.scenarioId || 'default';
      const tabsToPause = [];
      for (const [tId, state] of recordingState.entries()) {
        if (state.scenarioId === scenarioId) {
          state.isPaused = true;
          tabsToPause.push(tId);
        }
      }
      persistWindowState();

      for (const tId of tabsToPause) {
        ensureContentScript(tId)
          .then(() => chrome.tabs.sendMessage(tId, { type: msg.type }))
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
        // Derive a flat recording state summary the popup can consume.
        // recordingState is a Map(tabId → state) — find the entry for the target tab.
        const getRecordingStateSummary = (tabId) => {
          const entry = recordingState.get(tabId);
          return entry
            ? { isRecording: entry.isRecording, isPaused: entry.isPaused, isVerification: entry.isVerification, isHoverCapture: entry.isHoverCapture, tabRef: entry.tabRef }
            : { isRecording: false, isPaused: false, isVerification: false, isHoverCapture: false, tabRef: null };
        };

        // If no target tab, try to find the active tab
        if (!targetTabId) {
          chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
            if (tabs[0]) {
              targetTabId = tabs[0].id;
              persistWindowState();
            }
            ensureContentScript(targetTabId)
              .then(() => sendResponse({ tabId: targetTabId, recordingState: getRecordingStateSummary(targetTabId) }))
              .catch(() => sendResponse({ tabId: targetTabId, recordingState: getRecordingStateSummary(targetTabId) }));
          });
        } else {
          ensureContentScript(targetTabId)
            .then(() => sendResponse({ tabId: targetTabId, recordingState: getRecordingStateSummary(targetTabId) }))
            .catch(() => sendResponse({ tabId: targetTabId, recordingState: getRecordingStateSummary(targetTabId) }));
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
      const tabId = sender.tab?.id;
      const state = recordingState.get(tabId);
      console.log(`[multi-tab][${Date.now()}] STEP_RECORDED: tabId=${tabId}, resolvedState=`, JSON.stringify(state));

      if (!state) {
        console.warn('[multi-tab] STEP_RECORDED from untracked tab, discarding', tabId, msg);
        sendResponse({ ok: false, error: 'untracked tab' });
        break;
      }

      const stepData = msg.data;
      // Merge tabRef from server-side state — content scripts have no knowledge of tabRef
      const enrichedStep = { ...stepData, tabRef: state.tabRef, parentTabId: state.parentTabId };

      // Buffer click for potential new tab relation
      if (enrichedStep.action === 'click') {
        recentClicks.set(tabId, { timestamp: Date.now(), locator: enrichedStep.target });
      }

      const steps = scenarioSteps.get(state.scenarioId) || [];
      steps.push(enrichedStep);
      scenarioSteps.set(state.scenarioId, steps);

      console.log(`[SW] Forwarding STEP_RECORDED to UI for ${state.scenarioId}: tabRef=${enrichedStep.tabRef}`, enrichedStep?.target?.cssSelector);
      const enrichedMsg = { type: 'STEP_RECORDED', data: enrichedStep, scenarioId: state.scenarioId };
      notifyPopupAsync(enrichedMsg).then(delivered => {
        if (!delivered) {
          // Store the ENRICHED message so tabRef survives popup reconnection/drain
          pendingMessages.push(enrichedMsg);
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

// ── Multi-Tab Support (Parent/Child) ──────────────────────────────────────────

function allocateNextTabRef(scenarioId) {
  const count = tabRefCounters.get(scenarioId) || 0;
  tabRefCounters.set(scenarioId, count + 1);
  return `tab_${count}`;
}

function appendStep(scenarioId, stepData) {
  const steps = scenarioSteps.get(scenarioId) || [];
  steps.push(stepData);
  scenarioSteps.set(scenarioId, steps);
  // Forward to popup to append to its UI and save to local storage
  notifyPopupAsync({ type: 'STEP_RECORDED', data: stepData, scenarioId });
}

chrome.tabs.onCreated.addListener((newTab) => {
  console.log(`[multi-tab][${Date.now()}] onCreated: tabId=${newTab.id} opener=${newTab.openerTabId}`);
  let parentTabId = newTab.openerTabId;

  if (!parentTabId) {
    const scanStart = Date.now();
    console.log(`[multi-tab][${scanStart}] onCreated scan start`);
    // Fallback: find the most recent actively-recording tab that had a click
    // in the last 3000 ms.
    const candidates = [...recordingState.entries()]
      .filter(([tabId, state]) => state.isRecording)
      .map(([tabId]) => tabId);

    for (const tabId of candidates) {
      const lastClick = recentClicks.get(tabId);
      if (lastClick && Date.now() - lastClick.timestamp < 3000) {
        parentTabId = tabId;
        break;
      }
    }
    console.log(`[multi-tab][${Date.now()}] onCreated scan end, duration=${Date.now() - scanStart}ms, foundParent=${parentTabId}`);
  }

  if (!parentTabId) {
    console.warn('[multi-tab] New tab created but no recording parent could be resolved', newTab.id);
    return;
  }

  const parentState = recordingState.get(parentTabId);
  if (!parentState?.isRecording) return;

  const nextRef = allocateNextTabRef(parentState.scenarioId);
  
  console.log(`[multi-tab][${Date.now()}] onCreated setting state, pre-existing=${recordingState.has(newTab.id)}, existingVal=`, JSON.stringify(recordingState.get(newTab.id)));
  recordingState.set(newTab.id, {
    scenarioId: parentState.scenarioId,
    isRecording: true,
    isPaused: parentState.isPaused,
    isVerification: false,
    isHoverCapture: false,
    tabRef: nextRef,
    parentTabId,
    createdAt: Date.now(),
  });
  persistWindowState();

  let triggeringElement = null;
  const recentClick = recentClicks.get(parentTabId);
  if (recentClick && (Date.now() - recentClick.timestamp) < 3000) {
    triggeringElement = recentClick.locator;
  }

  appendStep(parentState.scenarioId, {
    action: 'NEW_TAB_OPENED',
    fromTabRef: parentState.tabRef,
    toTabRef: nextRef,
    triggeringElement,
    tabRef: parentState.tabRef,
    timestamp: Date.now()
  });

  beginInjectionWatch(newTab.id);
});

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return; // main frame only
  const state = recordingState.get(details.tabId);
  if (state?.isRecording) {
    clearInjectionWatch(details.tabId);
    ensureContentScript(details.tabId)
      .then(() => chrome.tabs.sendMessage(details.tabId, { type: 'START_RECORDING' }))
      .catch(() => {});
  }
});

const INJECT_TIMEOUT_MS = 10000;

function beginInjectionWatch(tabId) {
  const timeoutId = setTimeout(() => {
    const state = recordingState.get(tabId);
    if (!state) return;
    
    appendStep(state.scenarioId, {
      action: 'TAB_LOAD_TIMEOUT',
      tabRef: state.tabRef,
      message: 'New tab did not finish loading within timeout window',
      timestamp: Date.now()
    });

    notifyPopupAsync({
      type: 'TAB_STUCK_LOADING',
      scenarioId: state.scenarioId,
      tabRef: state.tabRef,
      tabId,
    });
  }, INJECT_TIMEOUT_MS);
  injectionWatches.set(tabId, timeoutId);
}

function clearInjectionWatch(tabId) {
  const t = injectionWatches.get(tabId);
  if (t) {
    clearTimeout(t);
    injectionWatches.delete(tabId);
  }
}
