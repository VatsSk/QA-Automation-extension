'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  flowName: 'New Flow',
  defaultWait: 5,
  urlChangeWait: 2000,
  steps: [],
  isRecording: false,
  isPaused: false,
  isVerificationMode: false,
  isHoverCaptureMode: false,
  targetTabId: null,
  projectId: null,
  moduleId: null,
  flowId: null,
  version: null,
  createdAt: null,
  createdBy: null,
  loginUrl: null,
  authToken: null,
  variables: {} // Dynamic flow variables map: { [name]: { type, length, charset, prefix, suffix } }
};

let undoStack = [];
let redoStack = [];
let _captureInsertIndex = null; // null = append mode, number = insert-at-index mode

// ── DOM Elements ──────────────────────────────────────────────────────────────
const els = {
  flowName: document.getElementById('flow-name'),
  recordingStatus: document.getElementById('recording-status'),
  stepCount: document.getElementById('step-count'),
  defaultWait: document.getElementById('default-wait-input'),
  urlChangeWait: document.getElementById('url-change-wait-input'),
  verificationBanner: document.getElementById('verification-banner'),
  timelineSteps: document.getElementById('timeline-steps'),
  emptyState: document.getElementById('empty-state'),
  btnUndo: document.getElementById('btn-undo'),
  btnRedo: document.getElementById('btn-redo'),
  btnPause: document.getElementById('btn-pause'),
  btnResume: document.getElementById('btn-resume'),
  btnFinish: document.getElementById('btn-finish'),
  btnCancel: document.getElementById('btn-cancel'),
  btnHoverCapture: document.getElementById('btn-hover-capture'),
  btnCaptureUrl: document.getElementById('btn-capture-url'),
  hoverBanner: document.getElementById('hover-banner'),
  autosaveStatus: document.getElementById('autosave-status'),
  btnFlowVariables: document.getElementById('btn-flow-variables'),
  varCountBadge: document.getElementById('var-count-badge'),
  flowVariablesModal: document.getElementById('flow-variables-modal'),
  btnCloseVarsModal: document.getElementById('btn-close-vars-modal'),
  btnOpenAddVar: document.getElementById('btn-open-add-var'),
  btnEmptyAddVar: document.getElementById('btn-empty-add-var'),
  variablesListContainer: document.getElementById('variables-list-container'),
  variablesList: document.getElementById('variables-list'),
  variablesEmpty: document.getElementById('variables-empty'),
  varFormCard: document.getElementById('var-form-card'),
  varFormTitle: document.getElementById('var-form-title'),
  btnCancelVarForm: document.getElementById('btn-cancel-var-form'),
  varInputName: document.getElementById('var-input-name'),
  varInputType: document.getElementById('var-input-type'),
  varInputLength: document.getElementById('var-input-length'),
  varInputCharset: document.getElementById('var-input-charset'),
  varInputPrefix: document.getElementById('var-input-prefix'),
  varInputSuffix: document.getElementById('var-input-suffix'),
  varLivePreview: document.getElementById('var-live-preview'),
  btnRefreshPreview: document.getElementById('btn-refresh-preview'),
  varNameError: document.getElementById('var-name-error'),
  varFormAlert: document.getElementById('var-form-alert'),
  btnDiscardVar: document.getElementById('btn-discard-var'),
  btnSaveVar: document.getElementById('btn-save-var'),
  stepVarAutocomplete: document.getElementById('step-var-autocomplete'),
  stepVarList: document.getElementById('step-var-list'),
  stepVarManageBtn: document.getElementById('step-var-manage-btn'),
  btnFlowSettings: document.getElementById('btn-flow-settings'),
  headerVarBadge: document.getElementById('header-var-badge'),
  flowSettingsModal: document.getElementById('flow-settings-modal'),
  btnCloseSettingsModal: document.getElementById('btn-close-settings-modal'),
  btnDoneSettings: document.getElementById('btn-done-settings'),
  tabBtnGeneral: document.getElementById('tab-btn-general'),
  tabBtnVariables: document.getElementById('tab-btn-variables'),
  tabPaneGeneral: document.getElementById('tab-pane-general'),
  tabPaneVariables: document.getElementById('tab-pane-variables'),
  settingsVarBadge: document.getElementById('settings-var-badge'),
  pillDefaultWait: document.getElementById('pill-default-wait'),
  pillUrlWait: document.getElementById('pill-url-wait'),
  pillVarCount: document.getElementById('pill-var-count'),
  headerSettingsSummary: document.getElementById('header-settings-summary'),
};

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(location.search);
  state.targetTabId = parseInt(params.get('tabId')) || null;

  bindGlobalEvents();
  await loadSession();

  // Wait for background service to initialize and determine targetTabId
  await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'POPUP_INIT' }, (res) => {
      if (res?.tabId && !state.targetTabId) state.targetTabId = res.tabId;
      
      // Restore state from background if available
      if (res?.recordingState) {
        state.isRecording = res.recordingState.isRecording;
        state.isPaused = res.recordingState.isPaused;
        state.isVerificationMode = res.recordingState.isVerification;
        state.isHoverCaptureMode = res.recordingState.isHoverCapture;
      }
      resolve();
    });
  });

  // Start recording immediately if we're not already recording
  if (!state.isRecording) {
    startRecording();
  } else {
    // If we are already in verification mode, ensure the UI reflects it
    if (state.isVerificationMode) {
      els.verificationBanner.classList.remove('hidden');
      els.btnFinish.disabled = true;
    }
  }

  // Process any messages queued while the popup was closed
  chrome.runtime.sendMessage({ type: 'GET_PENDING_MESSAGES' }, (res) => {
    if (res && res.messages) {
      res.messages.forEach(msg => {
        handleIncomingMessage(msg);
      });
    }
  });

  render();
});

// ── Component & Module Cache ──────────────────────────────────────────────────
let _cachedModules = null;
let _cachedComponentsByModule = {};

async function getModules() {
  if (_cachedModules) return _cachedModules;
  if (!state.projectId) {
    const data = await chrome.storage.local.get(['projectId', 'authToken', 'existingFlow']);
    state.projectId = data.projectId || data.existingFlow?.projectId || null;
    state.authToken = state.authToken || data.authToken || null;
  }
  if (!state.projectId) {
    console.warn('[Flow] Cannot fetch modules: state.projectId is missing');
    return [];
  }
  try {
    const res = await window.components.listModules(state.projectId, state.authToken);
    const modules = Array.isArray(res) ? res : (res?.data || res?.modules || []);
    _cachedModules = modules;
    return _cachedModules;
  } catch (err) {
    console.error('[Flow] Failed to list component modules:', err);
    return [];
  }
}

async function getComponentsForModule(moduleId) {
  if (!moduleId) return [];
  if (_cachedComponentsByModule[moduleId]) return _cachedComponentsByModule[moduleId];
  if (!state.projectId) {
    const data = await chrome.storage.local.get(['projectId', 'authToken', 'existingFlow']);
    state.projectId = data.projectId || data.existingFlow?.projectId || null;
    state.authToken = state.authToken || data.authToken || null;
  }
  if (!state.projectId) return [];
  try {
    const res = await window.components.listComponents(state.projectId, moduleId, state.authToken);
    const comps = Array.isArray(res) ? res : (res?.data || res?.components || []);
    _cachedComponentsByModule[moduleId] = comps;
    return _cachedComponentsByModule[moduleId];
  } catch (err) {
    console.error('[Flow] Failed to list components for module ' + moduleId + ':', err);
    return [];
  }
}
function mapFlowItemToLocalStep(item, idx) {
  if (item.type === 'COMPONENT') {
    const compObj = item.component || item.comp || {};
    const compId = item.componentId ||
                   item.compId ||
                   item.component_id ||
                   item.partCompId ||
                   (typeof item.component === 'string' ? item.component : (compObj.id || compObj._id || ''));
    const modId = item.moduleId ||
                  item.compModuleId ||
                  item.module_id ||
                  (typeof item.compModule === 'string' ? item.compModule : (compObj.moduleId || compObj.compModuleId || ''));
    const compName = item.componentName ||
                     item.compName ||
                     item.name ||
                     (typeof compObj === 'object' ? compObj.name : '') ||
                     '';
    const modName = item.moduleName ||
                    item.compModuleName ||
                    (typeof compObj === 'object' ? compObj.moduleName : '') ||
                    '';
    const compDesc = item.description ||
                     item.compDesc ||
                     (typeof compObj === 'object' ? compObj.description : '') ||
                     '';
    return {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 5) + idx,
      type: 'COMPONENT',
      componentId: compId,
      moduleId: modId,
      componentName: compName,
      moduleName: modName,
      description: compDesc,
      isReadOnly: true // Components inside an existing flow are read-only
    };
  } else {
    return mapBackendStepToLocal(item.step || item);
  }
}
async function loadSession() {
  const data = await chrome.storage.local.get(['projectId', 'moduleId', 'flowId', 'version', 'createdAt', 'existingFlow', 'createdBy', 'url', 'authToken', 'flow_draft', 'flowItems']);
  state.projectId = data.projectId || data.existingFlow?.projectId || data.existingFlow?.project_id || null;
  state.moduleId = data.moduleId || data.existingFlow?.moduleId || data.existingFlow?.flowModuleId || null;
  state.flowId = data.flowId || data.existingFlow?.flowId || data.existingFlow?.id || data.existingFlow?._id || null;
  state.version = data.version ?? (data.existingFlow ? data.existingFlow.version : null) ?? null;
  state.createdAt = data.createdAt ?? (data.existingFlow ? data.existingFlow.createdAt : null) ?? null;
  state.createdBy = data.createdBy ?? (data.existingFlow ? data.existingFlow.createdBy : null) ?? null;
  state.loginUrl = data.url;
  state.authToken = data.authToken || data.existingFlow?.authToken || data.existingFlow?.token || null;

  // If a local draft exists for this EXACT same flow, restore it; otherwise do not overwrite existingFlow
  const draft = data.flow_draft;
  if (
    draft &&
    draft.projectId === state.projectId &&
    draft.moduleId === state.moduleId &&
    ((state.flowId && draft.flowId === state.flowId) || (!state.flowId && !draft.flowId && !data.existingFlow))
  ) {
    state.flowName = draft.flowName || 'New Flow';
    state.defaultWait = draft.defaultWait ?? 5;
    state.urlChangeWait = draft.urlChangeWait ?? 2000;
    state.steps = draft.steps || [];
    state.variables = draft.variables || {};
    state.flowId = draft.flowId || state.flowId;
    if (draft.version !== undefined) state.version = draft.version;
    if (draft.createdAt !== undefined) state.createdAt = draft.createdAt;
    if (draft.createdBy !== undefined) state.createdBy = draft.createdBy;
    return;
  }

  if (data.existingFlow) {
    state.flowName = data.existingFlow.name || 'Edit Flow';
    state.defaultWait = data.existingFlow.defaultWait ? (data.existingFlow.defaultWait / 1000) : 5;
    state.urlChangeWait = data.existingFlow.urlChangeWait ?? 2000;
    state.variables = data.existingFlow.variables || {};
    if (data.existingFlow.version !== undefined) state.version = data.existingFlow.version;
    if (data.existingFlow.createdAt !== undefined) state.createdAt = data.existingFlow.createdAt;
    if (data.existingFlow.createdBy !== undefined) state.createdBy = data.existingFlow.createdBy;

    let loadedFromBlueprint = false;

    // Strategy 1: Check existingFlow directly for flowItems in all possible fields and formats
    let directItems = data.existingFlow.flowItems ||
                      data.existingFlow.flow_items ||
                      data.existingFlow.flowInfo?.flowItems ||
                      data.existingFlow.flow_info?.flowItems ||
                      data.existingFlow.blueprint?.flowItems ||
                      data.existingFlow.data?.flowItems ||
                      data.existingFlow.data?.flow_items ||
                      data.flowItems;
    if (typeof directItems === 'string') {
      try { directItems = JSON.parse(directItems); } catch {}
    }
    if (Array.isArray(directItems) && directItems.length > 0) {
      console.log('[Flow] Loading from direct flowItems:', directItems.length);
      state.steps = directItems.map((item, idx) => mapFlowItemToLocalStep(item, idx));
      loadedFromBlueprint = true;
    }

    // Strategy 2: If we have a flowId, fetch the flow-info blueprint from API
    if (!loadedFromBlueprint && state.flowId) {
      try {
        console.log('[Flow] Fetching blueprint from /api/components/flow-info/' + state.flowId);
        const res = await window.components.getFlowInfo(state.flowId, state.authToken);
        if (res) {
          const blueprint = res.data || res;
          let blueprintItems = blueprint.flowItems || blueprint.flow_items;
          if (typeof blueprintItems === 'string') {
            try { blueprintItems = JSON.parse(blueprintItems); } catch {}
          }
          if (Array.isArray(blueprintItems) && blueprintItems.length > 0) {
            console.log('[Flow] Successfully fetched blueprint with', blueprintItems.length, 'flowItems');
            state.steps = blueprintItems.map((item, idx) => mapFlowItemToLocalStep(item, idx));
            loadedFromBlueprint = true;
          }
        }
      } catch (err) {
        console.warn('[Flow] Could not fetch flow-info blueprint:', err.message);
      }
    }

    // Strategy 3: Check if existingFlow.steps contains flattened component steps (isPartComp: true or isComp: true)
    if (!loadedFromBlueprint && Array.isArray(data.existingFlow.steps)) {
      const hasPartComp = data.existingFlow.steps.some(s => s.isPartComp || s.isComp);
      if (hasPartComp) {
        console.log('[Flow] Reconstructing component steps from flattened steps with isPartComp: true');
        const reconstructed = [];
        let activeCompStep = null;

        for (let idx = 0; idx < data.existingFlow.steps.length; idx++) {
          const bStep = data.existingFlow.steps[idx];
          if (bStep.isPartComp || bStep.isComp) {
            const compObj = bStep.component || bStep.comp || {};
            const compId = bStep.componentId ||
                           bStep.compId ||
                           bStep.component_id ||
                           bStep.partCompId ||
                           bStep.partComponentId ||
                           (typeof bStep.component === 'string' ? bStep.component : (compObj.id || compObj._id || ''));
            const compName = bStep.componentName ||
                             bStep.compName ||
                             (typeof compObj === 'object' ? compObj.name : '') ||
                             '';
            const modId = bStep.compModuleId ||
                          bStep.componentModuleId ||
                          (typeof bStep.compModule === 'string' ? bStep.compModule : (compObj.moduleId || compObj.compModuleId || '')) ||
                          (bStep.moduleId && bStep.moduleId !== state.moduleId ? bStep.moduleId : '');
            const modName = bStep.moduleName ||
                            bStep.compModuleName ||
                            (typeof compObj === 'object' ? compObj.moduleName : '') ||
                            '';
            const compDesc = bStep.description ||
                             bStep.compDesc ||
                             (typeof compObj === 'object' ? compObj.description : '') ||
                             '';

            // If we are already grouping into the same component
            if (activeCompStep && (activeCompStep.componentId === compId || !compId)) {
              if (!activeCompStep.componentId && compId) activeCompStep.componentId = compId;
              if (!activeCompStep.componentName && compName) activeCompStep.componentName = compName;
              if (!activeCompStep.moduleId && modId) activeCompStep.moduleId = modId;
              if (!activeCompStep.moduleName && modName) activeCompStep.moduleName = modName;
              if (!activeCompStep.description && compDesc) activeCompStep.description = compDesc;
              continue;
            }

            // Start a new component step
            activeCompStep = {
              id: Date.now().toString() + Math.random().toString(36).substr(2, 5) + idx,
              type: 'COMPONENT',
              componentId: compId,
              componentName: compName,
              moduleId: modId,
              moduleName: modName,
              description: compDesc,
              isReadOnly: true
            };
            reconstructed.push(activeCompStep);
          } else {
            activeCompStep = null;
            reconstructed.push(mapBackendStepToLocal(bStep));
          }
        }
        state.steps = reconstructed;
        loadedFromBlueprint = true;
      }
    }

    // Strategy 4: Regular pure flow without components
    if (!loadedFromBlueprint) {
      state.steps = data.existingFlow.steps ? data.existingFlow.steps.map(mapBackendStepToLocal) : [];
    }
  } else {
    // New flow: add default navigate step
    state.flowName = 'New Flow';
    state.steps = [];
    state.variables = {};
    if (state.loginUrl) {
      state.steps.push({
        id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
        type: 'navigate',
        selector: '',
        value: state.loginUrl,
        advanced: { overrideWait: '', retryCount: 0, continueOnFailure: false, captureScreenshot: true }
      });
    }
  }
}

