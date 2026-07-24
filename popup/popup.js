'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  runName: '',
  runType: 'manual',
  tags: '',
  resultStatement: '',
  scenarios: [],
  activeScenarioIdx: 0
};

let ui = {
  metaOpen: true,
  jsonOpen: false,
  compact: false
};

let activeField = null;
let isCapturing = false;
let lastCaptureResult = null;

const CSV_SCENARIO_TYPES = new Set(['URL', 'MODAL', 'FORM_MODAL']);

// URL params
const params = new URLSearchParams(location.search);
let projectId = params.get('projectId') || null;
let moduleId = params.get('moduleId') || null;
let authToken = params.get('authToken') || null;
let targetTabId = parseInt(params.get('tabId')) || null;
let editRunId = null; // set when editing an existing run

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await restoreState();
  await ensureSystemScenario();
  bindMeta();
  bindToolbar();
  bindCapturePanel();
  bindActionBar();
  bindUiToggles();
  render();
  initServiceWorker();
  setupAutoSave();
});

// ── Service worker comms ──────────────────────────────────────────────────────
function initServiceWorker() {
  chrome.runtime.sendMessage({ type: 'POPUP_INIT' }, (res) => {
    if (res?.tabId && !targetTabId) targetTabId = res.tabId;
    updateTabLabel();
  });

  // Open a persistent port for reliable message delivery from the SW
  const panelPort = chrome.runtime.connect({ name: 'qa-panel' });
  panelPort.onMessage.addListener(handleSwMessage);

  // Keep the old onMessage listener as a fallback
  chrome.runtime.onMessage.addListener(handleSwMessage);
}

function handleSwMessage(msg) {
  switch (msg.type) {
    case 'TARGET_TAB_CHANGED':
      targetTabId = msg.tabId;
      updateTabLabel();
      break;
    case 'CAPTURE_RESULT':
      handleCaptureResult(msg.captureMode, msg.result);
      break;
    case 'RELOAD_SESSION':
      restoreState().then(() => {
        ensureSystemScenario().then(() => render());
      });
      break;
  }
}

function updateTabLabel() {
  if (!targetTabId) return;
  chrome.tabs.get(targetTabId, (tab) => {
    if (chrome.runtime.lastError) return;
    const label = document.getElementById('target-tab-label');
    if (label && tab?.title) {
      label.textContent = tab.title.slice(0, 40);
      label.title = tab.title;
    }
  });
}

// ── State persistence ─────────────────────────────────────────────────────────
async function restoreState() {
  try {
    const extra = await Storage.get(['projectId', 'moduleId', 'authToken', 'runId', 'existingRun']);

    // ── New session fired from web app ────────────────────────────────────────
    if (extra.existingRun || extra.runId) {
      // Edit mode — clear draft, load existing run
      await Storage.clear();
      editRunId = extra.runId || null;
      projectId = extra.projectId || projectId;
      moduleId  = extra.moduleId  || moduleId;
      authToken = extra.authToken || authToken;
      loadExistingRun(extra.existingRun);
      await Storage.set({ runId: null, existingRun: null, projectId, moduleId, authToken });
      showToast('Editing existing run', 'success');
      return;
    }

    // Check if this is a fresh new-run trigger (projectId just written, no draft)
    const saved = await Storage.load();
    const isFreshTrigger = extra.projectId && (!saved || !saved.runName);

    if (isFreshTrigger) {
      // New run from web app — clear any stale draft
      await Storage.clear();
      projectId = extra.projectId || projectId;
      moduleId  = extra.moduleId  || moduleId;
      authToken = extra.authToken || authToken;
      editRunId = null;
      await Storage.set({ projectId, moduleId, authToken });
      return;
    }

    // ── Normal draft restore ──────────────────────────────────────────────────
    if (saved) {
      state = { ...state, ...saved };
      normalizeState();
      showToast('Draft restored', 'success');
    }

    if (!projectId && extra.projectId) projectId = extra.projectId;
    else if (projectId) await Storage.set({ projectId });

    if (!moduleId && extra.moduleId) moduleId = extra.moduleId;
    else if (moduleId) await Storage.set({ moduleId });

    if (!authToken && extra.authToken) authToken = extra.authToken;
    else if (authToken) await Storage.set({ authToken });

  } catch (e) {
    console.warn('[QA] Could not restore state:', e);
  }
}

function normalizeState() {
  state.scenarios = Array.isArray(state.scenarios) ? state.scenarios : [];
  state.scenarios.forEach((sc) => {
    if (!sc.fields) sc.fields = {};
    if (!Array.isArray(sc.assertions)) sc.assertions = [];
    if (!Array.isArray(sc.filters)) sc.filters = [];
    if (!Array.isArray(sc.columns)) sc.columns = [];
    if (!sc.dateRange) sc.dateRange = { preset: 'THIS_WEEK', custom: null };
    else if (sc.dateRange.preset) sc.dateRange.preset = String(sc.dateRange.preset).toUpperCase();
    if (!Array.isArray(sc.csvUploads)) sc.csvUploads = [];
    if (!Array.isArray(sc.initialVerifications)) sc.initialVerifications = [];
    if (!Array.isArray(sc.finalVerifications)) sc.finalVerifications = [];
  });
  if (state.activeScenarioIdx >= state.scenarios.length) {
    state.activeScenarioIdx = Math.max(0, state.scenarios.length - 1);
  }
}

// Map backend run object → extension state
function loadExistingRun(run) {
  state.runName        = run.runName        || '';
  state.runType        = run.runType        || 'manual';
  state.tags           = Array.isArray(run.tags) ? run.tags.join(', ') : (run.tags || '');
  state.resultStatement = run.resultStatement || '';

  state.scenarios = (run.scenariosList || []).map((sc) => ({
    id: sc.id || Date.now() + Math.random(),
    isSystemScenario: sc.sequenceNo === 1,
    type: sc.type || 'URL',
    fields: {
      url:         sc.url         || '',
      cssSelector: sc.cssOpener   || '',
      value:       sc.value       || '',
      clickCss:    sc.clickCss    || '',
      saveBtnCss:  sc.saveBtnCss  || '',
      applyBtnCss: sc.applyFilterBtn || '',
    },
    csv: sc.csv || '',
    assertions: (sc.assertions || []).map(a => ({
      type:       a.type,
      locator:    a.locator    || '',
      expected:   a.payload    || '',
      tableId:    a.tableId    || '',
      columnName: a.colName    || '',
      rowsBtn:    a.rowsBtn    || '',
      order:      a.order      || '',
      promptAi:   a.prompt     || '',
    })),
    filters: (sc.filters || []).map(f => ({
      locator:    f.locator    || '',
      filterType: f.filterType || '',
      value:      f.value      || '',
    })),
    columns: (sc.columns || []).map(c => ({
      name:     c.name,
      action:   c.action,
      position: c.position,
    })),
    dateRange: sc.dateRangeNavDto ? {
      preset: sc.dateRangeNavDto.preset || 'THIS_WEEK',
      custom: (sc.dateRangeNavDto.startDate || sc.dateRangeNavDto.endDate) ? {
        start: sc.dateRangeNavDto.startDate,
        end:   sc.dateRangeNavDto.endDate
      } : null
    } : { preset: 'THIS_WEEK', custom: null },
    csvUploads: [],
    initialVerifications: (sc.initialVerify || []).map(v => ({ locator: v.cssSelector || '', value: v.expectedResult || '' })),
    finalVerifications:   (sc.finalVerify   || []).map(v => ({ locator: v.cssSelector || '', value: v.expectedResult || '' })),
  }));

  state.activeScenarioIdx = 0;
}

