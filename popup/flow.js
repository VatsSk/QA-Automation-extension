'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  flowName: 'New Flow',
  defaultWait: 5,
  steps: [],
  isRecording: false,
  isPaused: false,
  isVerificationMode: false,
  isHoverCaptureMode: false,
  targetTabId: null,
  projectId: null,
  moduleId: null,
  flowId: null,
  createdBy: null,
  loginUrl: null,
  authToken: null
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
  hoverBanner: document.getElementById('hover-banner'),
  autosaveStatus: document.getElementById('autosave-status')
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

async function loadSession() {
  const data = await chrome.storage.local.get(['projectId', 'moduleId', 'flowId', 'existingFlow', 'createdBy', 'url', 'authToken', 'flow_draft']);
  state.projectId = data.projectId;
  state.moduleId = data.moduleId;
  state.flowId = data.flowId;
  state.createdBy = data.createdBy;
  state.loginUrl = data.url;
  state.authToken = data.authToken;

  // If a local draft exists for this same project/module, restore it
  const draft = data.flow_draft;
  if (
    draft &&
    draft.projectId === data.projectId &&
    draft.moduleId === data.moduleId
  ) {
    state.flowName = draft.flowName || 'New Flow';
    state.defaultWait = draft.defaultWait ?? 5;
    state.steps = draft.steps || [];
    state.flowId = draft.flowId || data.flowId;
    return; // draft wins — don't overwrite with existingFlow
  }

  if (data.existingFlow) {
    state.flowName = data.existingFlow.name || 'Edit Flow';
    state.defaultWait = data.existingFlow.defaultWait ? (data.existingFlow.defaultWait / 1000) : 5;
    state.steps = data.existingFlow.steps ? data.existingFlow.steps.map(mapBackendStepToLocal) : [];
  } else {
    // New flow: add default navigate step
    state.flowName = 'New Flow';
    state.steps = [];
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

chrome.runtime.onMessage.addListener(handleIncomingMessage);

function handleIncomingMessage(msg) {
  // Filter: only process messages meant for this tab's UI
  if (msg._targetTabId && msg._targetTabId !== state.targetTabId) return;

  if (msg.type === 'STEP_RECORDED') {
    messageCounter++;
    console.log(`[Flow] Message #${messageCounter} - Received STEP_RECORDED:`, {
      selector: msg.data?.target?.cssSelector,
      action: msg.data?.action,
      timestamp: Date.now()
    });
  } else {
    console.log('[Flow] Received message:', msg.type);
  }
  
  if (msg.type === 'STEP_RECORDED') {
    if (state.isRecording && !state.isPaused && !state.isVerificationMode) {
      console.log('[Flow] Processing STEP_RECORDED');
      addStepFromCapture(msg.data);
    } else {
      console.log('[Flow] Ignoring STEP_RECORDED - not in recording mode');
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
  } else if (msg.type === 'UNDO_STEP') {
    console.log('[Flow] Shortcut received: UNDO_STEP');
    undo();
  } else if (msg.type === 'REDO_STEP') {
    console.log('[Flow] Shortcut received: REDO_STEP');
    redo();
  } else if (msg.type === 'TARGET_TAB_CHANGED') {
    const tabActuallyChanged = state.targetTabId !== msg.tabId;
    state.targetTabId = msg.tabId;
    // Only re-send recording commands if the actual target tab switched.
    // Same-tab navigations (refreshes, SPA routes) are handled by the
    // service worker's auto re-injection — no need to double-send.
    if (tabActuallyChanged && state.isRecording && !state.isPaused) {
      chrome.runtime.sendMessage({ type: 'START_RECORDING', tabId: state.targetTabId });
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
  }
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
    chrome.runtime.sendMessage({ type: 'START_RECORDING', tabId: state.targetTabId });
  }
  render();
}

function pauseRecording() {
  state.isPaused = true;
  if (state.targetTabId) {
    chrome.runtime.sendMessage({ type: 'PAUSE_RECORDING', tabId: state.targetTabId });
  }
  render();
}

function resumeRecording() {
  state.isPaused = false;
  if (state.targetTabId) {
    chrome.runtime.sendMessage({ type: 'START_RECORDING', tabId: state.targetTabId });
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
    flowName: state.flowName,
    defaultWait: state.defaultWait,
    steps: state.steps
  };
  chrome.storage.local.set({ flow_draft: draft });
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

// ── Mappers ───────────────────────────────────────────────────────────────────
function mapLocalStepToBackend(step, index) {
  const actionTypeMap = {
    navigate: 'NAVIGATE', click: 'CLICK', type: 'TYPE', select: 'SELECT',
    checkbox: 'CHECKBOX', upload: 'FILE_UPLOAD', date: 'DATE', hover: 'HOVER', verify: 'VERIFY'
  };
  const verTypeMap = {
    'Visible': 'VISIBLE', 'Exists': 'EXISTS', 'Image Source': 'IMAGE', 'Alt Text': 'ATTRIBUTE',
    'Value': 'VALUE', 'Enabled': 'ENABLED', 'Disabled': 'DISABLED', 'Checked': 'CHECKED', 'Text Equals': 'TEXT'
  };

  const isVerify = step.type === 'verify';
  return {
    stepOrder: index + 1,
    name: `Step ${index + 1}`,
    actionType: actionTypeMap[step.type] || 'CLICK',
    verificationType: isVerify ? (verTypeMap[step.verificationType] || 'VISIBLE') : null,
    selector: step.selector,
    value: isVerify ? null : step.value,
    expectedValue: isVerify ? step.value : null,
    attribute: step.verificationType === 'Alt Text' ? 'alt' : null,
    overrideWait: !!step.advanced.overrideWait,
    wait: step.advanced.overrideWait ? (parseInt(step.advanced.overrideWait) * 1000) : null,
    retryCount: parseInt(step.advanced.retryCount) || 0,
    continueOnFailure: step.advanced.continueOnFailure,
    captureScreenshot: step.advanced.captureScreenshot
  };
}

function mapBackendStepToLocal(bStep) {
  const localTypeMap = {
    NAVIGATE: 'navigate', CLICK: 'click', TYPE: 'type', SELECT: 'select',
    CHECKBOX: 'checkbox', FILE_UPLOAD: 'upload', DATE: 'date', HOVER: 'hover', VERIFY: 'verify'
  };
  const localVerMap = {
    VISIBLE: 'Visible', EXISTS: 'Exists', IMAGE: 'Image Source', ATTRIBUTE: 'Alt Text',
    VALUE: 'Value', ENABLED: 'Enabled', DISABLED: 'Disabled', CHECKED: 'Checked', TEXT: 'Text Equals'
  };

  return {
    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
    type: localTypeMap[bStep.actionType] || 'click',
    selector: bStep.selector || '',
    verificationType: bStep.actionType === 'VERIFY' ? (localVerMap[bStep.verificationType] || 'Visible') : null,
    value: bStep.actionType === 'VERIFY' ? (bStep.expectedValue || '') : (bStep.value || ''),
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
  const tag = (data.target.tag || '').toLowerCase();
  const inputType = (data.target.attributes?.type || '').toLowerCase();
  
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
  if (tag === 'input' && elData.attributes?.type === 'checkbox') return 'Checked';
  if (tag === 'select') return 'Selected Value';
  if (tag === 'input' || tag === 'button') return 'Visible';
  return 'Text Equals';
}

  // Deduplication: track last recorded step
let lastRecordedStep = { selector: '', type: '', value: '', timestamp: 0 };

function addStepFromCapture(data) {
  const type = mapActionToStepType(data);
  const selector = data.target.cssSelector || 'Unknown Element';
  const value = data.value || '';
  
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
  
  console.log('[Flow] Adding step:', { type, selector, value });
  
  // Update last recorded step
  lastRecordedStep = { selector, type, value, timestamp: eventTime };
  
  const step = {
    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
    type: type,
    selector: selector,
    value: value,
    advanced: { overrideWait: '', retryCount: 0, continueOnFailure: false, captureScreenshot: true }
  };
  
  pushState();
  if (_captureInsertIndex !== null) {
    const insertAt = _captureInsertIndex;
    state.steps.splice(insertAt, 0, step);
    _captureInsertIndex = insertAt + 1; // next capture goes right after this one
    scheduleAutoSave();
    render();
    // Scroll the inserted card into view
    setTimeout(() => {
      const cards = els.timelineSteps.querySelectorAll('.step-card');
      cards[insertAt]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 60);
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
  if (verType === 'Text Equals') {
    // Prefer elData.value (innerText) over elData.text (textContent) 
    // because Selenium's getText() respects layout and spaces like innerText.
    expectedValue = elData.value || elData.text || '';
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
  
  lastRecordedStep = { selector, type: 'verify', verificationType: verType, value: expectedValue, timestamp: eventTime };
  
  const step = {
    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
    type: 'verify',
    selector: selector,
    verificationType: verType,
    value: expectedValue,
    advanced: { overrideWait: '', retryCount: 0, continueOnFailure: false, captureScreenshot: true }
  };
  
  pushState();
  if (_captureInsertIndex !== null) {
    const insertAt = _captureInsertIndex;
    state.steps.splice(insertAt, 0, step);
    _captureInsertIndex = insertAt + 1;
    scheduleAutoSave();
    render();
    setTimeout(() => {
      const cards = els.timelineSteps.querySelectorAll('.step-card');
      cards[insertAt]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 60);
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
    container.scrollTop = container.scrollHeight;
  }, 50);
}

// ── Rendering ─────────────────────────────────────────────────────────────────
function render() {
  els.flowName.value = state.flowName;
  els.stepCount.textContent = `${state.steps.length} Steps Recorded`;
  els.defaultWait.value = state.defaultWait;
  
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
  } else if (state.isPaused) {
    els.recordingStatus.classList.remove('recording');
    els.recordingStatus.querySelector('.status-text').textContent = 'Paused';
    els.recordingStatus.querySelector('.status-dot').style.display = 'none';
    els.btnPause.classList.add('hidden');
    els.btnResume.classList.remove('hidden');
    els.btnFinish.disabled = false;
  } else {
    els.recordingStatus.classList.add('recording');
    els.recordingStatus.querySelector('.status-text').textContent = 'Recording';
    els.recordingStatus.querySelector('.status-dot').style.display = 'inline';
    els.btnPause.classList.remove('hidden');
    els.btnResume.classList.add('hidden');
    els.btnFinish.disabled = false;
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
    wait:     { icon: '⏳', title: 'Wait' }
  };
  return configs[type] || { icon: '⚡', title: 'Action' };
}

// ── Step Inserter ─────────────────────────────────────────────────────────────
// Creates the thin row between steps with the + button.
// Clicking immediately starts page-capture at that index — no panel/modal.
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
  return row;
}

// ── Capture-insert mode ───────────────────────────────────────────────────────
// _captureInsertIndex: null = normal append mode, number = insert-at mode

function captureNextAt(index) {
  _captureInsertIndex = index;
  // Ensure recording is running so the page captures the next action
  if (!state.isRecording || state.isPaused) {
    state.isRecording = true;
    state.isPaused = false;
    if (state.targetTabId) {
      chrome.runtime.sendMessage({ type: 'START_RECORDING', tabId: state.targetTabId });
    }
  }
  // Show the active inserter highlight
  render();
}

function exitInsertMode() {
  _captureInsertIndex = null;
  render();
}


function createFieldRow(label, inputHtml) {
  const row = document.createElement('div');
  row.className = 'step-field-row';
  row.innerHTML = `<div class="step-field-label">${label}</div>${inputHtml}`;
  return row;
}

function createStepCard(step, index) {
  const card = document.createElement('div');
  card.className = 'step-card';
  card.dataset.id = step.id;
  card.dataset.type = step.type;
  card.draggable = true;

  const config = getStepConfig(step.type);
  
  card.innerHTML = `
    <div class="step-number">${index + 1}</div>
    <div class="step-content">
      <div class="step-header">
        <div class="step-title-wrap">
          <span class="step-icon">${config.icon}</span>
          <span class="step-title">${config.title}</span>
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
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  
  if (step.type === 'navigate') {
    body.appendChild(createFieldRow('URL', `<input type="text" class="step-input value-update" data-field="value" value="${esc(step.value)}">`));
  } else {
    body.appendChild(createFieldRow('Selector', `<input type="text" class="step-input value-update" data-field="selector" value="${esc(step.selector)}">`));
  }
  
  if (step.type === 'type' || step.type === 'select') {
    body.appendChild(createFieldRow('Value', `<input type="text" class="step-input value-update" data-field="value" value="${esc(step.value)}">`));
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
        ${['Visible', 'Exists', 'Image Source', 'Alt Text', 'Value', 'Enabled', 'Disabled', 'Checked', 'Selected Value', 'Text Equals']
          .map(opt => `<option value="${opt}" ${step.verificationType === opt ? 'selected' : ''}>${opt}</option>`).join('')}
      </select>
    `));
    // If text equals or similar, we might need a value field
    if (['Image Source', 'Alt Text', 'Value', 'Text Equals', 'Selected Value'].includes(step.verificationType)) {
      body.appendChild(createFieldRow('Expected', `<input type="text" class="step-input value-update" data-field="value" value="${esc(step.value)}" placeholder="Expected value...">`));
    }
  } else if (step.type === 'upload') {
    body.appendChild(createFieldRow('File', `<input type="text" class="step-input value-update" data-field="value" value="${esc(step.value)}">`));
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
    render();
  });

  // Value updates
  card.querySelectorAll('.value-update').forEach(input => {
    input.addEventListener('change', (e) => {
      pushState();
      step[e.target.dataset.field] = e.target.value;
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

function bindGlobalEvents() {
  els.flowName.addEventListener('change', (e) => { state.flowName = e.target.value; scheduleAutoSave(); });
  els.defaultWait.addEventListener('change', (e) => { state.defaultWait = e.target.value; scheduleAutoSave(); });
  
  els.btnUndo.addEventListener('click', undo);
  els.btnRedo.addEventListener('click', redo);
  els.btnPause.addEventListener('click', pauseRecording);
  els.btnResume.addEventListener('click', resumeRecording);
  els.btnFinish.addEventListener('click', async () => {
    stopRecording();
    els.btnFinish.disabled = true;
    els.btnFinish.textContent = 'Saving...';

    const payload = {
      projectId: state.projectId,
      moduleId: state.moduleId,
      name: state.flowName,
      description: 'Recorded Flow',
      defaultWait: (parseFloat(state.defaultWait) || 5) * 1000,
      status: 'DRAFT',
      steps: state.steps.map(mapLocalStepToBackend)
    };

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