// ── Listeners ─────────────────────────────────────────────────────────────────
let messageCounter = 0;

// Open a persistent port to the service worker so messages are delivered
// reliably even when the side panel doesn't have focus.
const panelPort = chrome.runtime.connect({ name: 'qa-panel' });
panelPort.onMessage.addListener(handleIncomingMessage);

// Keep the old onMessage listener as a fallback for non-port messages?
// NO! We MUST NOT listen to chrome.runtime.onMessage for STEP_RECORDED, because
// the content script broadcasts it, and the popup will receive the UN-ENRICHED step
// (without tabRef) at the exact same time the SW receives it. The popup will render
// the un-enriched step as tab_0, and then deduplicate and DROP the enriched step
// arriving via the port 1ms later!
// Only listen for other specific messages if necessary, or just rely entirely on the port.
chrome.runtime.onMessage.addListener((msg, sender) => {
  // Ignore raw content script messages that are meant for the SW to enrich
  if (msg.type === 'STEP_RECORDED' || msg.type === 'ELEMENT_CAPTURED') {
    if (!msg.scenarioId) return; // If it doesn't have a scenarioId, it came from content script
  }
  handleIncomingMessage(msg);
});
function handleIncomingMessage(msg) {
  // NOTE: Do NOT filter by _targetTabId here. In multi-tab recording, steps
  // arrive from child tabs whose targetTabId differs from the current state.targetTabId.
  // The SW already ensures only the active recording scenario's steps are forwarded.

  if (msg.type === 'STEP_RECORDED') {
    messageCounter++;
    console.log(`[Flow] Message #${messageCounter} - Received STEP_RECORDED:`, {
      selector: msg.data?.target?.cssSelector,
      action: msg.data?.action,
      tabRef: msg.data?.tabRef,       // ← NEW: log incoming tabRef
      timestamp: Date.now()
    });
  } else {
    console.log('[Flow] Received message:', msg.type);
  }
  
  if (msg.type === 'STEP_RECORDED') {


    // The SW only forwards STEP_RECORDED for actively recording tabs.
    // Do NOT gate on state.isRecording here — in multi-tab mode the popup's
    // own state.isRecording may briefly lag behind the SW's ground truth
    // (e.g. during tab switches), causing child-tab steps to be silently dropped.
    if (!state.isPaused && !state.isVerificationMode) {
      console.log('[Flow] Processing STEP_RECORDED, tabRef=', msg.data?.tabRef);
      addStepFromCapture(msg.data);
    } else {
      console.log('[Flow] Ignoring STEP_RECORDED - paused or verification mode');
    }
  } else if (msg.type === 'ELEMENT_CAPTURED') {
    if (state.isVerificationMode) {
      addVerificationStep(msg.data);
    }
  } else if (msg.type === 'TOGGLE_VERIFICATION_MODE') {
    console.log('[Flow] Shortcut received: TOGGLE_VERIFICATION_MODE');
    toggleVerificationMode();
  } else if (msg.type === 'TOGGLE_HOVER_MODE') {
    console.log('[Flow] Shortcut received: TOGGLE_HOVER_MODE');
    toggleHoverCaptureMode();
  } else if (msg.type === 'TOGGLE_PAUSE_MODE') {
    console.log('[Flow] Shortcut received: TOGGLE_PAUSE_MODE, state.isRecording:', state.isRecording, 'isPaused:', state.isPaused);
    if (state.isRecording) {
      state.isPaused ? resumeRecording() : pauseRecording();
    }
  } else if (msg.type === 'TOGGLE_HOVER_MODE_OFF') {
    state.isHoverCaptureMode = false;
    render();
  } else if (msg.type === 'ADD_FLOW_VARIABLE') {
    if (msg.name && msg.definition) {
      state.variables = state.variables || {};
      state.variables[msg.name] = msg.definition;
      persistDraft();
      syncVariablesToTabs();
      renderVariablesManager();
      updateVariableCountBadge();
    }
  } else if (msg.type === 'URL_CAPTURED') {
    if (state.isRecording && !state.isPaused) {
      console.log('[Flow] Shortcut received: URL_CAPTURED', msg.data.url);
      pushState();
      const step = {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
        type: 'navigate',
        selector: '',
        value: msg.data.url,
        advanced: { overrideWait: '', retryCount: 0, continueOnFailure: false, captureScreenshot: true }
      };
      
      if (_captureInsertIndex !== null) {
        const insertAt = _captureInsertIndex;
        state.steps.splice(insertAt, 0, step);
        _captureInsertIndex = insertAt + 1;
        scheduleAutoSave();
        render();
        scrollToStep(step.id);
      } else {
        state.steps.push(step);
        scheduleAutoSave();
        render();
        scrollToBottom();
      }
    }
  } else if (msg.type === 'TARGET_TAB_CHANGED') {
    const tabActuallyChanged = state.targetTabId !== msg.tabId;
    state.targetTabId = msg.tabId;
    // Only re-send recording commands if the actual target tab switched.
    // Same-tab navigations (refreshes, SPA routes) are handled by the
    // service worker's auto re-injection — no need to double-send.
    // IMPORTANT: pass scenarioId so the SW preserves the existing tabRef
    // for child tabs that were already set up by onCreated.
    if (tabActuallyChanged && state.isRecording && !state.isPaused) {
      chrome.runtime.sendMessage({ type: 'START_RECORDING', tabId: state.targetTabId, scenarioId: state.flowId });
      if (state.isVerificationMode) {
        setTimeout(() => chrome.runtime.sendMessage({ type: 'START_VERIFICATION' }).catch(() => {}), 100);
      }
      if (state.isHoverCaptureMode) {
        setTimeout(() => chrome.runtime.sendMessage({ type: 'START_HOVER_CAPTURE' }).catch(() => {}), 100);
      }
    }
  } else if (msg.type === 'RELOAD_SESSION') {
    loadSession().then(() => {
      startRecording();
      render();
    });
  } else if (msg.type === 'TAB_STUCK_LOADING') {
    showStuckTabBanner(msg.tabRef, msg.tabId);
  }
}

function showStuckTabBanner(tabRef, tabId) {
  let banner = document.getElementById('stuck-tab-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'stuck-tab-banner';
    banner.style.cssText = 'background:var(--danger);color:#fff;padding:8px;font-size:12px;text-align:center;position:relative;margin-bottom:8px;border-radius:4px;';
    const timeline = document.getElementById('timeline-steps');
    timeline.parentNode.insertBefore(banner, timeline);
  }
  banner.innerHTML = `
    ${tabRef} hasn't finished loading — recording will continue if you switch back to another tab.
    <button style="margin-left:8px;background:rgba(0,0,0,0.2);border:none;color:#fff;padding:2px 6px;cursor:pointer;border-radius:3px" onclick="this.parentNode.remove()">Dismiss</button>
  `;
}

// Mock keydown for Ctrl+V globally to enter verification mode
// Also send message to content script to tell it we are in verification mode
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (_captureInsertIndex !== null) { exitInsertMode(); return; }
    if (state.isVerificationMode) { toggleVerificationMode(); return; }
  }
  if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'q') {
    e.preventDefault();
    toggleVerificationMode();
  }
});

// Listen for shortcut commands from the parent ui-injector overlay
window.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'QA_SHORTCUT') return;
  switch (e.data.action) {
    case 'TOGGLE_VERIFICATION': toggleVerificationMode(); break;
    case 'TOGGLE_HOVER': toggleHoverCaptureMode(); break;
    case 'TOGGLE_PAUSE': 
      if (state.isRecording) {
        state.isPaused ? resumeRecording() : pauseRecording();
      }
      break;
  }
});

function toggleVerificationMode() {
  state.isVerificationMode = !state.isVerificationMode;
  // Let content script know so it can prevent default clicks and only send ELEMENT_CAPTURED
  if (state.targetTabId) {
    chrome.runtime.sendMessage({
      type: state.isVerificationMode ? 'START_VERIFICATION' : 'STOP_VERIFICATION'
    }).catch(() => {});
  }
  render();
}

function toggleHoverCaptureMode() {
  state.isHoverCaptureMode = !state.isHoverCaptureMode;
  if (state.targetTabId) {
    chrome.runtime.sendMessage({
      type: state.isHoverCaptureMode ? 'START_HOVER_CAPTURE' : 'STOP_HOVER_CAPTURE'
    }).catch(() => {});
  }
  render();
}

// Notify the parent ui-injector overlay about mode changes for the floating indicator
function notifyParentModes() {
  if (window.parent === window) return; // not in iframe
  try {
    window.parent.postMessage({
      type: 'QA_MODE_CHANGE',
      modes: {
        recording: state.isRecording,
        paused: state.isPaused,
        verification: state.isVerificationMode,
        hover: state.isHoverCaptureMode
      }
    }, '*');
  } catch (_) {}
}

// ── Actions ───────────────────────────────────────────────────────────────────
function pushState() {
  undoStack.push(JSON.stringify(state.steps));
  redoStack = []; // clear redo stack on new action
  scheduleAutoSave();
}

function undo() {
  if (undoStack.length === 0) return;
  redoStack.push(JSON.stringify(state.steps));
  state.steps = JSON.parse(undoStack.pop());
  scheduleAutoSave();
  render();
}

function redo() {
  if (redoStack.length === 0) return;
  undoStack.push(JSON.stringify(state.steps));
  state.steps = JSON.parse(redoStack.pop());
  scheduleAutoSave();
  render();
}

function startRecording() {
  state.isRecording = true;
  state.isPaused = false;
  if (state.targetTabId) {
    chrome.runtime.sendMessage({ type: 'START_RECORDING', tabId: state.targetTabId, scenarioId: state.flowId });
  }
  render();
}

function pauseRecording() {
  state.isPaused = true;
  if (state.targetTabId) {
    chrome.runtime.sendMessage({ type: 'PAUSE_RECORDING', tabId: state.targetTabId, scenarioId: state.flowId });
  }
  render();
}

function resumeRecording() {
  state.isPaused = false;
  if (state.targetTabId) {
    chrome.runtime.sendMessage({ type: 'START_RECORDING', tabId: state.targetTabId, scenarioId: state.flowId });
  }
  render();
}

function stopRecording() {
  state.isRecording = false;
  state.isPaused = false;
  state.isVerificationMode = false;
  state.isHoverCaptureMode = false;
  _captureInsertIndex = null; // exit insert mode
  if (state.targetTabId) {
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING', tabId: state.targetTabId });
  }
  render();
}

// ── UI Utils (Toasts & Modals) ────────────────────────────────────────────────
function showToast(message) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function showModal(title, message, onConfirm) {
  const modal = document.getElementById('custom-modal');
  document.getElementById('custom-modal-title').textContent = title;
  document.getElementById('custom-modal-message').textContent = message;
  
  const confirmBtn = document.getElementById('custom-modal-confirm');
  const cancelBtn = document.getElementById('custom-modal-cancel');
  
  const cleanup = () => {
    modal.classList.add('hidden');
    confirmBtn.removeEventListener('click', handleConfirm);
    cancelBtn.removeEventListener('click', handleCancel);
  };
  
  const handleConfirm = () => { cleanup(); onConfirm(); };
  const handleCancel = () => { cleanup(); };
  
  confirmBtn.addEventListener('click', handleConfirm);
  cancelBtn.addEventListener('click', handleCancel);
  
  modal.classList.remove('hidden');
}

// ── Local draft persistence (chrome.storage.local, no API calls) ───────────────
function setAutosaveStatus(cls, message) {
  const el = els.autosaveStatus;
  if (!el) return;
  el.className = `autosave-status ${cls}`;
  el.textContent = message;
}

function persistDraft() {
  const draft = {
    projectId: state.projectId,
    moduleId: state.moduleId,
    flowId: state.flowId,
    version: state.version !== undefined ? state.version : null,
    createdAt: state.createdAt ?? null,
    createdBy: state.createdBy ?? null,
    flowName: state.flowName,
    defaultWait: state.defaultWait,
    urlChangeWait: state.urlChangeWait,
    variables: state.variables || {},
    steps: state.steps
  };
  chrome.storage.local.set({ flow_draft: draft, flow_variables: state.variables || {} });
  setAutosaveStatus('saved', '✓ Draft saved');
}