// ── System URL scenario injection ─────────────────────────────────────────────
// Reads backend-provided login URL + CSV path from chrome.storage.local and
// ensures a system URL scenario exists at index 0 in state.scenarios.
async function ensureSystemScenario() {
  try {
    const backendData = await Storage.get(['url', 'csvPath']);
    const loginUrl = backendData.url || '';
    const csvPath = backendData.csvPath || '';

    // Check if a system scenario already exists at index 0
    const existing = state.scenarios[0];
    if (existing && existing.isSystemScenario) {
      // Update with latest backend data only if user hasn't edited the field
      if (loginUrl && !existing.fields.url) {
        existing.fields.url = loginUrl;
      }
      if (csvPath && !existing.csv) {
        existing.csv = csvPath;
      }
      return;
    }

    // Create the system URL scenario and prepend it
    const systemScenario = {
      id: 'SYSTEM_URL',
      isSystemScenario: true,
      type: 'URL',
      fields: {
        url: loginUrl
      },
      csv: csvPath,
      assertions: [],
      filters: [],
      columns: [],
      dateRange: { preset: 'THIS_WEEK', custom: null },
      csvUploads: [],
      initialVerifications: [],
      finalVerifications: []
    };

    state.scenarios.unshift(systemScenario);
    state.activeScenarioIdx = 0;
  } catch (e) {
    console.warn('[QA] Could not inject system scenario:', e);
  }
}

function setupAutoSave() {
  setInterval(persistState, 10_000);

  // Persist window size across sessions
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      chrome.storage.local.set({ winW: window.outerWidth, winH: window.outerHeight });
    }, 400);
  });
}

async function persistState() {
  try {
    await Storage.save(state);
    setSaveStatus('● Auto-saved', 'saved');
    setTimeout(() => setSaveStatus('● Draft', ''), 2000);
  } catch (e) {
    console.warn('[QA] Auto-save failed:', e);
  }
}

function setSaveStatus(text, cls) {
  const el = document.getElementById('save-status');
  if (!el) return;
  el.textContent = text;
  el.className = `save-status ${cls}`;
}

// ── Bindings ──────────────────────────────────────────────────────────────────
function bindMeta() {
  document.getElementById('run-name').addEventListener('input', (e) => {
    state.runName = e.target.value;
    persistState();
    refreshJsonIfOpen();
  });

  document.getElementById('run-type').addEventListener('change', (e) => {
    state.runType = e.target.value;
    persistState();
    refreshJsonIfOpen();
  });

  document.getElementById('run-tags').addEventListener('input', (e) => {
    state.tags = e.target.value;
    persistState();
    refreshJsonIfOpen();
  });

  document.getElementById('run-result').addEventListener('input', (e) => {
    state.resultStatement = e.target.value;
    persistState();
    refreshJsonIfOpen();
  });
}

function bindToolbar() {
  document.getElementById('btn-toggle-json')?.addEventListener('click', toggleJsonPreview);
  document.getElementById('btn-clear')?.addEventListener('click', clearRun);
  document.getElementById('btn-close')?.addEventListener('click', () => window.close());
  document.getElementById('btn-add-scenario')?.addEventListener('click', addScenario);
}

function bindUiToggles() {
  const metaBtn = document.getElementById('btn-toggle-meta');
  const metaCollapseBtn = document.getElementById('btn-meta-collapse');
  const sizeBtn = document.getElementById('btn-toggle-size');

  metaBtn?.addEventListener('click', toggleMetaSection);
  metaCollapseBtn?.addEventListener('click', toggleMetaSection);
  sizeBtn?.addEventListener('click', toggleCompactMode);
}

function bindCapturePanel() {
  document.getElementById('btn-capture-locator').addEventListener('click', () => startCapture('LOCATOR'));
  document.getElementById('btn-capture-value').addEventListener('click', () => startCapture('VALUE'));
  document.getElementById('btn-capture-both').addEventListener('click', () => startCapture('BOTH'));
  document.getElementById('btn-capture-cancel').addEventListener('click', cancelCapture);
}

function bindActionBar() {
  document.getElementById('btn-save-run').addEventListener('click', saveRun);
  document.getElementById('btn-auto-save').addEventListener('click', () => {
    persistState();
    showToast('Saved!', 'success');
  });

  document.getElementById('btn-copy-payload').addEventListener('click', async () => {
    const payload = await buildPayload();
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    showToast('Copied!', 'success');
  });
}

function toggleMetaSection() {
  ui.metaOpen = !ui.metaOpen;
  const section = document.getElementById('meta-section');
  const btn1 = document.getElementById('btn-toggle-meta');
  const btn2 = document.getElementById('btn-meta-collapse');

  section?.classList.toggle('collapsed', !ui.metaOpen);
  if (btn1) btn1.textContent = ui.metaOpen ? 'Info' : 'Show';
  if (btn2) btn2.textContent = ui.metaOpen ? 'Hide' : 'Show';
}

function toggleCompactMode() {
  ui.compact = !ui.compact;
  document.body.classList.toggle('compact', ui.compact);
  const btn = document.getElementById('btn-toggle-size');
  if (btn) btn.textContent = ui.compact ? '▢' : '▣';
  showToast(ui.compact ? 'Compact mode' : 'Expanded mode', '');
}

function toggleJsonPreview() {
  ui.jsonOpen = !ui.jsonOpen;
  const pane = document.getElementById('payload-pane');
  if (pane) pane.style.display = ui.jsonOpen ? 'block' : 'none';
  if (ui.jsonOpen) refreshJsonPreview();
}

function refreshJsonIfOpen() {
  if (ui.jsonOpen) refreshJsonPreview();
}

// ── Scenario management ───────────────────────────────────────────────────────
function addScenario() {
  const sc = {
    id: Date.now(),
    type: 'URL',
    fields: {},
    assertions: [],
    filters: [],
    columns: [],
    dateRange: { preset: 'THIS_WEEK', custom: null },
    csvUploads: [],
    initialVerifications: [],
    finalVerifications: []
  };
  state.scenarios.push(sc);
  state.activeScenarioIdx = state.scenarios.length - 1;
  render();
  persistState();
}

function removeScenario(idx) {
  // Protect the system scenario from deletion
  const sc = state.scenarios[idx];
  if (sc && sc.isSystemScenario) {
    showToast('System scenario cannot be deleted', 'error');
    return;
  }
  state.scenarios.splice(idx, 1);
  if (state.activeScenarioIdx >= state.scenarios.length) {
    state.activeScenarioIdx = Math.max(0, state.scenarios.length - 1);
  }
  activeField = null;
  render();
  persistState();
}

