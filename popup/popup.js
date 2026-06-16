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

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await restoreState();
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

  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'TARGET_TAB_CHANGED':
        targetTabId = msg.tabId;
        updateTabLabel();
        break;
      case 'CAPTURE_RESULT':
        handleCaptureResult(msg.captureMode, msg.result);
        break;
    }
  });
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
    const saved = await Storage.load();
    if (saved) {
      state = { ...state, ...saved };
      normalizeState();
      showToast('Draft restored', 'success');
    }

    // Restore projectId/moduleId from storage if not in URL
    const extra = await Storage.get(['projectId', 'moduleId', 'authToken']);

    if (!projectId && extra.projectId) {
      projectId = extra.projectId;
    } else if (projectId) {
      await Storage.set({ projectId });
    }

    if (!moduleId && extra.moduleId) {
      moduleId = extra.moduleId;
    } else if (moduleId) {
      await Storage.set({ moduleId });
    }

    if (!authToken && extra.authToken) {
      authToken = extra.authToken;
    } else if (authToken) {
      await Storage.set({ authToken });
    }
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
  });
  if (state.activeScenarioIdx >= state.scenarios.length) {
    state.activeScenarioIdx = Math.max(0, state.scenarios.length - 1);
  }
}

function setupAutoSave() {
  setInterval(persistState, 10_000);
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
  const isFirst = state.scenarios.length === 0;
  const sc = {
    id: Date.now(),
    type: isFirst ? 'URL_NAV' : 'URL',
    fields: {},
    assertions: [],
    filters: [],
    columns: [],
    dateRange: { preset: 'THIS_WEEK', custom: null },
    csvUploads: []
  };
  state.scenarios.push(sc);
  state.activeScenarioIdx = state.scenarios.length - 1;
  render();
  persistState();
}