function clearLocalDraft() {
  chrome.storage.local.remove('flow_draft');
  setAutosaveStatus('', '');
}

// ── Debounced auto-save — fires 1s after last change ─────────────────────────
let _autoSaveDebounce = null;
function scheduleAutoSave() {
  setAutosaveStatus('saving', '● Saving…');
  clearTimeout(_autoSaveDebounce);
  _autoSaveDebounce = setTimeout(() => {
    persistDraft();
    _autoSaveDebounce = null;
  }, 1000);
}

// Ensure pending saves are flushed immediately if the Side Panel is closed
window.addEventListener('beforeunload', () => {
  if (_autoSaveDebounce !== null) {
    clearTimeout(_autoSaveDebounce);
    persistDraft();
  }
});


// ── Flow Variables Manager & Step Autocomplete ────────────────────────────────

// ── Settings Modal & Tabs Controller ──────────────────────────────────────────
function openSettingsModal(tabName = 'general') {
  if (!els.flowSettingsModal) return;
  switchSettingsTab(tabName);
  els.defaultWait.value = state.defaultWait;
  els.urlChangeWait.value = state.urlChangeWait;
  renderVariablesManager();
  closeVariableForm();
  els.flowSettingsModal.classList.remove('hidden');
}

function closeSettingsModal() {
  if (els.flowSettingsModal) {
    els.flowSettingsModal.classList.add('hidden');
  }
  closeVariableForm();
}

function switchSettingsTab(tabName) {
  if (tabName === 'variables') {
    if (els.tabBtnGeneral) els.tabBtnGeneral.classList.remove('active');
    if (els.tabBtnVariables) els.tabBtnVariables.classList.add('active');
    if (els.tabPaneGeneral) els.tabPaneGeneral.classList.add('hidden');
    if (els.tabPaneVariables) els.tabPaneVariables.classList.remove('hidden');
    renderVariablesManager();
  } else {
    if (els.tabBtnGeneral) els.tabBtnGeneral.classList.add('active');
    if (els.tabBtnVariables) els.tabBtnVariables.classList.remove('active');
    if (els.tabPaneGeneral) els.tabPaneGeneral.classList.remove('hidden');
    if (els.tabPaneVariables) els.tabPaneVariables.classList.add('hidden');
  }
}

function updateSettingsSummaryPills() {
  const varCount = Object.keys(state.variables || {}).length;
  if (els.pillDefaultWait) els.pillDefaultWait.textContent = `⏱️ ${state.defaultWait}s`;
  if (els.pillUrlWait) els.pillUrlWait.textContent = `🔗 ${state.urlChangeWait}ms`;
  if (els.pillVarCount) els.pillVarCount.textContent = `# ${varCount} vars`;
  if (els.settingsVarBadge) els.settingsVarBadge.textContent = varCount;
  if (els.headerVarBadge) {
    els.headerVarBadge.textContent = varCount;
    if (varCount > 0) els.headerVarBadge.classList.remove('hidden');
    else els.headerVarBadge.classList.add('hidden');
  }
}

// ── Variable Token Detection & Visual Chip Renderer ──────────────────────────
function getVariableFromText(val) {
  if (!val || typeof val !== 'string') return null;
  const match = val.match(/#([A-Za-z][A-Za-z0-9_]*)/);
  if (!match) return null;
  const varName = match[1];
  const def = (state.variables && state.variables[varName]) ? state.variables[varName] : null;
  return { varName, def };
}

function updateFieldVariableVisuals(input, clearBtn = null) {
  const control = input.closest('.step-field-control') || input.parentElement;
  if (!control) return;

  if (!clearBtn) clearBtn = control.querySelector('.step-input-clear-btn');

  const rawVal = input.value || '';
  const valInfo = getVariableFromText(rawVal);

  if (clearBtn) {
    if (rawVal.trim()) {
      clearBtn.classList.remove('hidden');
    } else {
      clearBtn.classList.add('hidden');
    }
  }

  if (valInfo) {
    input.classList.add('step-input-variable');
    const { varName, def } = valInfo;
    const preview = def ? generatePreviewValue(def) : '';
    input.title = def
      ? `Flow Variable: #${varName} (${def.type || 'STRING'}) · Sample: ${preview}`
      : `Flow Variable: #${varName}`;
  } else {
    input.classList.remove('step-input-variable');
    input.title = '';
  }
}

// Backward-compatibility wrapper
function updateInputVariableVisuals(input) {
  updateFieldVariableVisuals(input);
}

let editingVariableName = null;
const VARIABLE_NAME_REGEX = /^[A-Za-z][A-Za-z0-9_]*$/;

function validateVariableName(name, existingVars = {}, currentEditingName = null) {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Variable name is required.' };
  }
  const trimmed = name.trim();
  if (trimmed.startsWith('#')) {
    return { valid: false, error: 'Variable name must not include "#" prefix.' };
  }
  if (!VARIABLE_NAME_REGEX.test(trimmed)) {
    return { valid: false, error: 'Name must start with a letter and contain only letters, digits, and underscores (no spaces).' };
  }
  const lower = trimmed.toLowerCase();
  const currentLower = currentEditingName ? currentEditingName.toLowerCase() : null;
  for (const key of Object.keys(existingVars || {})) {
    if (key.toLowerCase() === lower && key.toLowerCase() !== currentLower) {
      return { valid: false, error: `Variable "${trimmed}" already exists (case-insensitive).` };
    }
  }
  return { valid: true, error: null, canonicalName: trimmed };
}

function validateVariableConfig({ name, type, length, charset, prefix, suffix }, existingVars = {}, currentEditingName = null) {
  const nameCheck = validateVariableName(name, existingVars, currentEditingName);
  if (!nameCheck.valid) return nameCheck;

  if (type !== 'STRING' && type !== 'NUMBER') {
    return { valid: false, error: 'Type must be STRING or NUMBER.' };
  }

  const numLen = parseInt(length, 10);
  if (isNaN(numLen) || numLen < 1 || numLen > 256) {
    return { valid: false, error: 'Length must be a positive integer between 1 and 256.' };
  }

  if (type === 'NUMBER') {
    if (charset !== 'DIGITS') {
      return { valid: false, error: 'NUMBER type must have charset DIGITS.' };
    }
  } else {
    if (!['ALPHANUMERIC', 'LETTERS', 'DIGITS'].includes(charset)) {
      return { valid: false, error: 'Charset must be ALPHANUMERIC, LETTERS, or DIGITS.' };
    }
  }

  return {
    valid: true,
    error: null,
    name: nameCheck.canonicalName,
    data: {
      type,
      length: numLen,
      charset,
      prefix: (prefix && prefix.trim()) ? prefix.trim() : null,
      suffix: (suffix && suffix.trim()) ? suffix.trim() : null
    }
  };
}

function generatePreviewValue({ type, length, charset, prefix, suffix }) {
  const len = Math.max(1, Math.min(256, parseInt(length, 10) || 10));
  let chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  if (type === 'NUMBER' || charset === 'DIGITS') {
    chars = '0123456789';
  } else if (charset === 'LETTERS') {
    chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  } else if (charset === 'ALPHANUMERIC') {
    chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  }

  let body = '';
  for (let i = 0; i < len; i++) {
    const idx = Math.floor(Math.random() * chars.length);
    body += chars[idx];
  }
  return `${prefix || ''}${body}${suffix || ''}`;
}

function updateVariableCountBadge() {
  const count = Object.keys(state.variables || {}).length;
  if (els.varCountBadge) {
    els.varCountBadge.textContent = count;
  }
}

function openVariablesModal() {
  openSettingsModal('variables');
}

function closeVariablesModal() {
  closeSettingsModal();
}

function openAddVariableForm() {
  editingVariableName = null;
  els.varFormTitle.textContent = 'New Flow Variable';
  els.varInputName.value = '';
  els.varInputName.disabled = false;
  if (els.varInputType) els.varInputType.value = 'STRING';
  els.varInputLength.value = '10';
  if (els.varInputCharset) {
    els.varInputCharset.value = 'ALPHANUMERIC';
    els.varInputCharset.disabled = false;
  }
  els.varInputPrefix.value = '';
  els.varInputSuffix.value = '';
  els.varNameError.classList.add('hidden');
  els.varFormAlert.classList.add('hidden');
  els.btnSaveVar.disabled = false;
  updateFormLivePreview();
  els.varFormCard.classList.remove('hidden');
  if (els.tabPaneVariables) {
    els.tabPaneVariables.scrollTo({ top: 0, behavior: 'smooth' });
  }
  setTimeout(() => els.varInputName.focus(), 50);
}

function openEditVariableForm(varName) {
  const def = state.variables[varName];
  if (!def) return;
  editingVariableName = varName;
  els.varFormTitle.textContent = `Edit Variable: #${varName}`;
  els.varInputName.value = varName;
  els.varInputName.disabled = false;
  if (els.varInputType) els.varInputType.value = def.type || 'STRING';
  els.varInputLength.value = def.length || 10;
  if (els.varInputCharset) {
    els.varInputCharset.value = def.charset || (def.type === 'NUMBER' ? 'DIGITS' : 'ALPHANUMERIC');
    els.varInputCharset.disabled = false;
  }
  els.varInputPrefix.value = def.prefix || '';
  els.varInputSuffix.value = def.suffix || '';
  els.varNameError.classList.add('hidden');
  els.varFormAlert.classList.add('hidden');
  els.btnSaveVar.disabled = false;
  updateFormLivePreview();
  els.varFormCard.classList.remove('hidden');
  if (els.tabPaneVariables) {
    els.tabPaneVariables.scrollTo({ top: 0, behavior: 'smooth' });
  }
  setTimeout(() => els.varInputName.focus(), 50);
}

function closeVariableForm() {
  if (els.varFormCard) {
    els.varFormCard.classList.add('hidden');
  }
  editingVariableName = null;
}

function updateFormLivePreview() {
  const charset = els.varInputCharset ? els.varInputCharset.value : 'ALPHANUMERIC';
  const type = charset === 'DIGITS' ? 'NUMBER' : 'STRING';
  const length = parseInt(els.varInputLength.value, 10);
  const prefix = els.varInputPrefix.value;
  const suffix = els.varInputSuffix.value;

  const sample = generatePreviewValue({
    type,
    length: isNaN(length) ? 10 : length,
    charset,
    prefix,
    suffix
  });
  if (els.varLivePreview) {
    els.varLivePreview.textContent = sample;
  }

  const name = els.varInputName.value.trim();
  const validation = validateVariableConfig({
    name,
    type,
    length,
    charset,
    prefix,
    suffix
  }, state.variables, editingVariableName);

  if (!validation.valid) {
    els.varFormAlert.textContent = validation.error;
    els.varFormAlert.classList.remove('hidden');
    els.btnSaveVar.disabled = true;
  } else {
    els.varFormAlert.classList.add('hidden');
    els.btnSaveVar.disabled = false;
  }
}

function saveVariableFromForm() {
  const name = els.varInputName.value.trim();
  const charset = els.varInputCharset ? els.varInputCharset.value : 'ALPHANUMERIC';
  const type = charset === 'DIGITS' ? 'NUMBER' : 'STRING';
  const length = parseInt(els.varInputLength.value, 10);
  const prefix = els.varInputPrefix.value;
  const suffix = els.varInputSuffix.value;

  const validation = validateVariableConfig({
    name,
    type,
    length,
    charset,
    prefix,
    suffix
  }, state.variables, editingVariableName);

  if (!validation.valid) {
    els.varFormAlert.textContent = validation.error;
    els.varFormAlert.classList.remove('hidden');
    return;
  }

  state.variables = state.variables || {};

  // If renaming an existing variable, update references across steps
  if (editingVariableName && editingVariableName !== validation.name) {
    delete state.variables[editingVariableName];
    const oldToken = `#${editingVariableName}`;
    const newToken = `#${validation.name}`;
    state.steps.forEach((step) => {
      if (typeof step.value === 'string' && step.value.includes(oldToken)) {
        step.value = step.value.split(oldToken).join(newToken);
      }
    });
  }

  state.variables[validation.name] = validation.data;
  closeVariableForm();
  renderVariablesManager();
  updateVariableCountBadge();
  persistDraft();
  syncVariablesToTabs();
  render();
}

function deleteVariable(varName) {
  const token = `#${varName}`;
  const usedCount = state.steps.filter(s => typeof s.value === 'string' && s.value.includes(token)).length;
  const confirmMsg = usedCount > 0
    ? `Variable "${token}" is currently referenced in ${usedCount} step(s). Are you sure you want to delete it?`
    : `Are you sure you want to delete variable "${token}"?`;

  showModal('Delete Variable', confirmMsg, () => {
    delete state.variables[varName];
    renderVariablesManager();
    updateVariableCountBadge();
    persistDraft();
    syncVariablesToTabs();
  });
}

function syncVariablesToTabs() {
  chrome.storage.local.set({ flow_variables: state.variables || {} });
  chrome.runtime.sendMessage({
    type: 'SYNC_VARIABLES',
    variables: state.variables || {}
  }, () => {
    if (chrome.runtime.lastError) {}
  });
  if (state.targetTabId) {
    chrome.tabs.sendMessage(state.targetTabId, {
      type: 'SYNC_VARIABLES',
      variables: state.variables || {}
    }).catch(() => {});
  }
}