function setActiveScenario(idx) {
  state.activeScenarioIdx = idx;
  activeField = null;
  render();
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  normalizeState();
  renderMeta();
  renderScenarioTabs();
  renderActiveScenario();
  renderCapturePanel();
  refreshJsonIfOpen();
}

function renderMeta() {
  setVal('run-name', state.runName);
  setVal('run-type', state.runType);
  setVal('run-tags', state.tags);
  setVal('run-result', state.resultStatement);
}

function setVal(id, val) {
  const el = document.getElementById(id);
  if (el && el.value !== val) el.value = val;
}

function renderScenarioTabs() {
  const container = document.getElementById('scenario-tabs');
  container.innerHTML = '';

  state.scenarios.forEach((sc, idx) => {
    const isSystem = sc.isSystemScenario === true;
    const tab = document.createElement('div');
    tab.className = `scenario-tab${idx === state.activeScenarioIdx ? ' active' : ''}${isSystem ? ' system-scenario' : ''}`;
    tab.draggable = !isSystem; // System scenario cannot be dragged
    tab.dataset.idx = idx;

    const typeDef = TYPES[sc.type];
    const closeBtn = isSystem
      ? '' // No close button for system scenario
      : `<button class="tab-close" data-idx="${idx}" title="Remove">✕</button>`;
    const systemBadge = isSystem
      ? '<span class="tab-system-badge">SYS</span>'
      : '';

    tab.innerHTML = `
      <span class="tab-num">${idx + 1}</span>
      ${systemBadge}
      <span>${typeDef?.label ?? sc.type}</span>
      ${closeBtn}
    `;

    tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) return;
      setActiveScenario(idx);
    });

    // Only bind close button for non-system scenarios
    const closeEl = tab.querySelector('.tab-close');
    if (closeEl) {
      closeEl.addEventListener('click', (e) => {
        e.stopPropagation();
        removeScenario(idx);
      });
    }

    // Drag-and-drop (disabled for system scenario)
    if (!isSystem) {
      tab.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', idx);
        tab.classList.add('dragging');
      });

      tab.addEventListener('dragend', () => tab.classList.remove('dragging'));
    }

    tab.addEventListener('dragover', (e) => {
      e.preventDefault();
      tab.classList.add('drag-over');
    });

    tab.addEventListener('dragleave', () => tab.classList.remove('drag-over'));

    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      tab.classList.remove('drag-over');
      const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
      const toIdx = idx;
      if (fromIdx === toIdx) return;
      // Prevent dropping before the system scenario
      if (toIdx === 0 && state.scenarios[0]?.isSystemScenario) return;
      // Prevent moving the system scenario
      if (state.scenarios[fromIdx]?.isSystemScenario) return;
      const moved = state.scenarios.splice(fromIdx, 1)[0];
      state.scenarios.splice(toIdx, 0, moved);
      state.activeScenarioIdx = toIdx;
      render();
      persistState();
    });

    container.appendChild(tab);
  });
}

function renderActiveScenario() {
  const body = document.getElementById('scenario-body');
  const sc = state.scenarios[state.activeScenarioIdx];

  if (!sc) {
    body.innerHTML = `<div class="empty-state"><p>No scenarios yet.</p><p>Click <strong>+ Scenario</strong> to begin.</p></div>`;
    return;
  }

  sc.csvUploads ??= [];
  sc.initialVerifications ??= [];
  sc.finalVerifications ??= [];

  const form = document.createElement('div');
  form.className = 'scenario-form';

  const isSystem = sc.isSystemScenario === true;

  const typeRow = document.createElement('div');
  typeRow.className = 'scenario-type-row';
  typeRow.innerHTML = `<label>Type</label> <br/>`;
  const typeSelect = document.createElement('select');
  typeSelect.className = 'field-select';
  typeSelect.style.flex = '1';

  // System scenario is locked to URL type
  if (isSystem) {
    typeSelect.disabled = true;
    const opt = document.createElement('option');
    opt.value = 'URL';
    opt.textContent = 'URL (System)';
    opt.selected = true;
    typeSelect.appendChild(opt);
  } else {
    Object.entries(TYPES).forEach(([key, def]) => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = def.label;
      opt.selected = sc.type === key;
      typeSelect.appendChild(opt);
    });
  }

  typeSelect.addEventListener('change', () => {
    if (isSystem) return; // Guard: system scenario type cannot change
    sc.type = typeSelect.value;
    sc.fields = {};
    activeField = null;
    render();
    persistState();
  });

  typeRow.appendChild(typeSelect);
  form.appendChild(typeRow);

  const scType = String(sc.type).toUpperCase();

  if (scType === 'URL') {
    // 1. URL field
    const urlField = renderScenarioField(sc, 'url');
    if (urlField) form.appendChild(urlField);
    // 2. Initial Verification (after URL)
    form.appendChild(renderVerificationBuilder(sc, 'initial', 'Initial Verification'));
    // 3. CSV section
    form.appendChild(renderCsvUploadBuilder(sc));
    // 4. Final Verification (after CSV)
    form.appendChild(renderVerificationBuilder(sc, 'final', 'Final Verification'));

  } else if (scType === 'FORM_MODAL') {
    // 1. Regular fields (cssSelector, value, clickCss)
    const typeDef = TYPES[sc.type];
    if (typeDef) {
      typeDef.fields.forEach((key) => {
        const fieldEl = renderScenarioField(sc, key);
        if (fieldEl) form.appendChild(fieldEl);
      });
    }
    // 2. Initial Verification (before CSV)
    form.appendChild(renderVerificationBuilder(sc, 'initial', 'Initial Verification'));
    // 3. CSV section
    form.appendChild(renderCsvUploadBuilder(sc));
    // 4. Final Verification (after CSV)
    form.appendChild(renderVerificationBuilder(sc, 'final', 'Final Verification'));

  } else {
    // All other types
    if (CSV_SCENARIO_TYPES.has(scType)) {
      form.appendChild(renderCsvUploadBuilder(sc));
    }
    const typeDef = TYPES[sc.type];
    if (typeDef) {
      typeDef.fields.forEach((key) => {
        const fieldEl = renderScenarioField(sc, key);
        if (fieldEl) form.appendChild(fieldEl);
      });
    }
    // Final Verification at the end (skip for ASSERT)
    if (scType !== 'ASSERT') {
      form.appendChild(renderVerificationBuilder(sc, 'final', 'Final Verification'));
    }
  }

  body.innerHTML = '';
  body.appendChild(form);
}