function removeScenario(idx) {
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
    const tab = document.createElement('div');
    tab.className = `scenario-tab${idx === state.activeScenarioIdx ? ' active' : ''}`;
    tab.draggable = true;
    tab.dataset.idx = idx;

    const typeDef = TYPES[sc.type];
    tab.innerHTML = `
      <span class="tab-num">${idx + 1}</span>
      <span>${typeDef?.label ?? sc.type}</span>
      <button class="tab-close" data-idx="${idx}" title="Remove">✕</button>
    `;

    tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) return;
      setActiveScenario(idx);
    });

    tab.querySelector('.tab-close').addEventListener('click', (e) => {
      e.stopPropagation();
      removeScenario(idx);
    });

    tab.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', idx);
      tab.classList.add('dragging');
    });

    tab.addEventListener('dragend', () => tab.classList.remove('dragging'));

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

  const form = document.createElement('div');
  form.className = 'scenario-form';

  const typeRow = document.createElement('div');
  typeRow.className = 'scenario-type-row';
  typeRow.innerHTML = `<label>Type</label>`;

  const typeSelect = document.createElement('select');
  typeSelect.className = 'field-select';
  typeSelect.style.flex = '1';

  Object.entries(TYPES).forEach(([key, def]) => {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = def.label;
    opt.selected = sc.type === key;
    typeSelect.appendChild(opt);
  });

  typeSelect.addEventListener('change', () => {
    sc.type = typeSelect.value;
    sc.fields = {};
    activeField = null;
    render();
    persistState();
  });

  typeRow.appendChild(typeSelect);
  form.appendChild(typeRow);

  if (CSV_SCENARIO_TYPES.has(String(sc.type).toUpperCase())) {
    form.appendChild(renderCsvUploadBuilder(sc));
  }

  const typeDef = TYPES[sc.type];
  if (typeDef) {
    typeDef.fields.forEach((key) => {
      const fieldEl = renderScenarioField(sc, key);
      if (fieldEl) form.appendChild(fieldEl);
    });
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

  const modeClass = meta.captureMode.toLowerCase();
  const wrap = document.createElement('div');
  wrap.className = 'scenario-field';

  wrap.innerHTML = `
    <div class="sf-header">
      <span class="sf-label">${meta.label}</span>
      <span class="sf-mode-badge ${modeClass}">${meta.captureMode}</span>
    </div>
    <div class="sf-input-wrap">
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
      row.innerHTML = `
        <select>${Object.entries(ASSERT_TYPES).map(([k, v]) =>
          `<option value="${k}"${a.type === k ? ' selected' : ''}>${v.label}</option>`).join('')}
        </select>
        <input type="text" placeholder="Locator" value="${escAttr(a.locator || '')}">
        <input type="text" placeholder="Expected value" value="${escAttr(a.expectedValue || '')}">
        <button class="sub-remove" title="Remove">✕</button>
      `;

      const [typeEl, locEl, valEl] = row.querySelectorAll('select, input, input');
      typeEl.addEventListener('change', () => { a.type = typeEl.value; persistState(); refreshJsonIfOpen(); });
      locEl.addEventListener('input', () => { a.locator = locEl.value; persistState(); refreshJsonIfOpen(); });
      valEl.addEventListener('input', () => { a.expectedValue = valEl.value; persistState(); refreshJsonIfOpen(); });

      row.querySelector('.sub-remove').addEventListener('click', () => {
        sc.assertions.splice(i, 1);
        renderRows();
        persistState();
      });

      list.appendChild(row);
    });
  };

  renderRows();

  wrap.querySelector('.sub-builder-add').addEventListener('click', () => {
    sc.assertions.push({ type: 'EQUALS', locator: '', expectedValue: '' });
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
    if (!res?.ok) {
      isCapturing = false;
      showToast('Could not inject capture script', 'error');
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
async function buildPayload() {
  const result = await chrome.storage.local.get(null);
  console.log('[QA Debug] All Storage Keys:', result);

  const prependedScenario = {
    sequenceNo: 1,
    type: 'URL_NAV',
    url: result.url || '',
    cssOpener: '',
    value: '',
    clickCss: '',
    applyFilterBtn: '',
    saveBtnCss: '',
    csv: result.csvPath || '',
    statement: '',
    assertions: [],
    filters: [],
    dateRangeNavDto: null,
    columns: []
  };
  console.log('[QA Debug] Prepend Scenario:', prependedScenario);

  const userScenarios = state.scenarios.map((sc, i) => {
    const f = sc.fields || {};

    return {
      sequenceNo: i + 2,
      type: sc.type,
      url: f.url || '',
      cssOpener: f.cssSelector || '',
      value: f.value || '',
      clickCss: f.clickCss || '',
      applyFilterBtn: f.applyFilterBtn || '',
      saveBtnCss: f.saveBtnCss || '',
      csv: sc.csv || '',
      statement: f.statement || '',

      assertions: Array.isArray(sc.assertions) ? sc.assertions.map(a => ({
        type: a.type,
        locator: a.locator,
        expectedValue: a.expectedValue
      })) : [],

      filters: Array.isArray(sc.filters) ? sc.filters.map(fl => ({
        locator: fl.locator,
        filterType: fl.filterType,
        value: fl.value
      })) : [],

      dateRangeNavDto: sc.dateRange ? {
        preset: String(sc.dateRange.preset || 'THIS_WEEK').toUpperCase(),
        startDate: sc.dateRange.custom?.start || null,
        endDate: sc.dateRange.custom?.end || null
      } : null,

      columns: Array.isArray(sc.columns) ? sc.columns.map(col => ({
        name: col.name,
        action: col.action,
        position: col.position
      })) : []
    };
  });

  return {
    runName: state.runName,
    runType: state.runType,
    createdBy: result.createdBy || 'user',
    projectId: result.projectId,
    moduleId: result.moduleId,
    tags: state.tags.split(',').map(t => t.trim()).filter(Boolean),
    resultStatement: state.resultStatement,
    scenariosList: [prependedScenario, ...userScenarios]
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
    const required = REQUIRED[sc.type] || [];
    required.forEach(key => {
      if (!sc.fields[key]?.trim()) {
        errors.push(`Scenario ${i + 1} (${sc.type}): "${FIELD_META[key]?.label || key}" is required`);
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
    await ApiClient.saveRun({ projectId, moduleId, authToken, payload });
    await Storage.clear();
    showToast('Run saved!', 'success');
    setSaveStatus('● Saved', 'saved');
    // setTimeout(() => window.close(), 1200);
  } catch (e) {
    showToast(`Save failed: ${e.message}`, 'error');
    btn.disabled = false;
    btn.textContent = 'Save Run →';
  }
}

// ── Clear run ─────────────────────────────────────────────────────────────────
function clearRun() {
  if (!confirm('Clear current run? This cannot be undone.')) return;
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
  Storage.clear();
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