function renderVariablesManager() {
  updateVariableCountBadge();
  if (!els.variablesList || !els.variablesEmpty) return;

  const keys = Object.keys(state.variables || {});
  if (keys.length === 0) {
    els.variablesEmpty.classList.remove('hidden');
    els.variablesList.innerHTML = '';
    return;
  }

  els.variablesEmpty.classList.add('hidden');
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  let html = '';
  keys.forEach((varName) => {
    const def = state.variables[varName];
    const isNum = def.type === 'NUMBER';
    const typeBadgeClass = isNum ? 'var-badge-number' : 'var-badge-string';
    const sample = generatePreviewValue(def);

    html += `
      <div class="var-card" data-name="${esc(varName)}">
        <div class="var-card-top">
          <div class="var-name-group">
            <div class="var-name-row">
              <span class="var-token" title="#${esc(varName)}">#${esc(varName)}</span>
            </div>
            <div class="var-badges-row">
              <span class="var-badge ${typeBadgeClass}">${esc(def.type || 'STRING')}</span>
              <span class="var-badge var-badge-detail">len: ${def.length || 10}</span>
              <span class="var-badge var-badge-detail">${esc(def.charset || (isNum ? 'DIGITS' : 'ALPHANUMERIC'))}</span>
              ${def.prefix ? `<span class="var-badge var-badge-detail" title="Prefix: ${esc(def.prefix)}">pre: "${esc(def.prefix)}"</span>` : ''}
              ${def.suffix ? `<span class="var-badge var-badge-detail" title="Suffix: ${esc(def.suffix)}">suf: "${esc(def.suffix)}"</span>` : ''}
            </div>
          </div>
          <div class="var-card-actions">
            <button type="button" class="var-btn-action edit" data-name="${esc(varName)}" title="Edit Variable">✏️</button>
            <button type="button" class="var-btn-action delete" data-name="${esc(varName)}" title="Delete Variable">🗑️</button>
          </div>
        </div>
        <div class="var-preview-line" title="Sample: ${esc(sample)}">
          <span class="var-preview-label">Sample:</span>
          <span class="var-preview-val">${esc(sample)}</span>
        </div>
      </div>
    `;
  });

  els.variablesList.innerHTML = html;

  els.variablesList.querySelectorAll('.var-btn-action.edit').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditVariableForm(btn.dataset.name);
    });
  });

  els.variablesList.querySelectorAll('.var-btn-action.delete').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteVariable(btn.dataset.name);
    });
  });
}

// ── Step Editor In-Extension # Autocomplete ──────────────────────────────────
let activeAutocompleteInput = null;

function hideStepAutocomplete() {
  if (els.stepVarAutocomplete) {
    els.stepVarAutocomplete.classList.add('hidden');
    els.stepVarAutocomplete.style.display = 'none';
  }
  activeAutocompleteInput = null;
}