function renderScenarioField(sc, key) {
  const idx = state.activeScenarioIdx;

  if (key === 'assertions') return renderAssertionBuilder(sc);
  if (key === 'filters') return renderFiltersBuilder(sc);
  if (key === 'dateRange') return renderDateRangeBuilder(sc);
  if (key === 'columns') return renderColumnsBuilder(sc);

  const meta = FIELD_META[key];
  if (!meta) return null;

  const isActive = activeField?.fieldKey === key && activeField?.scenarioIdx === idx;

  if (meta.captureMode === 'SYSTEM') {
    const wrap = document.createElement('div');
    wrap.className = 'scenario-field';
    wrap.innerHTML = `
      <div class="sf-header">
        <span class="sf-label">${meta.label}</span>
        <span class="sf-mode-badge text">system</span>
      </div>
    `;

    const sel = document.createElement('select');
    sel.className = 'sf-input';

    meta.options?.forEach(opt => {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      o.selected = sc.fields[key] === opt;
      sel.appendChild(o);
    });

    sel.addEventListener('change', () => {
      sc.fields[key] = sel.value;
      persistState();
      refreshJsonIfOpen();
    });

    wrap.appendChild(sel);
    return wrap;
  }

  if (meta.captureMode === 'URL') {
    const wrap = document.createElement('div');
    wrap.className = 'scenario-field';
    wrap.innerHTML = `
      <div class="sf-header">
        <span class="sf-label">${meta.label}</span>
        <span class="sf-mode-badge url">URL</span>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        <div class="sf-input-wrap" style="flex:1">
          <input type="text" class="sf-input" placeholder="${meta.placeholder || ''}"
            value="${escAttr(sc.fields[key] || '')}" autocomplete="off" spellcheck="false">
          <button class="sf-clear-btn" title="Clear field">✕</button>
        </div>
        <button class="cp-btn" style="font-size:12px;white-space:nowrap" title="Capture current tab URL">🔗 Locate URL</button>
      </div>
    `;
    const input = wrap.querySelector('.sf-input');
    input.addEventListener('input', () => { sc.fields[key] = input.value; persistState(); refreshJsonIfOpen(); });
    wrap.querySelector('.sf-clear-btn').addEventListener('click', () => { sc.fields[key] = ''; input.value = ''; persistState(); refreshJsonIfOpen(); });
    wrap.querySelector('.cp-btn').addEventListener('click', () => {
      if (!targetTabId) { showToast('No target tab', 'error'); return; }
      chrome.tabs.get(targetTabId, (tab) => {
        if (chrome.runtime.lastError || !tab?.url) { showToast('Could not get tab URL', 'error'); return; }
        sc.fields[key] = tab.url;
        input.value = tab.url;
        persistState();
        refreshJsonIfOpen();
        showToast('✓ URL captured', 'success');
      });
    });
    return wrap;
  }

  const modeClass = meta.captureMode.toLowerCase();
  const wrap = document.createElement('div');
  wrap.className = 'scenario-field';

  wrap.innerHTML = `
    <div class="sf-header">
      <span class="sf-label">${meta.label}</span>
      <span class="sf-mode-badge ${modeClass}">${meta.captureMode}</span>
    </div>
    <div style="display:flex;gap:6px;align-items:center">
      <div class="sf-input-wrap" style="flex:1">
        <input
          type="text"
          class="sf-input${isActive ? ' active-field mode-' + modeClass : ''}"
          placeholder="${meta.placeholder || ''}"
          value="${escAttr(sc.fields[key] || '')}"
          data-field="${key}"
          data-sc-idx="${idx}"
          autocomplete="off"
          spellcheck="false"
        >
        <button class="sf-clear-btn" title="Clear field">✕</button>
      </div>
      ${meta.captureMode === 'LOCATOR' ? `<button class="cp-btn locator sf-inline-cap" style="font-size:12px;white-space:nowrap">🎯</button>` : ''}
      ${meta.captureMode === 'VALUE'   ? `<button class="cp-btn value sf-inline-cap"   style="font-size:12px;white-space:nowrap">📋</button>` : ''}
    </div>
    ${isActive ? '<span class="sf-active-label">← active · click a capture button below</span>' : ''}
  `;

  const input = wrap.querySelector('.sf-input');
  const clearBtn = wrap.querySelector('.sf-clear-btn');

  input.addEventListener('focus', () => {
    activeField = { scenarioIdx: idx, fieldKey: key };
    renderCapturePanel();
  });

  input.addEventListener('input', () => {
    sc.fields[key] = input.value;
    persistState();
    refreshJsonIfOpen();
  });

  clearBtn.addEventListener('click', () => {
    sc.fields[key] = '';
    input.value = '';
    persistState();
    refreshJsonIfOpen();
  });

  const inlineCap = wrap.querySelector('.sf-inline-cap');
  if (inlineCap) {
    inlineCap.addEventListener('click', () => {
      activeField = { scenarioIdx: idx, fieldKey: key };
      startCapture(meta.captureMode);
    });
  }

  return wrap;
}

function renderCsvUploadBuilder(sc) {
  sc.csvUploads ??= [];

  const wrap = document.createElement('div');
  wrap.className = 'csv-builder';
  wrap.innerHTML = `
    <div class="csv-builder-header">
      <span class="csv-builder-title">CSV Upload</span>
      <button class="sub-builder-add" type="button">+ Add CSV</button>
    </div>

    <div class="csv-upload-zone" tabindex="0">
      <strong>Drop CSV files here</strong> or click to browse
      <div class="csv-upload-hint">Supported: .csv files. Multiple files allowed.</div>
      <input type="file" accept=".csv,text/csv" multiple style="display:none" />
    </div>

    <div class="csv-upload-list"></div>
  `;

  const zone = wrap.querySelector('.csv-upload-zone');
  const fileInput = wrap.querySelector('input[type=file]');
  const list = wrap.querySelector('.csv-upload-list');
  const addBtn = wrap.querySelector('.sub-builder-add');

  const openPicker = () => fileInput.click();

  zone.addEventListener('click', openPicker);
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openPicker();
    }
  });

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragover');
  });

  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));

  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const files = Array.from(e.dataTransfer.files || []).filter(f => f.name.toLowerCase().endsWith('.csv'));
    if (!files.length) {
      showToast('Only CSV files are allowed', 'error');
      return;
    }
    await addCsvFilesToScenario(sc, files);
    render();
    persistState();
  });

  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files || []).filter(f => f.name.toLowerCase().endsWith('.csv'));
    fileInput.value = '';
    if (!files.length) return;
    await addCsvFilesToScenario(sc, files);
    render();
    persistState();
  });

  addBtn.addEventListener('click', openPicker);

  const renderList = () => {
    list.innerHTML = '';
    if (!sc.csvUploads.length) {
      list.innerHTML = `<div class="csv-empty">No CSV files uploaded yet.</div>`;
      return;
    }

    sc.csvUploads.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'csv-upload-item';

      const kb = item.size ? (item.size / 1024).toFixed(1) : '0.0';

      row.innerHTML = `
        <div class="csv-upload-name" title="${escAttr(item.name)}">${escHtml(item.name)}</div>
        <div class="csv-upload-meta">${kb} KB</div>
        <div class="csv-upload-preview">Linked</div>
        <button class="csv-upload-remove" title="Remove CSV">✕</button>
      `;

      row.querySelector('.csv-upload-remove').addEventListener('click', () => {
        sc.csvUploads.splice(index, 1);
        sc.csv = '';
        render();
        persistState();
      });

      list.appendChild(row);
    });
  };

  renderList();
  return wrap;
}

