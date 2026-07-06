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
  hoverBanner: document.getElementById('hover-banner')
};

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(location.search);
  state.targetTabId = parseInt(params.get('tabId')) || null;

  bindGlobalEvents();
  
  chrome.runtime.sendMessage({ type: 'POPUP_INIT' }, (res) => {
    if (res?.tabId && !state.targetTabId) state.targetTabId = res.tabId;
  });

  await loadSession();

  // Start recording immediately
  startRecording();
  render();
});

async function loadSession() {
  const data = await chrome.storage.local.get(['projectId', 'moduleId', 'flowId', 'existingFlow', 'createdBy', 'url', 'authToken']);
  state.projectId = data.projectId;
  state.moduleId = data.moduleId;
  state.flowId = data.flowId;
  state.createdBy = data.createdBy;
  state.loginUrl = data.url;
  state.authToken = data.authToken;

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
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'STEP_RECORDED') {
    if (state.isRecording && !state.isPaused && !state.isVerificationMode) {
      addStepFromCapture(msg.data);
    }
  } else if (msg.type === 'ELEMENT_CAPTURED') {
    if (state.isVerificationMode) {
      addVerificationStep(msg.data);
    }
  } else if (msg.type === 'TOGGLE_VERIFICATION_MODE') {
    toggleVerificationMode();
  } else if (msg.type === 'TOGGLE_HOVER_MODE_OFF') {
    state.isHoverCaptureMode = false;
    render();
  } else if (msg.type === 'TARGET_TAB_CHANGED') {
    state.targetTabId = msg.tabId;
    if (state.isRecording && !state.isPaused) {
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
});

// Mock keydown for Ctrl+V globally to enter verification mode
// Also send message to content script to tell it we are in verification mode
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 'v') {
    toggleVerificationMode();
  }
  if (e.key === 'Escape' && state.isVerificationMode) {
    toggleVerificationMode();
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

// ── Actions ───────────────────────────────────────────────────────────────────
function pushState() {
  undoStack.push(JSON.stringify(state.steps));
  redoStack = []; // clear redo stack on new action
}

function undo() {
  if (undoStack.length === 0) return;
  redoStack.push(JSON.stringify(state.steps));
  state.steps = JSON.parse(undoStack.pop());
  render();
}

function redo() {
  if (redoStack.length === 0) return;
  undoStack.push(JSON.stringify(state.steps));
  state.steps = JSON.parse(redoStack.pop());
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
  if (state.targetTabId) {
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING', tabId: state.targetTabId });
  }
  render();
}

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

function addStepFromCapture(data) {
  const type = mapActionToStepType(data);
  const selector = data.target.customLocator || (data.target.id ? `#${data.target.id}` : data.target.cssSelector) || 'Unknown Element';
  
  const step = {
    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
    type: type,
    selector: selector,
    value: data.value || '',
    advanced: { overrideWait: '', retryCount: 0, continueOnFailure: false, captureScreenshot: true }
  };
  
  pushState();
  state.steps.push(step);
  render();
  scrollToBottom();
}

function addVerificationStep(elData) {
  const selector = elData.customLocator || (elData.id ? `#${elData.id}` : elData.cssSelector) || 'Unknown Element';
  const verType = getSuggestedVerification(elData);
  // Use text for Text Equals, value for Value/Selected Value, empty for Visible/Exists
  let expectedValue = '';
  if (verType === 'Text Equals') {
    expectedValue = elData.text || elData.value || '';
  } else if (['Value', 'Selected Value', 'Image Source', 'Alt Text'].includes(verType)) {
    expectedValue = elData.value || elData.text || '';
  }
  
  const step = {
    id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
    type: 'verify',
    selector: selector,
    verificationType: verType,
    value: expectedValue,
    advanced: { overrideWait: '', retryCount: 0, continueOnFailure: false, captureScreenshot: true }
  };
  
  pushState();
  state.steps.push(step);
  render();
  scrollToBottom();
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
  } else {
    els.emptyState.classList.add('hidden');
    els.timelineSteps.innerHTML = '';
    state.steps.forEach((step, index) => {
      els.timelineSteps.appendChild(createStepCard(step, index));
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
  els.flowName.addEventListener('change', (e) => { state.flowName = e.target.value; });
  els.defaultWait.addEventListener('change', (e) => { state.defaultWait = e.target.value; });
  
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
      window.close();
    } catch (err) {
      alert('Failed to save flow: ' + err.message);
      els.btnFinish.disabled = false;
      els.btnFinish.textContent = 'Finish';
    }
  });
  
  els.btnCancel.addEventListener('click', () => {
    if (confirm('Are you sure you want to cancel and clear all steps?')) {
      state.steps = [];
      undoStack = [];
      redoStack = [];
      stopRecording();
      window.close();
    }
  });

  els.btnHoverCapture.addEventListener('click', toggleHoverCaptureMode);
}