function attachStepAutocomplete(input, step, fieldName) {
  if (input._hasStepAutocomplete) return;
  input._hasStepAutocomplete = true;

  let isPopoverOpen = false;
  let activeQuery = '';
  let queryStart = -1;
  let selectedIdx = 0;
  let matches = [];

  function getStepMatches(query) {
    const all = Object.keys(state.variables || {});
    if (!query) return all;
    const q = query.toLowerCase();
    const starts = [];
    const contains = [];
    for (const name of all) {
      const lower = name.toLowerCase();
      if (lower.startsWith(q)) starts.push(name);
      else if (lower.includes(q)) contains.push(name);
    }
    return [...starts, ...contains];
  }

  function hidePopover() {
    isPopoverOpen = false;
    if (activeAutocompleteInput === input) {
      hideStepAutocomplete();
    }
  }

  function showPopover() {
    activeAutocompleteInput = input;
    matches = getStepMatches(activeQuery);
    selectedIdx = 0;
    renderStepPopover();
    positionStepPopover();
    els.stepVarAutocomplete.classList.remove('hidden');
    els.stepVarAutocomplete.style.display = 'flex';
    isPopoverOpen = true;
  }

  function positionStepPopover() {
    const rect = input.getBoundingClientRect();
    const popWidth = Math.min(240, Math.max(180, Math.round(rect.width)));
    let top = rect.bottom + 3;
    let left = rect.left;
    if (left + popWidth > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - popWidth - 8);
    }
    if (top + 180 > window.innerHeight) {
      top = Math.max(8, rect.top - 184);
    }
    els.stepVarAutocomplete.style.width = `${popWidth}px`;
    els.stepVarAutocomplete.style.top = `${top}px`;
    els.stepVarAutocomplete.style.left = `${left}px`;
  }

  function renderStepPopover() {
    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    let html = '';
    if (matches.length === 0) {
      html = `<div style="padding: 8px 10px; color: var(--text-muted); text-align: center; font-size: 11px;">No variables matching "#${esc(activeQuery)}"</div>`;
    } else {
      matches.forEach((name, idx) => {
        const def = state.variables[name] || {};
        const isSel = idx === selectedIdx;
        const isNum = def.type === 'NUMBER';
        const typeClass = isNum ? 'var-badge-number' : 'var-badge-string';
        const typeLabel = isNum ? 'NUM' : 'STR';
        const preview = def ? generatePreviewValue(def) : '';
        html += `
          <div class="step-var-item ${isSel ? 'is-selected' : ''}" data-name="${esc(name)}" title="Variable: #${esc(name)}${preview ? ' · Sample: ' + esc(preview) : ''}">
            <div class="step-var-item-name">
              <span class="hash">#</span><span>${esc(name)}</span>
            </div>
            <span class="var-badge ${typeClass}">${typeLabel}</span>
          </div>
        `;
      });
    }
    els.stepVarList.innerHTML = html;

    els.stepVarList.querySelectorAll('.step-var-item').forEach((item) => {
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const varName = item.dataset.name;
        if (varName) insertVarIntoInput(varName);
      });
    });
  }

  function insertVarIntoInput(varName) {
    const text = input.value || '';
    let before = text.slice(0, queryStart);
    let after = text.slice(input.selectionStart);

    // Strip accidental leading whitespace before the variable so it never leaves an empty space before #
    if (!before.trim()) {
      before = '';
    } else {
      before = before.trimEnd() + ' ';
    }
    if (!after.trim()) {
      after = '';
    }

    const newValue = (before + '#' + varName + after).trimStart();
    input.value = newValue;
    const newPos = before.length + 1 + varName.length;
    try {
      input.setSelectionRange(newPos, newPos);
    } catch (_) {}
    step[fieldName] = newValue;
    updateFieldVariableVisuals(input);
    pushState();
    scheduleAutoSave();
    hidePopover();
  }

  input.addEventListener('input', () => {
    const text = input.value || '';
    const caret = input.selectionStart;
    const textBefore = text.slice(0, caret);
    const match = textBefore.match(/(?:^|[^\w])#([A-Za-z0-9_]*)$/);
    if (match) {
      activeQuery = match[1];
      queryStart = caret - activeQuery.length - 1;
      showPopover();
    } else {
      hidePopover();
    }
  });

  input.addEventListener('keydown', (e) => {
    if (!isPopoverOpen) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIdx = (selectedIdx + 1) % Math.max(1, matches.length);
      renderStepPopover();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIdx = (selectedIdx - 1 + matches.length) % Math.max(1, matches.length);
      renderStepPopover();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (matches[selectedIdx]) {
        e.preventDefault();
        insertVarIntoInput(matches[selectedIdx]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hidePopover();
    }
  });

  input.addEventListener('blur', () => {
    setTimeout(hidePopover, 220);
  });
}

// ── Mappers ───────────────────────────────────────────────────────────────────
function mapLocalStepToBackend(step, index) {
  const actionTypeMap = {
    navigate: 'NAVIGATE', click: 'CLICK', type: 'TYPE', select: 'SELECT',
    checkbox: 'CHECKBOX', upload: 'FILE_UPLOAD', date: 'DATE', hover: 'HOVER', verify: 'VERIFY',
    URL_CHANGE: 'URL_CHANGE',
    NEW_TAB_OPENED: 'SWITCH_TO_NEW_TAB', TAB_LOAD_TIMEOUT: 'TAB_LOAD_TIMEOUT', SWITCH_TAB: 'SWITCH_TAB'
  };
  const verTypeMap = {
    'Visible': 'VISIBLE', 'Not Visible': 'NOT_VISIBLE', 'Exists': 'EXISTS', 'Not Exists': 'NOT_EXISTS', 'Image Source': 'IMAGE', 'Alt Text': 'ATTRIBUTE',
    'Value': 'VALUE', 'Enabled': 'ENABLED', 'Disabled': 'DISABLED', 'Checked': 'CHECKED', 'Unchecked': 'UNCHECKED', 'Text Equals': 'TEXT',
    'Contains': 'CONTAINS', 'Text Not Equals': 'NOT_EQUALS', 'Tooltip Text': 'TOOLTIP', 'Selected Value': 'SELECTED_VALUE'
  };

  // ── INFO step — documentation only, not executable ────────────────────────
  // Sent to backend with actionType: 'INFO' and description. No locator/wait.
  if (step.type === 'INFO') {
    return {
      stepOrder: index + 1,
      name: `Step ${index + 1}`,
      actionType: 'INFO',
      description: step.description || ''
    };
  }

  const isVerify = step.type === 'verify';
  const isUrlChange = step.type === 'URL_CHANGE';
  
  if (isUrlChange) {
    return {
      stepOrder: index + 1,
      name: `Step ${index + 1}`,
      actionType: 'URL_CHANGE',
      url: step.url,
      wait: step.wait != null ? step.wait : (parseInt(state.urlChangeWait, 10) || 2000)
    };
  }

  return {
    stepOrder: index + 1,
    name: `Step ${index + 1}`,
    actionType: actionTypeMap[step.type] || 'CLICK',
    verificationType: isVerify ? (verTypeMap[step.verificationType] || 'VISIBLE') : null,
    selector: step.selector,
    value: isVerify ? null : step.value,
    expectedValue: isVerify ? step.value : null,
    textSource: step.textSource || null,
    attribute: step.verificationType === 'Alt Text' ? 'alt' : null,
    overrideWait: !!step.advanced.overrideWait,
    wait: step.advanced.overrideWait ? (parseInt(step.advanced.overrideWait) * 1000) : null,
    retryCount: parseInt(step.advanced.retryCount) || 0,
    continueOnFailure: step.advanced.continueOnFailure,
    captureScreenshot: step.advanced.captureScreenshot,
    tabRef: (step.type === 'NEW_TAB_OPENED' || step.type === 'SWITCH_TAB' || step.type === 'TAB_LOAD_TIMEOUT') ? step.tabRef : undefined,
    fromTabRef: step.fromTabRef || null,
    toTabRef: step.toTabRef || null,
    message: step.message || null,
    triggeringElement: step.triggeringElement || null
  };
}

function mapBackendStepToLocal(bStep) {
  const localTypeMap = {
    NAVIGATE: 'navigate', CLICK: 'click', TYPE: 'type', SELECT: 'select',
    CHECKBOX: 'checkbox', FILE_UPLOAD: 'upload', DATE: 'date', HOVER: 'hover', VERIFY: 'verify',
    URL_CHANGE: 'URL_CHANGE',
    NEW_TAB_OPENED: 'NEW_TAB_OPENED', SWITCH_TO_NEW_TAB: 'NEW_TAB_OPENED', TAB_LOAD_TIMEOUT: 'TAB_LOAD_TIMEOUT', SWITCH_TAB: 'SWITCH_TAB'
  };
  const localVerMap = {
    VISIBLE: 'Visible', NOT_VISIBLE: 'Not Visible', EXISTS: 'Exists', NOT_EXISTS: 'Not Exists', IMAGE: 'Image Source', ATTRIBUTE: 'Alt Text',
    VALUE: 'Value', ENABLED: 'Enabled', DISABLED: 'Disabled', CHECKED: 'Checked', UNCHECKED: 'Unchecked', TEXT: 'Text Equals',
    CONTAINS: 'Contains', NOT_EQUALS: 'Text Not Equals', TOOLTIP: 'Tooltip Text', SELECTED_VALUE: 'Selected Value'
  };

  // ── INFO step — restore documentation step from backend ───────────────────
  if ((bStep.actionType || '').toUpperCase() === 'INFO') {
    return {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
      type: 'INFO',
      description: bStep.description || ''
    };
  }

  if (bStep.actionType === 'URL_CHANGE') {
    return {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
      type: 'URL_CHANGE',
      url: bStep.url || bStep.value,
      wait: bStep.wait != null ? bStep.wait : (parseInt(state.urlChangeWait, 10) || 2000),
      advanced: {
        overrideWait: bStep.overrideWait ? String((bStep.wait || 0) / 1000) : '',
        retryCount: bStep.retryCount || 0,
        continueOnFailure: bStep.continueOnFailure || false,
        captureScreenshot: bStep.captureScreenshot ?? true
      }
    };
  }

  if (bStep.actionType === 'URL_CHANGE') {
    return {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
      type: 'URL_CHANGE',
      url: bStep.url || bStep.value,
      wait: bStep.wait != null ? bStep.wait : (parseInt(state.urlChangeWait, 10) || 2000),
      advanced: {
        overrideWait: bStep.overrideWait ? String((bStep.wait || 0) / 1000) : '',
        retryCount: bStep.retryCount || 0,
        continueOnFailure: bStep.continueOnFailure || false,
        captureScreenshot: bStep.captureScreenshot ?? true
      }
    };
  }

  return {
    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
    type: localTypeMap[(bStep.actionType || '').toUpperCase()] || 'click',
    selector: bStep.selector || '',
    verificationType: (bStep.actionType || '').toUpperCase() === 'VERIFY' ? (localVerMap[(bStep.verificationType || '').toUpperCase()] || localVerMap[bStep.verificationType] || 'Visible') : null,
    value: (bStep.actionType || '').toUpperCase() === 'VERIFY' ? (bStep.expectedValue || '') : (bStep.value || ''),
    textSource: bStep.textSource || 'text',
    tabRef: bStep.tabRef || undefined,
    fromTabRef: bStep.fromTabRef || null,
    toTabRef: bStep.toTabRef || null,
    message: bStep.message || null,
    triggeringElement: bStep.triggeringElement || null,
    advanced: {
      overrideWait: bStep.overrideWait ? String((bStep.wait || 0) / 1000) : '',
      retryCount: bStep.retryCount || 0,
      continueOnFailure: bStep.continueOnFailure || false,
      captureScreenshot: bStep.captureScreenshot ?? true
    }
  };
}

// ── Intelligence ──────────────────────────────────────────────────────────────
function mapActionToStepType(data) {
  if (data.action === 'NEW_TAB_OPENED') return 'NEW_TAB_OPENED';
  if (data.action === 'TAB_LOAD_TIMEOUT') return 'TAB_LOAD_TIMEOUT';
  if (data.action === 'SWITCH_TAB') return 'SWITCH_TAB';
  
  const tag = (data.target?.tag || '').toLowerCase();
  const inputType = (data.target?.attributes?.type || '').toLowerCase();
  
  if (data.action === 'URL_CHANGE') return 'URL_CHANGE';
  if (data.action === 'navigate') return 'navigate';
  if (data.action === 'hover') return 'hover';
  if (data.action === 'type' || data.action === 'keydown') return 'type';
  if (tag === 'select' || data.action === 'select') return 'select';
  if (tag === 'input' && (inputType === 'checkbox' || inputType === 'radio' || data.action === 'check')) return 'checkbox';
  if (tag === 'input' && inputType === 'file') return 'upload';
  if (tag === 'input' && (inputType === 'date' || inputType === 'datetime-local')) return 'date';
  
  return 'click'; // default fallback
}

function getSuggestedVerification(elData) {
  const tag = (elData.tag || '').toLowerCase();
  if (tag === 'img') return 'Visible';
  if (tag === 'input' && elData.attributes?.type === 'checkbox') return elData.checked === false ? 'Unchecked' : 'Checked';
  if (tag === 'select') return 'Selected Value';
  
  // Default to Text Equals for inputs, buttons, labels, etc.
  return 'Text Equals';
}

// Deduplication: track last recorded step
let lastRecordedStep = { selector: '', type: '', value: '', timestamp: 0 };

function addStepFromCapture(data) {
  const type = mapActionToStepType(data);
  const selector = data.target?.cssSelector || 'System Event';
  const value = data.value || '';

  // System-generated synthetic events (e.g. NEW_TAB_OPENED, TAB_LOAD_TIMEOUT) must
  // never be deduplicated strictly by time — they fire immediately after a user action by design,
  // so their Δt is always < 400ms, which would cause the debounce to drop them.
  const isSystemEvent = type === 'NEW_TAB_OPENED' || type === 'TAB_LOAD_TIMEOUT' || type === 'SWITCH_TAB' || type === 'URL_CHANGE';

  // Prevent identical consecutive URL_CHANGE steps
  const lastStep = state.steps.length > 0 ? state.steps[state.steps.length - 1] : null;
  if (type === 'URL_CHANGE' && lastStep && lastStep.type === 'URL_CHANGE' && lastStep.url === value) {
    console.log('[Flow] Duplicate URL_CHANGE step ignored:', value);
    return;
  }

  if (!isSystemEvent) {
    // Prevent duplicate steps by comparing actual capture time from content script
    const eventTime = data.timestamp || Date.now();
    const timeSinceLastStep = eventTime - lastRecordedStep.timestamp;

    // 1. Strict global debounce (ignore ANYTHING within 400ms of last step)
    // 2. Exact match debounce (ignore exact same action within 1000ms)
    const isDuplicate =
      timeSinceLastStep < 400 ||
      (
        lastRecordedStep.selector === selector &&
        lastRecordedStep.type === type &&
        lastRecordedStep.value === value &&
        timeSinceLastStep < 1000
      );

    if (isDuplicate) {
      console.log('[Flow] Duplicate step ignored:', {
        type,
        selector,
        value,
        timeSinceLastStep
      });
      return;
    }

    // Update last recorded step (only for real user actions, not synthetic events)
    lastRecordedStep = { selector, type, value, timestamp: eventTime };
  }

  console.log('[Flow] addStepFromCapture → incoming data.tabRef:', data.tabRef, '| type:', type);

  const step = {
    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
    type: type,
    selector: selector,
    value: value,
    fromTabRef: data.fromTabRef,
    toTabRef: data.toTabRef,
    message: data.message,
    triggeringElement: data.triggeringElement,
    advanced: { overrideWait: '', retryCount: 0, continueOnFailure: false, captureScreenshot: true }
  };

  if (type === 'URL_CHANGE') {
    step.url = value;
    step.wait = parseInt(state.urlChangeWait, 10) || 2000;
    delete step.tabRef;
  }

  if (isSystemEvent && type !== 'URL_CHANGE') {
    step.tabRef = data.tabRef || 'tab_0';
  }

  console.log('[Flow] addStepFromCapture → step.tabRef resolved to:', step.tabRef);
  
  if (type === 'URL_CHANGE') {
    step.url = data.url;
    step.wait = parseInt(state.urlChangeWait, 10) || 2000;
  }
  
  pushState();
  if (_captureInsertIndex !== null) {
    const insertAt = _captureInsertIndex;
    state.steps.splice(insertAt, 0, step);
    _captureInsertIndex = insertAt + 1; // next capture goes right after this one
    scheduleAutoSave();
    render();
    scrollToStep(step.id);
  } else {
    state.steps.push(step);
    scheduleAutoSave();
    render();
    scrollToBottom();
  }
}

function addVerificationStep(elData) {
  const selector = elData.cssSelector || 'Unknown Element';
  const verType = getSuggestedVerification(elData);
  let expectedValue = '';
  let textSource = 'text';
  if (verType === 'Text Equals') {
    if (elData.value) {
      expectedValue = elData.value;
      textSource = 'value';
    } else if (elData.text) {
      expectedValue = elData.text;
      textSource = 'text';
    } else if (elData.placeholder) {
      expectedValue = elData.placeholder;
      textSource = 'placeholder';
    }
  } else if (['Value', 'Selected Value', 'Image Source', 'Alt Text'].includes(verType)) {
    expectedValue = elData.value || elData.text || '';
  }
  
  const eventTime = elData.timestamp || Date.now();
  const timeSinceLastStep = eventTime - lastRecordedStep.timestamp;
  const isDuplicate = 
    timeSinceLastStep < 400 || 
    (
      lastRecordedStep.selector === selector &&
      lastRecordedStep.type === 'verify' &&
      lastRecordedStep.verificationType === verType &&
      lastRecordedStep.value === expectedValue &&
      timeSinceLastStep < 1000
    );
    
  if (isDuplicate) return;
  
  lastRecordedStep = { selector, type: 'verify', verificationType: verType, value: expectedValue, timestamp: eventTime, textSource };
  
  const step = {
    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
    type: 'verify',
    selector: selector,
    verificationType: verType,
    value: expectedValue,
    textSource: textSource,
    advanced: { overrideWait: '', retryCount: 0, continueOnFailure: false, captureScreenshot: true }
  };
  
  pushState();
  if (_captureInsertIndex !== null) {
    const insertAt = _captureInsertIndex;
    state.steps.splice(insertAt, 0, step);
    _captureInsertIndex = insertAt + 1;
    scheduleAutoSave();
    render();
    scrollToStep(step.id);
  } else {
    state.steps.push(step);
    scheduleAutoSave();
    render();
    scrollToBottom();
  }
}

function scrollToBottom() {
  setTimeout(() => {
    const container = document.getElementById('timeline-container');
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, 50);
}

function scrollToStep(stepId) {
  if (!stepId) return;
  setTimeout(() => {
    const container = document.getElementById('timeline-container');
    if (!container) return;

    const isLastStep = state.steps.length > 0 && state.steps[state.steps.length - 1].id === stepId;
    if (isLastStep) {
      container.scrollTop = container.scrollHeight;
      return;
    }

    const card = els.timelineSteps ? els.timelineSteps.querySelector(`[data-id="${stepId}"]`) : null;
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, 60);
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function render() {
  const container = document.getElementById('timeline-container');
  const prevScrollTop = container ? container.scrollTop : 0;
  els.flowName.value = state.flowName;
  els.stepCount.textContent = `${state.steps.length} Steps Recorded`;
  updateVariableCountBadge();
  updateSettingsSummaryPills();
  els.defaultWait.value = state.defaultWait;
  els.urlChangeWait.value = state.urlChangeWait;
  
  if (state.steps.length === 0) {
    els.emptyState.classList.remove('hidden');
    els.timelineSteps.innerHTML = '';
    // Show a single inserter even when empty
    els.timelineSteps.appendChild(createInserterRow(0));
  } else {
    els.emptyState.classList.add('hidden');
    els.timelineSteps.innerHTML = '';
    // Inserter before the first step
    els.timelineSteps.appendChild(createInserterRow(0));
    state.steps.forEach((step, index) => {
      els.timelineSteps.appendChild(createStepCard(step, index));
      // Inserter after every step
      els.timelineSteps.appendChild(createInserterRow(index + 1));
    });
  }

  els.btnUndo.disabled = undoStack.length === 0;
  els.btnRedo.disabled = redoStack.length === 0;
  
  if (!state.isRecording) {
    els.recordingStatus.classList.remove('recording');
    els.recordingStatus.querySelector('.status-text').textContent = 'Finished';
    els.recordingStatus.querySelector('.status-dot').style.display = 'none';
    els.btnPause.classList.add('hidden');
    els.btnResume.classList.add('hidden');
    els.btnFinish.disabled = true;
    els.btnHoverCapture.disabled = true;
    els.btnCaptureUrl.disabled = true;
  } else if (state.isPaused) {
    els.recordingStatus.classList.remove('recording');
    els.recordingStatus.querySelector('.status-text').textContent = 'Paused';
    els.recordingStatus.querySelector('.status-dot').style.display = 'none';
    els.btnPause.classList.add('hidden');
    els.btnResume.classList.remove('hidden');
    els.btnFinish.disabled = false;
    els.btnHoverCapture.disabled = true;
    els.btnCaptureUrl.disabled = true;
  } else {
    els.recordingStatus.classList.add('recording');
    els.recordingStatus.querySelector('.status-text').textContent = 'Recording';
    els.recordingStatus.querySelector('.status-dot').style.display = 'inline';
    els.btnPause.classList.remove('hidden');
    els.btnResume.classList.add('hidden');
    els.btnFinish.disabled = false;
    els.btnHoverCapture.disabled = false;
    els.btnCaptureUrl.disabled = false;
  }
  
  if (state.isVerificationMode) {
    els.verificationBanner.classList.remove('hidden');
  } else {
    els.verificationBanner.classList.add('hidden');
  }
  
  if (state.isHoverCaptureMode) {
    els.hoverBanner.classList.remove('hidden');
  } else {
    els.hoverBanner.classList.add('hidden');
  }

  // Notify parent overlay about mode state for floating indicator
  notifyParentModes();
  if (container && prevScrollTop > 0) {
    container.scrollTo({ top: prevScrollTop, behavior: 'instant' });
    requestAnimationFrame(() => {
      container.scrollTo({ top: prevScrollTop, behavior: 'instant' });
    });
  }
}

function getStepConfig(type) {
  const configs = {
    navigate: { icon: '🌐', title: 'Open URL' },
    type:     { icon: '⌨️', title: 'Type' },
    select:   { icon: '📋', title: 'Select' },
    checkbox: { icon: '☑',  title: 'Checkbox' },
    click:    { icon: '🖱', title: 'Click' },
    hover:    { icon: '🖐', title: 'Hover' },
    upload:   { icon: '📂', title: 'Upload' },
    date:     { icon: '📅', title: 'Date Picker' },
    verify:   { icon: '🔍', title: 'Verify' },
    wait:     { icon: '⏳', title: 'Wait' },
    NEW_TAB_OPENED: { icon: '🗔', title: 'New Tab Opened' },
    SWITCH_TAB: { icon: '🔄', title: 'Switch Tab' },
    TAB_LOAD_TIMEOUT: { icon: '⏱️', title: 'Tab Load Timeout' },
    URL_CHANGE: { icon: '🔗', title: 'URL Changed' }
    // NOTE: INFO is NOT in this map — it has its own dedicated renderer (createInfoStepCard)
  };
  return configs[type] || { icon: '⚡', title: 'Action' };
}

// ── Step Inserter ─────────────────────────────────────────────────────────────
// Creates the thin row between steps with the + button.
// Clicking immediately starts page-capture at that index — no panel/modal.
// Also includes an "ⓘ Info" button that inserts an INFO step directly.
function createInserterRow(atIndex) {
  const row = document.createElement('div');
  row.className = 'step-inserter';
  const isActive = _captureInsertIndex !== null && _captureInsertIndex === atIndex;
  row.innerHTML = `
    <div class="inserter-line"></div>
    <button class="inserter-btn${isActive ? ' active' : ''}" title="Capture step from page here">
      ${isActive ? '●' : '+'}
    </button>
    <div class="inserter-line"></div>
  `;
  row.querySelector('.inserter-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    captureNextAt(atIndex);
  });

  // ⓘ Information button — inserts an INFO step without touching recording state
  const infoBtn = document.createElement('button');
  infoBtn.className = 'inserter-info-btn';
  infoBtn.title = 'Add a documentation/context step (not executed)';
  infoBtn.innerHTML = 'ⓘ&nbsp;Info';
  infoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showInfoDialog({
      title: 'Add Test Information',
      confirmLabel: 'Add Information',
      initialValue: '',
      atIndex: atIndex
    }, (text) => {
      pushState();
      const step = {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
        type: 'INFO',
        description: text
      };
      state.steps.splice(atIndex, 0, step);
      scheduleAutoSave();
      render();
      scrollToStep(step.id);
    });
  });
  row.appendChild(infoBtn);

  // 🧩 Component button — inserts a reusable COMPONENT step directly into the timeline
  const compBtn = document.createElement('button');
  compBtn.className = 'inserter-comp-btn';
  compBtn.title = 'Add a reusable component step';
  compBtn.innerHTML = '🧩&nbsp;Component';
  compBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    pushState();
    const step = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
      type: 'COMPONENT',
      moduleId: '',
      moduleName: '',
      componentId: '',
      componentName: ''
    };
    state.steps.splice(atIndex, 0, step);
    scheduleAutoSave();
    render();
    scrollToStep(step.id);
  });
  row.appendChild(compBtn);

  return row;
}

// ── Capture-insert mode ───────────────────────────────────────────────────────
// _captureInsertIndex: null = normal append mode, number = insert-at mode

function captureNextAt(index) {
  if (_captureInsertIndex === index) {
    exitInsertMode();
    return;
  }
  _captureInsertIndex = index;
  // Ensure recording is running so the page captures the next action
  if (!state.isRecording || state.isPaused) {
    state.isRecording = true;
    state.isPaused = false;
    if (state.targetTabId) {
      chrome.runtime.sendMessage({ type: 'START_RECORDING', tabId: state.targetTabId, scenarioId: state.flowId });
    }
  }
  // Show the active inserter highlight
  render();
}

function exitInsertMode() {
  _captureInsertIndex = null;
  render();
}