async function addCsvFilesToScenario(sc, files) {
  const seq = state.scenarios.indexOf(sc) + 1;
  
  for (const file of files) {
    showToast(`Uploading ${file.name}...`, '');
    try {
      const res = await ApiClient.uploadCsv({
        projectId,
        moduleId,
        sequenceNo: seq,
        file,
        authToken
      });
      
      sc.csv = res.path;
      sc.csvUploads = [{
        id: res.path,
        name: file.name,
        size: file.size,
        path: res.path,
        uploadedAt: new Date().toISOString()
      }];
      
      showToast('CSV uploaded and linked!', 'success');
    } catch (e) {
      console.error('[QA] CSV Upload Error:', e);
      showToast(`Upload failed: ${e.message}`, 'error');
    }
  }
}

function renderAssertionBuilder(sc) {
  if (!sc.assertions) sc.assertions = [];
  const wrap = document.createElement('div');
  wrap.className = 'sub-builder';
  wrap.innerHTML = `
    <div class="sub-builder-header">
      <span class="sub-builder-title">Assertions</span>
      <button class="sub-builder-add">+ Add Assertion</button>
    </div>
    <div class="assertions-list"></div>
  `;

  const list = wrap.querySelector('.assertions-list');

  const renderRows = () => {
    list.innerHTML = '';
    sc.assertions.forEach((a, i) => {
      const row = document.createElement('div');
      row.className = 'sub-row';
      row.style.flexDirection = 'column';
      row.style.gap = '8px';

      const header = document.createElement('div');
      header.style.display = 'flex';
      header.style.gap = '8px';
      header.innerHTML = `
        <select style="flex:1"><option value="">Select type...</option>${Object.entries(ASSERT_TYPES).map(([k, v]) =>
          `<option value="${k}"${a.type === k ? ' selected' : ''}>${v.label}</option>`).join('')}
        </select>
        <button class="sub-remove" title="Remove">✕</button>
      `;

      const typeEl = header.querySelector('select');
      typeEl.addEventListener('change', () => {
        a.type = typeEl.value;
        renderRows();
        persistState();
        refreshJsonIfOpen();
      });

      header.querySelector('.sub-remove').addEventListener('click', () => {
        sc.assertions.splice(i, 1);
        renderRows();
        persistState();
      });

      row.appendChild(header);

      const config = ASSERT_TYPES[a.type];
      if (config) {
        config.fields.forEach(field => {
          const fieldMeta = FIELD_META[field];
          const fieldWrap = document.createElement('div');
          fieldWrap.style.display = 'flex';
          fieldWrap.style.gap = '8px';
          fieldWrap.style.alignItems = 'center';

          if (field === 'order') {
            fieldWrap.innerHTML = `
              <label style="min-width:100px">${fieldMeta?.label || field}</label>
              <select style="flex:1">${SORT_ORDER_OPTIONS.map(opt =>
                `<option value="${opt.value}"${a[field] === opt.value ? ' selected' : ''}>${opt.label}</option>`
              ).join('')}</select>
            `;
            fieldWrap.querySelector('select').addEventListener('change', e => {
              a[field] = e.target.value;
              persistState();
              refreshJsonIfOpen();
            });
          } else if (field === 'promptAi') {
            fieldWrap.innerHTML = `
              <label style="min-width:100px">${fieldMeta?.label || field}</label>
              <textarea style="flex:1" rows="2" placeholder="${fieldMeta?.placeholder || ''}">${escAttr(a[field] || '')}</textarea>
            `;
            fieldWrap.querySelector('textarea').addEventListener('input', e => {
              a[field] = e.target.value;
              persistState();
              refreshJsonIfOpen();
            });
          } else {
            const captureMode = fieldMeta?.captureMode; // 'LOCATOR' or 'VALUE'
            const showCapture = captureMode === 'LOCATOR' || captureMode === 'VALUE';
            fieldWrap.innerHTML = `
              <label style="min-width:100px">${fieldMeta?.label || field}</label>
              <input type="text" style="flex:1" placeholder="${fieldMeta?.placeholder || ''}" value="${escAttr(a[field] || '')}">
              ${showCapture ? `<button class="cp-btn ${captureMode === 'LOCATOR' ? 'locator' : 'value'} sf-capture-btn" style="padding:3px 7px;font-size:12px" title="Capture ${captureMode === 'LOCATOR' ? 'locator' : 'value'}">${captureMode === 'LOCATOR' ? '🎯' : '📋'}</button>` : ''}
            `;
            fieldWrap.querySelector('input').addEventListener('input', e => {
              a[field] = e.target.value;
              persistState();
              refreshJsonIfOpen();
            });
            if (showCapture) {
              fieldWrap.querySelector('.sf-capture-btn').addEventListener('click', () => {
                const assertKey = `__assert_${i}_${field}`;
                window.__assertCapture = { assertion: a, field };
                activeField = { scenarioIdx: state.activeScenarioIdx, fieldKey: assertKey };
                renderCapturePanel();
                startCapture(captureMode);
              });
            }
          }

          row.appendChild(fieldWrap);
        });
      }

      list.appendChild(row);
    });
  };

  renderRows();

  wrap.querySelector('.sub-builder-add').addEventListener('click', () => {
    sc.assertions.push({ type: 'ASSERT_VISIBLE' });
    renderRows();
    persistState();
  });

  return wrap;
}

function renderFiltersBuilder(sc) {
  if (!sc.filters) sc.filters = [];
  const wrap = document.createElement('div');
  wrap.className = 'sub-builder';
  wrap.innerHTML = `
    <div class="sub-builder-header">
      <span class="sub-builder-title">Filters</span>
      <button class="sub-builder-add">+ Add Filter</button>
    </div>
    <div class="filters-list"></div>
  `;

  const list = wrap.querySelector('.filters-list');

  const renderRows = () => {
    list.innerHTML = '';
    sc.filters.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'sub-row';
      row.innerHTML = `
        <input type="text" placeholder="Locator" style="flex:1.2" value="${escAttr(f.locator || '')}">
        <select>${Object.entries(FILTER_TYPES).map(([k, v]) =>
          `<option value="${k}"${f.filterType === k ? ' selected' : ''}>${v.label}</option>`).join('')}
        </select>
        <input type="text" placeholder="Value" style="flex:1" value="${escAttr(f.value || '')}">
        <button class="sub-remove">✕</button>
      `;

      const [locEl, typeEl, valEl] = row.querySelectorAll('input, select, input');
      locEl.addEventListener('input', () => { f.locator = locEl.value; persistState(); refreshJsonIfOpen(); });
      typeEl.addEventListener('change', () => { f.filterType = typeEl.value; persistState(); refreshJsonIfOpen(); });
      valEl.addEventListener('input', () => { f.value = valEl.value; persistState(); refreshJsonIfOpen(); });

      row.querySelector('.sub-remove').addEventListener('click', () => {
        sc.filters.splice(i, 1);
        renderRows();
        persistState();
      });

      list.appendChild(row);
    });
  };

  renderRows();

  wrap.querySelector('.sub-builder-add').addEventListener('click', () => {
    sc.filters.push({ locator: '', filterType: 'EQUALS', value: '' });
    renderRows();
    persistState();
  });

  return wrap;
}

function renderDateRangeBuilder(sc) {
  if (!sc.dateRange) sc.dateRange = { preset: 'THIS_WEEK', custom: null };
  const wrap = document.createElement('div');
  wrap.className = 'sub-builder';
  wrap.innerHTML = `
    <div class="sub-builder-header">
      <span class="sub-builder-title">Date Range</span>
    </div>
    <div class="sub-row">
      <label style="color:var(--text-sec);font-size:11px;min-width:50px">Preset</label>
      <select style="flex:1">
        ${Object.values(DATE_PRESET_TYPES).map(p => `<option value="${p.value}"${sc.dateRange.preset === p.value ? ' selected' : ''}>${p.label}</option>`).join('')}
        <option value="CUSTOM_RANGE"${sc.dateRange.preset === 'CUSTOM_RANGE' ? ' selected' : ''}>Custom Range</option>
      </select>
    </div>
    <div id="custom-range-row" class="sub-row" style="${sc.dateRange.preset !== 'CUSTOM_RANGE' ? 'display:none' : ''}">
      <input type="date" placeholder="Start" value="${sc.dateRange.custom?.start || ''}">
      <span style="color:var(--text-sec)">→</span>
      <input type="date" placeholder="End" value="${sc.dateRange.custom?.end || ''}">
    </div>
  `;

  const sel = wrap.querySelector('select');
  const customRow = wrap.querySelector('#custom-range-row');
  const [startEl, endEl] = wrap.querySelectorAll('input[type=date]');

  sel.addEventListener('change', () => {
    sc.dateRange.preset = sel.value;
    customRow.style.display = sel.value === 'CUSTOM_RANGE' ? '' : 'none';
    persistState();
    refreshJsonIfOpen();
  });

  startEl?.addEventListener('change', () => {
    sc.dateRange.custom = { ...sc.dateRange.custom, start: startEl.value };
    persistState();
    refreshJsonIfOpen();
  });

  endEl?.addEventListener('change', () => {
    sc.dateRange.custom = { ...sc.dateRange.custom, end: endEl.value };
    persistState();
    refreshJsonIfOpen();
  });

  return wrap;
}

function renderColumnsBuilder(sc) {
  if (!sc.columns) sc.columns = [];
  const wrap = document.createElement('div');
  wrap.className = 'sub-builder';
  wrap.innerHTML = `
    <div class="sub-builder-header">
      <span class="sub-builder-title">Columns</span>
      <button class="sub-builder-add">+ Add Column</button>
    </div>
    <div class="columns-list"></div>
  `;

  const list = wrap.querySelector('.columns-list');

  const renderRows = () => {
    list.innerHTML = '';
    sc.columns.forEach((col, i) => {
      const row = document.createElement('div');
      row.className = 'sub-row';
      row.innerHTML = `
        <input type="text" placeholder="Column name" style="flex:1.5" value="${escAttr(col.name || '')}">
        <select>${MANAGE_COLUMN_ACTIONS.map(a => `<option value="${a.value}"${col.action === a.value ? ' selected' : ''}>${a.label}</option>`).join('')}</select>
        <input type="number" placeholder="Position" style="width:70px" value="${col.position ?? ''}">
        <button class="sub-remove">✕</button>
      `;

      const [nameEl, actionEl, posEl] = row.querySelectorAll('input[type=text],select,input[type=number]');
      nameEl.addEventListener('input', () => { col.name = nameEl.value; persistState(); refreshJsonIfOpen(); });
      actionEl.addEventListener('change', () => { col.action = actionEl.value; persistState(); refreshJsonIfOpen(); });
      posEl.addEventListener('input', () => { col.position = parseInt(posEl.value) || null; persistState(); refreshJsonIfOpen(); });

      row.querySelector('.sub-remove').addEventListener('click', () => {
        sc.columns.splice(i, 1);
        renderRows();
        persistState();
      });

      list.appendChild(row);
    });
  };

  renderRows();

  wrap.querySelector('.sub-builder-add').addEventListener('click', () => {
    sc.columns.push({ name: '', action: 'SHOW', position: null });
    renderRows();
    persistState();
  });

  return wrap;
}

// ── Verification builder (Initial / Final) ────────────────────────────────────
function renderVerificationBuilder(sc, verType, title) {
  const key = verType === 'initial' ? 'initialVerifications' : 'finalVerifications';
  if (!Array.isArray(sc[key])) sc[key] = [];

  const wrap = document.createElement('div');
  wrap.className = `sub-builder verification-builder verification-${verType}`;
  wrap.innerHTML = `
    <div class="sub-builder-header">
      <span class="sub-builder-title verification-title verification-${verType}-title">${title}</span>
      <button class="sub-builder-add">+ Add Block</button>
    </div>
    <div class="verification-list"></div>
  `;

  const list = wrap.querySelector('.verification-list');

  const renderRows = () => {
    list.innerHTML = '';

    if (!sc[key].length) {
      list.innerHTML = `<div class="verification-empty">No blocks yet — click <strong>+ Add Block</strong>.</div>`;
      return;
    }

    sc[key].forEach((v, i) => {
      const row = document.createElement('div');
      row.className = 'sub-row verification-row';
      row.innerHTML = `
        <span class="verification-block-num">${i + 1}</span>
        <input type="text" class="sf-input" placeholder="Locator (CSS / XPath)" style="flex:1.5" value="${escAttr(v.locator || '')}" autocomplete="off" spellcheck="false">
        <input type="text" class="sf-input" placeholder="Expected Value" style="flex:1" value="${escAttr(v.value || '')}" autocomplete="off" spellcheck="false">
        <button class="sub-remove" title="Remove block">✕</button>
      `;

      const [locEl, valEl] = row.querySelectorAll('input');

      locEl.addEventListener('focus', () => {
        activeField = { scenarioIdx: state.activeScenarioIdx, fieldKey: `__verif_${verType}_${i}_locator` };
        renderCapturePanel();
      });
      locEl.addEventListener('input', () => {
        v.locator = locEl.value;
        persistState();
        refreshJsonIfOpen();
      });

      valEl.addEventListener('focus', () => {
        activeField = { scenarioIdx: state.activeScenarioIdx, fieldKey: `__verif_${verType}_${i}_value` };
        renderCapturePanel();
      });
      valEl.addEventListener('input', () => {
        v.value = valEl.value;
        persistState();
        refreshJsonIfOpen();
      });

      // Single ⚡ Both capture button — fills locator + value in one click
      const captureBothBtn = document.createElement('button');
      captureBothBtn.className = 'cp-btn both';
      captureBothBtn.title = 'Capture locator + expected value from page';
      captureBothBtn.textContent = '⚡ Both';
      captureBothBtn.addEventListener('click', () => {
        activeField = { scenarioIdx: state.activeScenarioIdx, fieldKey: `__verif_${verType}_${i}` };
        window.__verifCapture = { sc, key, idx: i };
        startCaptureVerif('BOTH');
      });

      row.appendChild(captureBothBtn);

      row.querySelector('.sub-remove').addEventListener('click', () => {
        sc[key].splice(i, 1);
        renderRows();
        persistState();
        refreshJsonIfOpen();
      });

      list.appendChild(row);
    });
  };

  renderRows();

  wrap.querySelector('.sub-builder-add').addEventListener('click', () => {
    sc[key].push({ locator: '', value: '' });
    renderRows();
    persistState();
  });

  return wrap;
}