function createValueFieldRow(label, step, fieldName = 'value', placeholder = 'Value or type # for variable...') {
  const row = document.createElement('div');
  row.className = 'step-field-row';
  let val = step[fieldName] || '';
  if (typeof val === 'string' && val.trim().startsWith('#') && val.startsWith(' ')) {
    val = val.trim();
    step[fieldName] = val;
  }
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  
  row.innerHTML = `
    <div class="step-field-label">${label}</div>
    <div class="step-field-control">
      <div class="step-input-wrap">
        <input type="text" class="step-input value-update" data-field="${fieldName}" value="${esc(val)}" placeholder="${placeholder}" autocomplete="off" spellcheck="false">
        <div class="step-input-actions">
          <button type="button" class="step-input-clear-btn hidden" title="Clear / Reset value">✕</button>
          <button type="button" class="step-input-var-btn" title="Pick flow variable (#)">#</button>
        </div>
      </div>
    </div>
  `;

  const input = row.querySelector('.step-input');
  const clearBtn = row.querySelector('.step-input-clear-btn');
  const varBtn = row.querySelector('.step-input-var-btn');

  // Attach autocomplete
  attachStepAutocomplete(input, step, fieldName);

  // Update visuals immediately
  updateFieldVariableVisuals(input, clearBtn);

  // Listen to input changes in real time
  input.addEventListener('input', () => {
    updateFieldVariableVisuals(input, clearBtn);
  });

  // Clear button click
  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    input.value = '';
    step[fieldName] = '';
    updateFieldVariableVisuals(input, clearBtn);
    pushState();
    scheduleAutoSave();
    input.focus();
  });

  // '#' button click to open autocomplete or trigger selection
  varBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const curVal = (input.value || '').trim();
    if (!curVal || /^#[A-Za-z0-9_]*$/.test(curVal)) {
      // If empty or already a single variable, reset to '#' to easily pick a new one
      input.value = '#';
    } else if (!curVal.endsWith('#')) {
      input.value = curVal + ' #';
    }
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

  return row;
}

function createFieldRow(label, inputHtml) {
  const row = document.createElement('div');
  row.className = 'step-field-row';
  row.innerHTML = `<div class="step-field-label">${label}</div>${inputHtml}`;
  return row;
}

function createStepCard(step, index) {
  // ── INFO steps get their own dedicated card — not the executable step UI ──
  if (step.type === 'INFO') {
    return createInfoStepCard(step, index);
  }

  // ── COMPONENT steps get their own dedicated card ──
  if (step.type === 'COMPONENT') {
    return createComponentStepCard(step, index);
  }

  const card = document.createElement('div');
  card.className = 'step-card';
  card.dataset.id = step.id;
  card.dataset.type = step.type;
  card.draggable = true;

  console.log(`[Flow] createStepCard #${index}: type=${step.type}, tabRef=${step.tabRef}`);
  const config = getStepConfig(step.type);
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  
  card.innerHTML = `
    <div class="step-number">${index + 1}</div>
    <div class="step-content">
      <div class="step-header">
        <div class="step-title-wrap">
          <span class="step-icon">${config.icon}</span>
          <span class="step-title">${config.title}</span>
          ${step.tabRef ? `<span class="tab-badge" style="background:${step.tabRef === 'tab_1' ? 'red' : '#444'};color:#fff;padding:2px 6px;border-radius:4px;font-size:10px;margin-left:8px;font-weight:bold;">${esc(step.tabRef)}</span>` : ''}
        </div>
        <div class="step-actions">
          <button class="step-action-btn copy" title="Duplicate">📋</button>
          <button class="step-action-btn delete" title="Delete">🗑</button>
        </div>
      </div>
      <div class="step-body"></div>
      <div class="step-advanced">
        <div style="padding: 0 12px 12px 12px;">
          <button class="advanced-toggle">⚙ Advanced <span>▼</span></button>
          <div class="advanced-content">
            <div class="adv-row">
              <span class="adv-label">Override Wait (sec)</span>
              <input type="number" class="adv-input override-wait" value="${step.advanced.overrideWait}" min="0" placeholder="Auto">
            </div>
            <div class="adv-row">
              <span class="adv-label">Retry Count</span>
              <input type="number" class="adv-input retry-count" value="${step.advanced.retryCount}" min="0">
            </div>
            <div class="adv-row">
              <span class="adv-label">Continue on Failure</span>
              <label class="toggle-switch">
                <input type="checkbox" class="continue-fail" ${step.advanced.continueOnFailure ? 'checked' : ''}>
                <span class="slider"></span>
              </label>
            </div>
            <div class="adv-row">
              <span class="adv-label">Capture Screenshot</span>
              <label class="toggle-switch">
                <input type="checkbox" class="capture-screen" ${step.advanced.captureScreenshot ? 'checked' : ''}>
                <span class="slider"></span>
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  
  const body = card.querySelector('.step-body');
  
  if (step.type === 'navigate') {
    body.appendChild(createFieldRow('URL', `<input type="text" class="step-input value-update" data-field="value" value="${esc(step.value)}">`));
  } else if (step.type === 'NEW_TAB_OPENED' || step.type === 'SWITCH_TAB') {
    if (step.fromTabRef) {
      body.appendChild(createFieldRow('From', `<span class="step-input">${esc(step.fromTabRef)}</span>`));
    }
    body.appendChild(createFieldRow('To', `<span class="step-input">${esc(step.toTabRef || step.tabRef)}</span>`));
  } else if (step.type === 'TAB_LOAD_TIMEOUT') {
    body.appendChild(createFieldRow('Message', `<span class="step-input" style="color:red">${esc(step.message)}</span>`));
  } else if (step.type === 'URL_CHANGE') {
    body.appendChild(createFieldRow('URL', `<input type="text" class="step-input value-update" data-field="url" value="${esc(step.url)}">`));
    body.appendChild(createFieldRow('Wait (ms)', `<input type="number" class="step-input value-update" data-field="wait" value="${step.wait}">`));
  } else {
    body.appendChild(createFieldRow('Selector', `<input type="text" class="step-input value-update" data-field="selector" value="${esc(step.selector)}">`));
  }
  
  if (step.type === 'type' || step.type === 'select') {
    body.appendChild(createValueFieldRow('Value', step, 'value', 'Value or type # for variable...'));
  } else if (step.type === 'checkbox') {
    body.appendChild(createFieldRow('State', `
      <select class="step-input value-update" data-field="value">
        <option value="Checked" ${step.value === 'Checked' || step.value === true ? 'selected' : ''}>☑ Checked</option>
        <option value="Unchecked" ${step.value === 'Unchecked' || step.value === false ? 'selected' : ''}>☐ Unchecked</option>
      </select>
    `));
  } else if (step.type === 'verify') {
    body.appendChild(createFieldRow('Type', `
      <select class="step-input value-update" data-field="verificationType">
        ${['Visible', 'Not Visible', 'Exists', 'Not Exists', 'Image Source', 'Alt Text', 'Value', 'Enabled', 'Disabled', 'Checked', 'Unchecked', 'Selected Value', 'Text Equals', 'Contains', 'Text Not Equals', 'Tooltip Text']
          .map(opt => `<option value="${opt}" ${step.verificationType === opt ? 'selected' : ''}>${opt}</option>`).join('')}
      </select>
    `));
    // If text equals or similar, we might need a value field
    if (['Image Source', 'Alt Text', 'Value', 'Text Equals', 'Selected Value', 'Contains', 'Text Not Equals', 'Tooltip Text'].includes(step.verificationType)) {
      body.appendChild(createValueFieldRow('Expected', step, 'value', 'Expected value or type #...'));
    }
  } else if (step.type === 'upload') {
    body.appendChild(createValueFieldRow('File', step, 'value', 'File path or #variable...'));
  } else if (step.type === 'date') {
    body.appendChild(createFieldRow('Value', `<input type="date" class="step-input value-update" data-field="value" value="${esc(step.value)}">`));
  }

  bindCardEvents(card, step, index);
  return card;
}

function bindCardEvents(card, step, index) {
  // Advanced Toggle
  const toggleBtn = card.querySelector('.advanced-toggle');
  const advContent = card.querySelector('.advanced-content');
  toggleBtn.addEventListener('click', () => {
    const isExpanded = advContent.classList.contains('expanded');
    if (isExpanded) {
      advContent.classList.remove('expanded');
      toggleBtn.innerHTML = '⚙ Advanced <span>▼</span>';
    } else {
      advContent.classList.add('expanded');
      toggleBtn.innerHTML = '⚙ Advanced <span>▲</span>';
    }
  });

  // Action Buttons
  card.querySelector('.delete').addEventListener('click', () => {
    pushState();
    state.steps.splice(index, 1);
    render();
  });
  
  card.querySelector('.copy').addEventListener('click', () => {
    pushState();
    const copy = JSON.parse(JSON.stringify(step));
    copy.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    state.steps.splice(index + 1, 0, copy);
    scheduleAutoSave();
    render();
    scrollToStep(copy.id);
  });

  // Value updates
  card.querySelectorAll('.value-update').forEach(input => {
    if (input.type === 'text' && (input.dataset.field === 'value' || input.dataset.field === 'expectedValue')) {
      attachStepAutocomplete(input, step, input.dataset.field);
      updateInputVariableVisuals(input);
      input.addEventListener('input', () => updateInputVariableVisuals(input));
    }
    input.addEventListener('change', (e) => {
      pushState();
      if (e.target.dataset.field === 'wait') {
        step[e.target.dataset.field] = parseInt(e.target.value, 10) || 0;
      } else {
        step[e.target.dataset.field] = e.target.value;
      }
      if (e.target.dataset.field === 'verificationType') {
        render(); // re-render to show/hide Expected value field
      }
    });
  });

  // Advanced updates
  card.querySelector('.override-wait').addEventListener('change', (e) => { pushState(); step.advanced.overrideWait = e.target.value; });
  card.querySelector('.retry-count').addEventListener('change', (e) => { pushState(); step.advanced.retryCount = e.target.value; });
  card.querySelector('.continue-fail').addEventListener('change', (e) => { pushState(); step.advanced.continueOnFailure = e.target.checked; });
  card.querySelector('.capture-screen').addEventListener('change', (e) => { pushState(); step.advanced.captureScreenshot = e.target.checked; });

  // Drag and Drop
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index);
    card.classList.add('dragging');
  });

  card.addEventListener('dragend', () => card.classList.remove('dragging'));

  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    card.classList.add('drag-over');
  });

  card.addEventListener('dragleave', () => card.classList.remove('drag-over'));

  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.classList.remove('drag-over');
    const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
    const toIdx = index;
    if (fromIdx === toIdx) return;
    
    pushState();
    const moved = state.steps.splice(fromIdx, 1)[0];
    state.steps.splice(toIdx, 0, moved);
    render();
  });
}

// ── INFO Step — dedicated card renderer ───────────────────────────────────────
// INFO steps are purely documentary. They:
//   • Do NOT show a step-number circle (they are section separators)
//   • Do NOT show locator/selector/wait/advanced controls
//   • Do NOT use execution status indicators
//   • Are still draggable and fully participate in the steps array
//   • Safely render text via textContent (no XSS risk)

// ── COMPONENT Step — dedicated card renderer ──────────────────────────────────
function createComponentStepCard(step, index) {
  const card = document.createElement('div');
  card.className = 'step-card comp-step-card';
  card.dataset.id = step.id;
  card.dataset.type = 'COMPONENT';
  card.draggable = true;

  // Step Number
  const numberEl = document.createElement('div');
  numberEl.className = 'step-number';
  numberEl.textContent = index + 1;

  // Step Content Container
  const content = document.createElement('div');
  content.className = 'step-content';

  // Step Header
  const header = document.createElement('div');
  header.className = 'step-header';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'step-title-wrap';

  const icon = document.createElement('span');
  icon.className = 'step-icon';
  icon.textContent = '🧩';

  const title = document.createElement('span');
  title.className = 'step-title';
  title.textContent = 'Component';

  const badge = document.createElement('span');
  badge.className = 'comp-name-badge';
  badge.textContent = step.componentName || '';
  badge.style.display = step.componentName ? 'inline-block' : 'none';

  titleWrap.appendChild(icon);
  titleWrap.appendChild(title);
  titleWrap.appendChild(badge);

  if (step.isReadOnly) {
    const readOnlyBadge = document.createElement('span');
    readOnlyBadge.className = 'comp-readonly-badge';
    readOnlyBadge.textContent = '🔒 Read-only';
    readOnlyBadge.title = 'This component is part of the flow and not editable';
    titleWrap.appendChild(readOnlyBadge);
  }

  // Step Actions (duplicate, delete)
  const actions = document.createElement('div');
  actions.className = 'step-actions';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'step-action-btn copy';
  copyBtn.title = 'Duplicate';
  copyBtn.textContent = '📋';
  copyBtn.addEventListener('click', () => {
    pushState();
    const copy = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
      type: 'COMPONENT',
      moduleId: step.moduleId || '',
      moduleName: step.moduleName || '',
      componentId: step.componentId || '',
      componentName: step.componentName || '',
      description: step.description || ''
    };
    state.steps.splice(index + 1, 0, copy);
    scheduleAutoSave();
    render();
    scrollToStep(copy.id);
  });

  const delBtn = document.createElement('button');
  delBtn.className = 'step-action-btn delete';
  delBtn.title = 'Delete';
  delBtn.textContent = '🗑';
  delBtn.addEventListener('click', () => {
    pushState();
    state.steps.splice(index, 1);
    scheduleAutoSave();
    render();
  });

  actions.appendChild(copyBtn);
  actions.appendChild(delBtn);

  header.appendChild(titleWrap);
  header.appendChild(actions);

  // Step Body
  const body = document.createElement('div');
  body.className = 'step-body';

  // Module Row
  const modRow = document.createElement('div');
  modRow.className = 'step-field-row';
  modRow.innerHTML = '<div class="step-field-label">Module</div>';

  const moduleSelect = document.createElement('select');
  moduleSelect.className = 'step-input comp-module-select';
  if (step.isReadOnly) {
    moduleSelect.disabled = true;
    moduleSelect.title = 'Component module is read-only';
  }
  if (step.moduleId && step.moduleName) {
    moduleSelect.innerHTML = `<option value="${step.moduleId}" selected>${formatDropdownText(step.moduleName, 46)}</option>`;
  } else if (step.moduleId) {
    moduleSelect.innerHTML = `<option value="${step.moduleId}" selected>${formatDropdownText(`Module (${step.moduleId})`, 46)}</option>`;
  } else {
    moduleSelect.innerHTML = '<option value="">Select Module...</option>';
  }
  modRow.appendChild(moduleSelect);

  // Component Row
  const compRow = document.createElement('div');
  compRow.className = 'step-field-row';
  compRow.innerHTML = '<div class="step-field-label">Component</div>';

  const compSelect = document.createElement('select');
  compSelect.className = 'step-input comp-select';
  if (step.isReadOnly) {
    compSelect.disabled = true;
    compSelect.title = 'Component selection is read-only';
  } else {
    compSelect.disabled = !step.moduleId;
  }
  if (step.componentId && step.componentName) {
    compSelect.innerHTML = `<option value="${step.componentId}" selected>${formatDropdownText(step.componentName, 46)}</option>`;
  } else if (step.componentId) {
    compSelect.innerHTML = `<option value="${step.componentId}" selected>${formatDropdownText(`Component (${step.componentId})`, 46)}</option>`;
  } else {
    compSelect.innerHTML = `<option value="">${step.moduleId ? 'Loading components...' : 'Select a module first...'}</option>`;
  }
  compRow.appendChild(compSelect);

  // Description row
  const metaRow = document.createElement('div');
  metaRow.className = 'comp-details-row';
  metaRow.style.display = 'none';
  const metaText = document.createElement('span');
  metaText.className = 'comp-desc-text';
  metaRow.appendChild(metaText);

  if (step.description || step.componentName) {
    metaText.textContent = step.description || step.componentName;
    metaText.title = step.description || step.componentName;
    metaRow.style.display = 'flex';
  }

  body.appendChild(modRow);
  body.appendChild(compRow);
  body.appendChild(metaRow);

  content.appendChild(header);
  content.appendChild(body);

  card.appendChild(numberEl);
  card.appendChild(content);

  // Asynchronously populate Module dropdown & Component dropdown
  populateComponentCardDropdowns(step, moduleSelect, compSelect, badge, metaRow, metaText);

  // Drag and Drop
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index);
    card.style.opacity = '0.5';
  });
  card.addEventListener('dragend', () => { card.style.opacity = ''; });
  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    card.style.borderTop = '2px dashed #a855f7';
  });
  card.addEventListener('dragleave', () => { card.style.borderTop = ''; });
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.style.borderTop = '';
    const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
    const toIdx = index;
    if (fromIdx === toIdx) return;
    pushState();
    const moved = state.steps.splice(fromIdx, 1)[0];
    state.steps.splice(toIdx, 0, moved);
    scheduleAutoSave();
    render();
  });

  return card;
}

function formatDropdownText(text, maxLen = 46) {
  if (!text || typeof text !== 'string') return '';
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen - 1) + '…';
}

async function populateComponentCardDropdowns(step, moduleSelect, compSelect, badge, metaRow, metaText) {
  const modules = await getModules();

  const modExists = modules.some(m => String(m.id || m._id) === String(step.moduleId));

  // Auto-resolve moduleId if componentId is set but moduleId is missing or doesn't match any component module
  if (step.componentId && (!step.moduleId || !modExists) && modules.length > 0) {
    for (const mod of modules) {
      const modId = mod.id || mod._id;
      const comps = await getComponentsForModule(modId);
      const found = comps.find(c => String(c.id || c._id) === String(step.componentId) || (step.componentName && c.name === step.componentName));
      if (found) {
        step.moduleId = modId;
        step.moduleName = mod.name;
        step.componentId = found.id || found._id;
        if (!step.componentName) step.componentName = found.name;
        const stepCount = Array.isArray(found.steps) ? found.steps.length : (found.stepCount || 0);
        if (!step.description) step.description = found.description || (stepCount ? `${stepCount} steps` : '');
        break;
      }
    }
  }

  // Auto-resolve by componentName if componentId is missing
  if (!step.componentId && step.componentName && modules.length > 0) {
    for (const mod of modules) {
      const modId = mod.id || mod._id;
      const comps = await getComponentsForModule(modId);
      const found = comps.find(c => c.name === step.componentName);
      if (found) {
        step.moduleId = modId;
        step.moduleName = mod.name;
        step.componentId = found.id || found._id;
        const stepCount = Array.isArray(found.steps) ? found.steps.length : (found.stepCount || 0);
        if (!step.description) step.description = found.description || (stepCount ? `${stepCount} steps` : '');
        break;
      }
    }
  }

  // If moduleId is set but moduleName is missing, resolve it from modules
  if (step.moduleId && !step.moduleName && modules.length > 0) {
    const mod = modules.find(m => String(m.id || m._id) === String(step.moduleId));
    if (mod) step.moduleName = mod.name;
  }

  // If componentId & moduleId are set but componentName is missing, resolve it from comps
  if (step.moduleId && step.componentId && !step.componentName) {
    const comps = await getComponentsForModule(step.moduleId);
    const found = comps.find(c => String(c.id || c._id) === String(step.componentId));
    if (found) {
      step.componentName = found.name;
      const stepCount = Array.isArray(found.steps) ? found.steps.length : (found.stepCount || 0);
      if (!step.description) step.description = found.description || (stepCount ? `${stepCount} steps` : '');
    }
  }

  // 1. Populate Module dropdown
  moduleSelect.innerHTML = '<option value="">Select Module...</option>';
  if (modules.length === 0) {
    moduleSelect.innerHTML = '<option value="">No component modules found</option>';
  }
  let matchedMod = false;
  modules.forEach(m => {
    const modId = m.id || m._id;
    const opt = document.createElement('option');
    opt.value = modId;
    opt.textContent = formatDropdownText(m.name, 46);
    opt.title = m.name;
    if (String(modId) === String(step.moduleId)) {
      opt.selected = true;
      matchedMod = true;
      step.moduleName = m.name;
      moduleSelect.title = m.name;
    }
    moduleSelect.appendChild(opt);
  });

  // Fallback: if step has moduleId but it wasn't in modules list, add a fallback option
  if (!matchedMod && step.moduleId) {
    const fallbackModOpt = document.createElement('option');
    fallbackModOpt.value = step.moduleId;
    const label = step.moduleName || `Module (${step.moduleId})`;
    fallbackModOpt.textContent = formatDropdownText(label, 46);
    fallbackModOpt.title = label;
    fallbackModOpt.selected = true;
    moduleSelect.appendChild(fallbackModOpt);
    moduleSelect.title = label;
  } else if (!step.moduleId && step.componentId) {
    // If moduleId is missing but componentId is present
    const fallbackModOpt = document.createElement('option');
    fallbackModOpt.value = "";
    const shortId = typeof step.componentId === 'string' && step.componentId.length > 8 ? step.componentId.substring(0, 8) + '…' : step.componentId;
    const label = step.moduleName || `Mapped (${shortId})`;
    fallbackModOpt.textContent = formatDropdownText(label, 46);
    fallbackModOpt.title = label;
    fallbackModOpt.selected = true;
    moduleSelect.appendChild(fallbackModOpt);
    moduleSelect.title = label;
  }

  // Explicitly sync moduleSelect.value
  if (step.moduleId) {
    moduleSelect.value = String(step.moduleId);
  }

  // 2. Populate Component dropdown
  if (step.moduleId) {
    compSelect.innerHTML = '<option value="">Loading components...</option>';
    const comps = await getComponentsForModule(step.moduleId);
    compSelect.innerHTML = '<option value="">Select Component...</option>';
    if (comps.length === 0) {
      compSelect.innerHTML = '<option value="">No components in this module</option>';
    }
    let matchedComp = false;
    comps.forEach(c => {
      const cId = c.id || c._id;
      const opt = document.createElement('option');
      opt.value = cId;
      const stepCount = Array.isArray(c.steps) ? c.steps.length : (c.stepCount || 0);
      const countSuffix = stepCount ? ` (${stepCount} steps)` : '';
      const fullLabel = c.name + countSuffix;
      const maxNameLen = Math.max(18, 46 - countSuffix.length);
      const displayName = (c.name.length > maxNameLen)
        ? (c.name.substring(0, maxNameLen - 1) + '…')
        : c.name;
      opt.textContent = displayName + countSuffix;
      opt.title = fullLabel + (c.description ? ` - ${c.description}` : '');
      if (String(cId) === String(step.componentId) || (step.componentName && c.name === step.componentName)) {
        opt.selected = true;
        matchedComp = true;
        compSelect.title = fullLabel;
        if (!step.componentId) step.componentId = cId;
        if (!step.componentName) step.componentName = c.name;
        if (!step.description) step.description = c.description || (stepCount ? `${stepCount} steps` : '');
      }
      compSelect.appendChild(opt);
    });

    // Fallback: if step has componentId but not found in comps list
    if (!matchedComp && step.componentId) {
      const fallbackCompOpt = document.createElement('option');
      fallbackCompOpt.value = step.componentId;
      const label = step.componentName || `Component (${step.componentId})`;
      fallbackCompOpt.textContent = formatDropdownText(label, 46);
      fallbackCompOpt.title = label;
      fallbackCompOpt.selected = true;
      compSelect.appendChild(fallbackCompOpt);
      compSelect.title = label;
    }

    // Explicitly sync compSelect.value
    if (step.componentId) {
      compSelect.value = String(step.componentId);
    }
  } else if (step.componentId) {
    // If moduleId is missing but componentId is present, ensure component is selected and displayed
    compSelect.innerHTML = '';
    const fallbackCompOpt = document.createElement('option');
    fallbackCompOpt.value = step.componentId;
    const label = step.componentName || `Component (${step.componentId})`;
    fallbackCompOpt.textContent = formatDropdownText(label, 46);
    fallbackCompOpt.title = label;
    fallbackCompOpt.selected = true;
    compSelect.appendChild(fallbackCompOpt);
    compSelect.value = String(step.componentId);
    compSelect.title = label;
  } else {
    compSelect.innerHTML = '<option value="">Select a module first...</option>';
  }

  // 3. Update Badge and Details row
  if (step.componentName || step.componentId) {
    const shortId = typeof step.componentId === 'string' && step.componentId.length > 8 ? step.componentId.substring(0, 8) + '…' : (step.componentId || '');
    badge.textContent = step.componentName || `Component (${shortId})`;
    badge.title = step.componentName || step.componentId || 'Component';
    badge.style.display = 'inline-block';
    metaText.textContent = step.description ? `${step.description}` : (step.componentName ? 'Reusable component' : `Mapped Component ID: ${step.componentId}`);
    metaText.title = metaText.textContent;
    metaRow.style.display = 'flex';
  }

  // 3. Set disabled state based on isReadOnly or missing moduleId
  if (step.isReadOnly) {
    moduleSelect.disabled = true;
    compSelect.disabled = true;
  } else {
    moduleSelect.disabled = false;
    compSelect.disabled = !step.moduleId;
  }

  if (step.isReadOnly) return; // Prevent editing when component is read-only

  moduleSelect.addEventListener('change', async (e) => {
    const newModId = e.target.value;
    step.moduleId = newModId;
    const modObj = modules.find(m => (m.id || m._id) === newModId);
    step.moduleName = modObj ? modObj.name : '';
    moduleSelect.title = modObj ? modObj.name : '';
    step.componentId = '';
    step.componentName = '';
    step.description = '';
    compSelect.title = '';
    badge.textContent = '';
    badge.title = '';
    badge.style.display = 'none';
    metaRow.style.display = 'none';
    metaText.title = '';
    scheduleAutoSave();

    if (!newModId) {
      compSelect.disabled = true;
      compSelect.innerHTML = '<option value="">Select a module first...</option>';
      return;
    }

    compSelect.disabled = false;
    compSelect.innerHTML = '<option value="">Loading components...</option>';
    const comps = await getComponentsForModule(newModId);
    compSelect.innerHTML = '<option value="">Select Component...</option>';
    if (comps.length === 0) {
      compSelect.innerHTML = '<option value="">No components in this module</option>';
      return;
    }
    comps.forEach(c => {
      const cId = c.id || c._id;
      const opt = document.createElement('option');
      opt.value = cId;
      const stepCount = Array.isArray(c.steps) ? c.steps.length : (c.stepCount || 0);
      const countSuffix = stepCount ? ` (${stepCount} steps)` : '';
      const fullLabel = c.name + countSuffix;
      const maxNameLen = Math.max(18, 46 - countSuffix.length);
      const displayName = (c.name.length > maxNameLen)
        ? (c.name.substring(0, maxNameLen - 1) + '…')
        : c.name;
      opt.textContent = displayName + countSuffix;
      opt.title = fullLabel + (c.description ? ` - ${c.description}` : '');
      compSelect.appendChild(opt);
    });
  });

  compSelect.addEventListener('change', (e) => {
    const newCompId = e.target.value;
    step.componentId = newCompId;
    const comps = _cachedComponentsByModule[step.moduleId] || [];
    const compObj = comps.find(c => (c.id || c._id) === newCompId);
    if (compObj) {
      step.componentName = compObj.name;
      const stepCount = Array.isArray(compObj.steps) ? compObj.steps.length : (compObj.stepCount || 0);
      step.description = compObj.description || (stepCount ? `${stepCount} steps` : '');
      const fullLabel = compObj.name + (stepCount ? ` (${stepCount} steps)` : '');
      compSelect.title = fullLabel;
      badge.textContent = compObj.name;
      badge.title = compObj.name;
      badge.style.display = 'inline-block';
      metaText.textContent = (compObj.description ? compObj.description + ' · ' : '') + `${stepCount} steps`;
      metaText.title = metaText.textContent;
      metaRow.style.display = 'flex';
    } else {
      step.componentName = '';
      step.description = '';
      compSelect.title = '';
      badge.textContent = '';
      badge.title = '';
      badge.style.display = 'none';
      metaRow.style.display = 'none';
      metaText.title = '';
    }
    scheduleAutoSave();
  });
}
function createInfoStepCard(step, index) {
  const wrapper = document.createElement('div');
  wrapper.className = 'info-step-wrapper';
  wrapper.dataset.id = step.id;
  wrapper.dataset.type = 'INFO';
  wrapper.draggable = true;

  const card = document.createElement('div');
  card.className = 'info-step-card';

  // Header — icon + label + action buttons
  const header = document.createElement('div');
  header.className = 'info-step-header';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'info-step-title-wrap';

  const icon = document.createElement('span');
  icon.className = 'info-step-icon';
  icon.textContent = 'ⓘ';

  const label = document.createElement('span');
  label.className = 'info-step-label';
  label.textContent = 'Test Information';

  titleWrap.appendChild(icon);
  titleWrap.appendChild(label);

  // Action buttons — only edit, duplicate, delete (no locator/debug/run actions)
  const actions = document.createElement('div');
  actions.className = 'info-step-actions';

  const editBtn = document.createElement('button');
  editBtn.className = 'step-action-btn';
  editBtn.title = 'Edit Information';
  editBtn.textContent = '✏️';
  editBtn.addEventListener('click', () => {
    showInfoDialog({
      title: 'Edit Information',
      confirmLabel: 'Save Changes',
      initialValue: step.description || '',
      atIndex: null // editing in-place
    }, (newText) => {
      pushState();
      step.description = newText;
      render();
    });
  });

  const dupBtn = document.createElement('button');
  dupBtn.className = 'step-action-btn';
  dupBtn.title = 'Duplicate';
  dupBtn.textContent = '📋';
  dupBtn.addEventListener('click', () => {
    pushState();
    const copy = { id: Date.now().toString() + Math.random().toString(36).substr(2, 5), type: 'INFO', description: step.description };
    state.steps.splice(index + 1, 0, copy);
    scheduleAutoSave();
    render();
    scrollToStep(copy.id);
  });

  const delBtn = document.createElement('button');
  delBtn.className = 'step-action-btn delete';
  delBtn.title = 'Delete';
  delBtn.textContent = '🗑';
  delBtn.addEventListener('click', () => {
    pushState();
    state.steps.splice(index, 1);
    render();
  });

  actions.appendChild(editBtn);
  actions.appendChild(dupBtn);
  actions.appendChild(delBtn);

  header.appendChild(titleWrap);
  header.appendChild(actions);

  // Description — rendered safely via textContent (no innerHTML with user text)
  const desc = document.createElement('div');
  desc.className = 'info-step-description';
  desc.textContent = step.description || '';

  
  card.appendChild(header);
  card.appendChild(desc);
  wrapper.appendChild(card);


  // Drag-and-drop — INFO participates in reordering like any other step
  wrapper.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index);
    wrapper.style.opacity = '0.5';
  });
  wrapper.addEventListener('dragend', () => { wrapper.style.opacity = ''; });
  wrapper.addEventListener('dragover', (e) => {
    e.preventDefault();
    wrapper.style.borderTop = '2px dashed var(--step-info)';
  });
  wrapper.addEventListener('dragleave', () => { wrapper.style.borderTop = ''; });
  wrapper.addEventListener('drop', (e) => {
    e.preventDefault();
    wrapper.style.borderTop = '';
    const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
    const toIdx = index;
    if (fromIdx === toIdx) return;
    pushState();
    const moved = state.steps.splice(fromIdx, 1)[0];
    state.steps.splice(toIdx, 0, moved);
    render();
  });

  return wrapper;
}

// ── INFO Dialog — add or edit an INFO step ────────────────────────────────────
// Opens a modal with a multiline textarea. Text is trimmed before saving.
// Empty submissions are rejected (confirm button is disabled when textarea is empty).
// User text is NEVER set via innerHTML — only via textContent/value (XSS safe).
function showInfoDialog({ title, confirmLabel, initialValue, atIndex }, onConfirm) {
  // Create overlay
  const overlay = document.createElement('div');
  overlay.className = 'info-dialog-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'info-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

  // Header
  const headerEl = document.createElement('div');
  headerEl.className = 'info-dialog-header';

  const iconEl = document.createElement('span');
  iconEl.className = 'info-dialog-icon';
  iconEl.textContent = 'ⓘ';

  const titleEl = document.createElement('span');
  titleEl.className = 'info-dialog-title';
  titleEl.textContent = title;

  headerEl.appendChild(iconEl);
  headerEl.appendChild(titleEl);

  // Hint
  const hint = document.createElement('p');
  hint.className = 'info-dialog-hint';
  hint.textContent = 'Add context or notes for the following test steps. This will not be executed.';

  // Textarea — user input, safely read back via .value
  const textarea = document.createElement('textarea');
  textarea.className = 'info-dialog-textarea';
  textarea.placeholder = 'Add context for the following test steps…\n\nExample: We are now testing login through the Root Manager account.';
  textarea.value = initialValue || '';
  textarea.rows = 6;

  // Footer buttons
  const footerEl = document.createElement('div');
  footerEl.className = 'info-dialog-footer';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'info-dialog-cancel';
  cancelBtn.textContent = 'Cancel';

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'info-dialog-confirm';
  confirmBtn.textContent = confirmLabel || 'Add Information';
  confirmBtn.disabled = (textarea.value.trim() === '');

  // Enable/disable confirm based on content
  textarea.addEventListener('input', () => {
    confirmBtn.disabled = (textarea.value.trim() === '');
  });

  const close = () => overlay.remove();

  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  confirmBtn.addEventListener('click', () => {
    const text = textarea.value.trim();
    if (!text) return;
    close();
    onConfirm(text);
  });

  // Keyboard: Enter in textarea should not accidentally submit; Escape closes
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  });

  footerEl.appendChild(cancelBtn);
  footerEl.appendChild(confirmBtn);

  dialog.appendChild(headerEl);
  dialog.appendChild(hint);
  dialog.appendChild(textarea);
  dialog.appendChild(footerEl);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // Focus textarea after mount for accessibility
  requestAnimationFrame(() => textarea.focus());
}

function bindGlobalEvents() {
  // ── Flow Settings & Variables Event Listeners ──
  if (els.btnFlowSettings) els.btnFlowSettings.addEventListener('click', () => openSettingsModal('general'));
  if (els.btnCloseSettingsModal) els.btnCloseSettingsModal.addEventListener('click', closeSettingsModal);
  if (els.btnDoneSettings) els.btnDoneSettings.addEventListener('click', closeSettingsModal);

  if (els.tabBtnGeneral) els.tabBtnGeneral.addEventListener('click', () => switchSettingsTab('general'));
  if (els.tabBtnVariables) els.tabBtnVariables.addEventListener('click', () => switchSettingsTab('variables'));

  if (els.headerSettingsSummary) {
    els.headerSettingsSummary.addEventListener('click', () => openSettingsModal('general'));
  }
  if (els.pillVarCount) {
    els.pillVarCount.addEventListener('click', (e) => {
      e.stopPropagation();
      openSettingsModal('variables');
    });
  }

  if (els.flowSettingsModal) {
    els.flowSettingsModal.addEventListener('click', (e) => {
      if (e.target === els.flowSettingsModal) closeSettingsModal();
    });
  }

  if (els.btnFlowVariables) els.btnFlowVariables.addEventListener('click', openVariablesModal);
  if (els.btnCloseVarsModal) els.btnCloseVarsModal.addEventListener('click', closeVariablesModal);
  if (els.btnOpenAddVar) els.btnOpenAddVar.addEventListener('click', openAddVariableForm);
  if (els.btnEmptyAddVar) els.btnEmptyAddVar.addEventListener('click', openAddVariableForm);
  if (els.btnCancelVarForm) els.btnCancelVarForm.addEventListener('click', closeVariableForm);
  if (els.btnDiscardVar) els.btnDiscardVar.addEventListener('click', closeVariableForm);
  if (els.btnSaveVar) els.btnSaveVar.addEventListener('click', saveVariableFromForm);
  if (els.btnRefreshPreview) els.btnRefreshPreview.addEventListener('click', updateFormLivePreview);
  if (els.stepVarManageBtn) els.stepVarManageBtn.addEventListener('click', () => { hideStepAutocomplete(); openVariablesModal(); });

  document.addEventListener('pointerdown', (e) => {
    if (els.stepVarAutocomplete && !els.stepVarAutocomplete.classList.contains('hidden')) {
      if (!els.stepVarAutocomplete.contains(e.target) && (!activeAutocompleteInput || e.target !== activeAutocompleteInput)) {
        hideStepAutocomplete();
      }
    }
  });

  if (els.flowVariablesModal) {
    els.flowVariablesModal.addEventListener('click', (e) => {
      if (e.target === els.flowVariablesModal) closeVariablesModal();
    });
  }

  [els.varInputName, els.varInputLength, els.varInputPrefix, els.varInputSuffix].forEach((input) => {
    if (input) input.addEventListener('input', updateFormLivePreview);
  });
  if (els.varInputType) els.varInputType.addEventListener('change', updateFormLivePreview);
  if (els.varInputCharset) els.varInputCharset.addEventListener('change', updateFormLivePreview);

  els.flowName.addEventListener('change', (e) => { state.flowName = e.target.value; scheduleAutoSave(); });
  els.defaultWait.addEventListener('change', (e) => { state.defaultWait = e.target.value; scheduleAutoSave(); });
  els.urlChangeWait.addEventListener('change', (e) => { state.urlChangeWait = parseInt(e.target.value, 10) || 2000; scheduleAutoSave(); });
  
  els.btnUndo.addEventListener('click', undo);
  els.btnRedo.addEventListener('click', redo);
  els.btnPause.addEventListener('click', pauseRecording);
  els.btnResume.addEventListener('click', resumeRecording);
  
  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && (e.code === 'KeyC' || e.key.toLowerCase() === 'c')) {
      e.preventDefault();
      els.btnCaptureUrl.click();
    }
  });
  
  els.btnCaptureUrl.addEventListener('click', () => {
    if (!state.isRecording || state.isPaused) return;
    if (state.targetTabId) {
      chrome.tabs.get(state.targetTabId, (tab) => {
        if (tab && tab.url) {
          pushState();
          const step = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
            type: 'navigate',
            selector: '',
            value: tab.url,
            advanced: { overrideWait: '', retryCount: 0, continueOnFailure: false, captureScreenshot: true }
          };
          if (_captureInsertIndex !== null) {
            const insertAt = _captureInsertIndex;
            state.steps.splice(insertAt, 0, step);
            _captureInsertIndex = insertAt + 1;
            scheduleAutoSave();
            render();
            scrollToStep(step.id);
          } else {
            state.steps.push(step);
            scheduleAutoSave();
            render();
            scrollToBottom();
          }
          showToast('Captured URL');
        }
      });
    }
  });

  els.btnFinish.addEventListener('click', async () => {
    stopRecording();
    els.btnFinish.disabled = true;
    els.btnFinish.textContent = 'Saving...';

    const hasComponents = state.steps.some(s => s.type === 'COMPONENT' || !!s.componentId);

    // Validate that all component steps have a component selected
    if (hasComponents) {
      for (let i = 0; i < state.steps.length; i++) {
        const s = state.steps[i];
        if (s.type === 'COMPONENT') {
          if (!s.componentId) {
            showToast(`Please select a component for Step ${i + 1} or remove it.`);
            els.btnFinish.disabled = false;
            els.btnFinish.textContent = 'Finish';
            return;
          }
        }
      }

      // ── Case 2: Composite Flow (contains 1+ components) ──
      const flowItems = state.steps.map((step, idx) => {
        const order = idx + 1;
        if (step.type === 'COMPONENT' || step.componentId) {
          return {
            order: order,
            type: 'COMPONENT',
            componentId: step.componentId,
            componentName: step.componentName || '',
            moduleId: step.moduleId || '',
            moduleName: step.moduleName || '',
            description: step.description || ''
          };
        } else {
          const backendStep = mapLocalStepToBackend(step, idx);
          backendStep.isComp = false;
          return {
            order: order,
            type: 'STEP',
            step: backendStep
          };
        }
      });

      const payload = {
        id: state.flowId,
        flowId: state.flowId,
        projectId: state.projectId,
        moduleId: state.moduleId,
        name: state.flowName,
        description: 'Recorded Flow',
        containsComp: true,
        variables: state.variables || {},
        flowItems: flowItems
      };

      if (state.version !== undefined && state.version !== null) {
        payload.version = state.version;
      }
      if (state.createdAt !== undefined && state.createdAt !== null) {
        payload.createdAt = state.createdAt;
      }
      if (state.createdBy !== undefined && state.createdBy !== null) {
        payload.createdBy = state.createdBy;
      }

      try {
        if (state.flowId) {
          await window.components.saveFlowInfo(state.flowId, payload, state.authToken);
        } else {
          await window.components.createFlowInfo(payload, state.authToken);
        }
        clearLocalDraft();
        if (window.parent !== window) {
          window.parent.postMessage({ type: 'QA_CLOSE' }, '*');
        } else {
          window.close();
        }
      } catch (err) {
        showToast('Failed to save flow: ' + err.message);
        els.btnFinish.disabled = false;
        els.btnFinish.textContent = 'Finish';
      }
      return;
    }

    // ── Pure Steps Flow (No components) ──
    const payload = {
      projectId: state.projectId,
      moduleId: state.moduleId,
      name: state.flowName,
      description: 'Recorded Flow',
      defaultWait: (parseFloat(state.defaultWait) || 5) * 1000,
      urlChangeWait: parseInt(state.urlChangeWait, 10) || 2000,
      status: 'DRAFT',
      variables: state.variables || {},
      steps: state.steps.map(mapLocalStepToBackend),
      version: state.version !== undefined ? state.version : null
    };

    if (state.createdAt !== undefined && state.createdAt !== null) {
      payload.createdAt = state.createdAt;
    }
    if (state.createdBy !== undefined && state.createdBy !== null) {
      payload.createdBy = state.createdBy;
    }

    try {
      if (state.flowId) {
        await ApiClient.updateFlowDraft({ flowId: state.flowId, authToken: state.authToken, payload });
      } else {
        await ApiClient.saveFlowDraft({ authToken: state.authToken, payload });
      }
      clearLocalDraft();  // wipe local draft after successful API save
      if (window.parent !== window) {
        window.parent.postMessage({ type: 'QA_CLOSE' }, '*');
      } else {
        window.close();
      }
    } catch (err) {
      showToast('Failed to save flow: ' + err.message);
      els.btnFinish.disabled = false;
      els.btnFinish.textContent = 'Finish';
    }
  });
  
  els.btnCancel.addEventListener('click', () => {
    showModal('Cancel Recording', 'Are you sure you want to cancel and clear all steps?', () => {
      clearLocalDraft();  // wipe local draft on cancel too
      state.steps = [];
      undoStack = [];
      redoStack = [];
      stopRecording();
      if (window.parent !== window) {
        window.parent.postMessage({ type: 'QA_CLOSE' }, '*');
      } else {
        window.close();
      }
    });
  });

  els.btnHoverCapture.addEventListener('click', toggleHoverCaptureMode);
}