// ── Verification capture helpers ───────────────────────────────────────────────
function startCaptureVerif(mode) {
  if (!targetTabId) {
    showToast('No target tab — click toolbar icon from a page first', 'error');
    return;
  }
  isCapturing = true;
  chrome.runtime.sendMessage({ type: 'START_CAPTURE', captureMode: mode }, (res) => {
    if (!res?.ok) {
      isCapturing = false;
      showToast('Could not inject capture script', 'error');
    }
  });
}

// ── Capture panel ─────────────────────────────────────────────────────────────
function renderCapturePanel() {
  const panel = document.getElementById('capture-panel');

  if (!activeField) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = 'block';
  const meta = FIELD_META[activeField.fieldKey];
  document.getElementById('cp-field-name').textContent = meta?.label ?? activeField.fieldKey;
  document.getElementById('cp-field-type').textContent = meta?.captureMode ?? '';

  const mode = meta?.captureMode;
  const btnLoc = document.getElementById('btn-capture-locator');
  const btnVal = document.getElementById('btn-capture-value');
  const btnBoth = document.getElementById('btn-capture-both');

  btnLoc.classList.toggle('active', mode === 'LOCATOR');
  btnVal.classList.toggle('active', mode === 'VALUE');
  btnBoth.classList.toggle('active', mode === 'BOTH');

  if (isCapturing) {
    btnLoc.textContent = '⏳ Locator';
    btnVal.textContent = '⏳ Value';
    btnBoth.textContent = '⏳ Both';
  } else {
    btnLoc.textContent = '🎯 Locator';
    btnVal.textContent = '📋 Value';
    btnBoth.textContent = '⚡ Both';
  }

  renderAltLocators();
}

function renderAltLocators() {
  const container = document.getElementById('alt-locators');
  const list = document.getElementById('alt-list');

  if (!lastCaptureResult?.allLocators?.length) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  list.innerHTML = '';

  lastCaptureResult.allLocators.forEach((loc) => {
    const item = document.createElement('div');
    item.className = 'alt-item';
    item.title = `Use: ${loc.value}`;
    item.innerHTML = `
      <span class="alt-type">${loc.type}</span>
      <span class="alt-value">${escHtml(loc.value)}</span>
      <span class="alt-score">${loc.score}%</span>
    `;
    item.addEventListener('click', () => {
      applyToActiveField('locator', loc.value);
      showToast(`Applied ${loc.type} locator`, 'success');
    });
    list.appendChild(item);
  });
}

// ── Capture orchestration ─────────────────────────────────────────────────────
function startCapture(mode) {
  if (!targetTabId) {
    showToast('No target tab — click toolbar icon from a page first', 'error');
    return;
  }
  if (!activeField) {
    showToast('Click a field first to activate it', 'error');
    return;
  }

  isCapturing = true;
  renderCapturePanel();

  chrome.runtime.sendMessage({ type: 'START_CAPTURE', captureMode: mode }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) {
      isCapturing = false;

      let reason = res?.error || chrome.runtime.lastError?.message || 'Unknown error';

      // Chrome returns this internal message when the SW closes the port early;
      // replace it with something actionable for the user.
      if (!res?.error && reason.includes('message port closed')) {
        reason = 'Capture failed — navigate to a normal webpage (not chrome:// or a PDF) and try again.';
      }

      // Truncate very long messages so they fit in the toast
      if (reason.length > 120) reason = reason.slice(0, 117) + '…';

      showToast(reason, 'error');
      renderCapturePanel();
    }
  });
}

function cancelCapture() {
  chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
  isCapturing = false;
  renderCapturePanel();
}

function handleCaptureResult(captureMode, result) {
  isCapturing = false;

  if (!result) {
    showToast('Capture cancelled', '');
    renderCapturePanel();
    return;
  }

  lastCaptureResult = result;

  if (!activeField) {
    renderCapturePanel();
    return;
  }

  const sc = state.scenarios[activeField.scenarioIdx];
  if (!sc) {
    renderCapturePanel();
    return;
  }

  const fieldKey = activeField.fieldKey;

  // ── Verification block capture ──────────────────────────────────────────────
  // fieldKey pattern: __verif_{initial|final}_{index}
  if (fieldKey.startsWith('__verif_')) {
    const vc = window.__verifCapture;
    if (vc) {
      if (captureMode === 'BOTH') {
        vc.sc[vc.key][vc.idx].locator = result.locator ?? '';
        vc.sc[vc.key][vc.idx].value   = result.value   ?? '';
        showToast(`✓ Locator + Value captured (${result.confidence ?? '?'}%)`, 'success');
      } else if (captureMode === 'LOCATOR') {
        vc.sc[vc.key][vc.idx].locator = result.locator ?? '';
        showToast(`✓ Locator captured (${result.confidence ?? '?'}%)`, 'success');
      } else if (captureMode === 'VALUE') {
        vc.sc[vc.key][vc.idx].value = result.value ?? '';
        showToast('✓ Value captured', 'success');
      }
      window.__verifCapture = null;
    }
    activeField = null;
    persistState();
    render();
    return;
  }

  // ── Assertion field capture ─────────────────────────────────────────────────
  if (fieldKey.startsWith('__assert_')) {
    const ac = window.__assertCapture;
    if (ac) {
      if (captureMode === 'LOCATOR') {
        ac.assertion[ac.field] = result.locator ?? '';
        showToast(`✓ Locator captured (${result.confidence ?? '?'}%)`, 'success');
      } else if (captureMode === 'VALUE') {
        ac.assertion[ac.field] = result.value ?? '';
        showToast('✓ Value captured', 'success');
      }
      window.__assertCapture = null;
    }
    activeField = null;
    persistState();
    render();
    return;
  }
  const typeDef = TYPES[sc.type];

  if (captureMode === 'BOTH') {
    if (result.locator !== undefined) sc.fields[fieldKey] = result.locator;

    if (typeDef && result.value !== undefined) {
      const valueFieldKey = typeDef.fields.find(k => {
        const m = FIELD_META[k];
        return m && m.captureMode === 'VALUE' && k !== fieldKey;
      });
      if (valueFieldKey) sc.fields[valueFieldKey] = result.value;
    }

    showToast('✓ Locator + Value captured', 'success');
  } else if (captureMode === 'LOCATOR') {
    sc.fields[fieldKey] = result.locator ?? '';
    showToast(`✓ Locator captured (${result.confidence ?? '?' }%)`, 'success');
  } else if (captureMode === 'VALUE') {
    sc.fields[fieldKey] = result.value ?? '';
    showToast('✓ Value captured', 'success');
  }

  persistState();
  render();
}

function applyToActiveField(type, value) {
  if (!activeField) return;
  const sc = state.scenarios[activeField.scenarioIdx];
  if (!sc) return;
  sc.fields[activeField.fieldKey] = value;
  persistState();
  render();
  refreshJsonIfOpen();
}

// ── JSON preview ──────────────────────────────────────────────────────────────
async function refreshJsonPreview() {
  const pre = document.getElementById('payload-content');
  if (!pre) return;
  try {
    const payload = await buildPayload();
    pre.textContent = JSON.stringify(payload, null, 2);
  } catch (e) {
    pre.textContent = 'Error building preview: ' + e.message;
  }
}

// ── Build payload ─────────────────────────────────────────────────────────────
// Builds the payload directly from state.scenarios — the system URL scenario
// is already at index 0, so no separate login scenario needs to be injected.
async function buildPayload() {
  const result = await chrome.storage.local.get(null);
  console.log('[QA Debug] All Storage Keys:', result);

  const scenariosList = state.scenarios.map((sc, i) => {
    const f = sc.fields || {};

    return {
      sequenceNo: i + 1,
      type: sc.type,
      url: f.url || null,
      cssOpener: f.cssSelector || null,
      value: f.value || null,
      clickCss: f.clickCss || null,
      applyFilterBtn: f.applyFilterBtn || null,
      saveBtnCss: f.saveBtnCss || null,
      csv: sc.csv || null,
      statement: f.statement || null,

      assertions: Array.isArray(sc.assertions) ? sc.assertions.map(a => ({
        type: a.type,
        locator: a.locator || null,
        payload: a.expected || null,
        tableId: a.tableId || null,
        colName: a.columnName || null,
        rowsBtn: a.rowsBtn || null,
        order: a.order || null,
        prompt: a.promptAi || null
      })) : [],

      filters: Array.isArray(sc.filters) ? sc.filters.map(fl => ({
        locator: fl.locator,
        filterType: fl.filterType,
        value: fl.value
      })) : [],

      dateRangeNavDto: sc.dateRange ? {
        preset: String(sc.dateRange.preset || null),
        startDate: sc.dateRange.custom?.start || null,
        endDate: sc.dateRange.custom?.end || null
      } : null,

      columns: Array.isArray(sc.columns) ? sc.columns.map(col => ({
        name: col.name,
        action: col.action,
        position: col.position
      })) : [],

      initialVerify: Array.isArray(sc.initialVerifications) ? sc.initialVerifications.map(v => ({
        cssSelector: v.locator,
        expectedResult: v.value
      })) : [],

      finalVerify: Array.isArray(sc.finalVerifications) ? sc.finalVerifications.map(v => ({
        cssSelector: v.locator,
        expectedResult: v.value
      })) : []
    };
  });

  console.log('[QA Debug] Scenarios List:', scenariosList);

  return {
    runName: state.runName,
    runType: state.runType,
    createdBy: result.createdBy,
    projectId: result.projectId,
    moduleId: result.moduleId,
    tags: state.tags.split(',').map(t => t.trim()).filter(Boolean),
    resultStatement: state.resultStatement,
    scenariosList
  };
}

// ── Validation ────────────────────────────────────────────────────────────────
function validate() {
  const errors = [];
  if (!projectId || !moduleId) {
    errors.push('Missing Project ID or Module ID. Please open from the QA platform.');
  }
  if (!state.runName.trim()) errors.push('Run Name is required');

  state.scenarios.forEach((sc, i) => {
    const label = sc.isSystemScenario ? `Scenario ${i + 1} [System]` : `Scenario ${i + 1}`;
    const required = REQUIRED[sc.type] || [];
    required.forEach(key => {
      if (!sc.fields[key]?.trim()) {
        errors.push(`${label} (${sc.type}): "${FIELD_META[key]?.label || key}" is required`);
      }
    });
  });

  return errors;
}

// ── Save run ──────────────────────────────────────────────────────────────────
async function saveRun() {
  const errors = validate();
  if (errors.length) {
    showToast(errors[0], 'error');
    return;
  }

  const payload = await buildPayload();
  console.log('[QA] Saving run payload:', payload);
  const btn = document.getElementById('btn-save-run');
  btn.disabled = true;
  btn.textContent = 'Saving…';

  try {
    if (editRunId) {
      await ApiClient.updateRun({ projectId, moduleId, runId: editRunId, authToken, payload });
    } else {
      await ApiClient.saveRun({ projectId, moduleId, authToken, payload });
    }
    await Storage.clear();
    showToast('Run saved!', 'success');
    setSaveStatus('● Saved', 'saved');
    editRunId = null;
    
    // Reset extension state
    state = {
      runName: '',
      runType: 'manual',
      tags: '',
      resultStatement: '',
      scenarios: [],
      activeScenarioIdx: 0
    };
    activeField = null;
    lastCaptureResult = null;
    await ensureSystemScenario();
    await Storage.save(state);
    render();

    // Close after a brief delay
    setTimeout(() => window.close(), 1200);
  } catch (e) {
    showToast(`Save failed: ${e.message}`, 'error');
    btn.disabled = false;
    btn.textContent = 'Save Run →';
  }
}

// ── Clear run ─────────────────────────────────────────────────────────────────
function showConfirm(msg) {
  return new Promise(resolve => {
    const overlay = document.getElementById('confirm-overlay');
    document.getElementById('confirm-msg').textContent = msg;
    overlay.style.display = 'flex';
    const ok = document.getElementById('confirm-ok');
    const cancel = document.getElementById('confirm-cancel');
    const cleanup = (result) => {
      overlay.style.display = 'none';
      ok.replaceWith(ok.cloneNode(true));
      cancel.replaceWith(cancel.cloneNode(true));
      resolve(result);
    };
    document.getElementById('confirm-ok').addEventListener('click', () => cleanup(true));
    document.getElementById('confirm-cancel').addEventListener('click', () => cleanup(false));
  });
}

async function clearRun() {
  if (!await showConfirm('Clear current run? This cannot be undone.')) return;
  state = {
    runName: '',
    runType: 'manual',
    tags: '',
    resultStatement: '',
    scenarios: [],
    activeScenarioIdx: 0
  };
  activeField = null;
  lastCaptureResult = null;
  // Re-inject the system scenario after clearing
  await ensureSystemScenario();
  await Storage.save(state);
  render();
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, type = '') {
  const existing = document.querySelectorAll('.qa-toast');
  existing.forEach(t => t.remove());

  const toast = document.createElement('div');
  toast.className = `qa-toast${type ? ' ' + type : ''}`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2800);
}

// ── Utility ───────────────────────────────────────────────────────────────────
function escAttr(s) {
  return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}