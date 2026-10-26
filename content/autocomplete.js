// ─── content/autocomplete.js ──────────────────────────────────────────────────
// In-Page '#' Variable Autocomplete Overlay & Dynamic Variable Creator
// Injected into target recording tabs. Renders completely inside an isolated
// closed Shadow DOM to avoid host page styling contamination.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // Guard against multiple injections in the same frame
  if (window.__qaAutocompleteLoaded) return;
  window.__qaAutocompleteLoaded = true;

  // ── State ──────────────────────────────────────────────────────────────────
  let flowVariables = {}; // Map of variableName -> { type, length, charset, prefix, suffix }
  let activeInputElement = null;
  let isDropdownVisible = false;
  let isMiniModalVisible = false;
  let currentQuery = '';
  let queryStartIndex = -1;
  let highlightedIndex = 0;
  let filteredVariables = []; // Array of variable names matching currentQuery

  // Shadow DOM references
  let hostElement = null;
  let shadowRoot = null;
  let dropdownEl = null;
  let miniModalEl = null;

  // ── Variable Constraints & Validation Helpers ──────────────────────────────
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
      return { valid: false, error: 'Name must start with a letter and contain only letters, digits, and underscores.' };
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

  // ── Isolated Shadow DOM Setup ──────────────────────────────────────────────
  const SHADOW_STYLES = `
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      -webkit-font-smoothing: antialiased;
    }

    :host {
      all: initial;
      position: absolute;
      top: 0;
      left: 0;
      z-index: 2147483647;
      pointer-events: none;
    }

    /* Floating Autocomplete Dropdown */
    .qa-ac-popover {
      position: fixed;
      width: 320px;
      max-height: 340px;
      background: #16213e;
      border: 1px solid rgba(108, 92, 231, 0.4);
      border-radius: 8px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.05);
      color: #e0e0e0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      z-index: 2147483647;
      pointer-events: auto;
      font-size: 13px;
      animation: qa-popover-in 0.15s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes qa-popover-in {
      from { opacity: 0; transform: translateY(-4px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    .qa-ac-header {
      padding: 8px 12px;
      background: rgba(108, 92, 231, 0.15);
      border-bottom: 1px solid rgba(108, 92, 231, 0.2);
      font-size: 11px;
      font-weight: 600;
      color: #a29bfe;
      display: flex;
      justify-content: space-between;
      align-items: center;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .qa-ac-hint {
      font-size: 10px;
      color: #8c8caa;
      text-transform: none;
    }

    .qa-ac-list {
      list-style: none;
      overflow-y: auto;
      max-height: 230px;
      padding: 4px;
    }

    .qa-ac-list::-webkit-scrollbar {
      width: 6px;
    }
    .qa-ac-list::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.15);
      border-radius: 3px;
    }

    .qa-ac-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 7px 10px;
      border-radius: 5px;
      cursor: pointer;
      transition: background 0.12s ease;
      user-select: none;
      gap: 8px;
    }

    .qa-ac-item:hover, .qa-ac-item.is-selected {
      background: rgba(108, 92, 231, 0.3);
    }

    .qa-ac-item-left {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      flex: 1;
    }

    .qa-ac-hash {
      color: #6c5ce7;
      font-weight: 700;
      font-size: 14px;
    }

    .qa-ac-name {
      font-weight: 600;
      color: #ffffff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .qa-ac-name mark {
      background: transparent;
      color: #a29bfe;
      text-decoration: underline;
    }

    .qa-ac-badges {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-shrink: 0;
    }

    .qa-badge {
      font-size: 9px;
      font-weight: 700;
      padding: 2px 5px;
      border-radius: 3px;
      letter-spacing: 0.3px;
      text-transform: uppercase;
    }

    .qa-badge-string {
      background: rgba(108, 92, 231, 0.25);
      color: #a29bfe;
      border: 1px solid rgba(108, 92, 231, 0.4);
    }

    .qa-badge-number {
      background: rgba(16, 185, 129, 0.2);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.4);
    }

    .qa-badge-preview {
      font-size: 10px;
      color: #94a3b8;
      max-width: 90px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: monospace;
    }

    .qa-ac-empty {
      padding: 14px 10px;
      text-align: center;
      color: #94a3b8;
      font-size: 12px;
    }

    .qa-ac-footer {
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      background: #0f172a;
      padding: 6px 8px;
    }

    .qa-ac-btn-new {
      width: 100%;
      padding: 7px 10px;
      background: transparent;
      border: 1px dashed rgba(108, 92, 231, 0.5);
      border-radius: 5px;
      color: #a29bfe;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.15s ease;
    }

    .qa-ac-btn-new:hover, .qa-ac-btn-new.is-selected {
      background: rgba(108, 92, 231, 0.2);
      border-color: #6c5ce7;
      color: #ffffff;
    }

    /* In-Page Mini-Modal */
    .qa-modal-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0, 0, 0, 0.65);
      backdrop-filter: blur(2px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2147483647;
      pointer-events: auto;
      animation: qa-fade-in 0.15s ease;
    }

    @keyframes qa-fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .qa-modal-card {
      width: 380px;
      max-width: 92vw;
      background: #1a1a2e;
      border: 1px solid #6c5ce7;
      border-radius: 10px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(108, 92, 231, 0.3);
      color: #e0e0e0;
      overflow: hidden;
      animation: qa-modal-pop 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }

    @keyframes qa-modal-pop {
      from { opacity: 0; transform: scale(0.94) translateY(8px); }
      to { opacity: 1; transform: scale(1) translateY(0); }
    }

    .qa-modal-header {
      padding: 12px 16px;
      background: #16213e;
      border-bottom: 1px solid rgba(108, 92, 231, 0.25);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .qa-modal-title {
      font-size: 14px;
      font-weight: 700;
      color: #ffffff;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .qa-modal-title-hash {
      color: #6c5ce7;
      font-size: 16px;
    }

    .qa-modal-close-btn {
      background: none;
      border: none;
      color: #94a3b8;
      font-size: 16px;
      cursor: pointer;
      padding: 4px;
      line-height: 1;
      border-radius: 4px;
      transition: color 0.12s, background 0.12s;
    }

    .qa-modal-close-btn:hover {
      color: #ffffff;
      background: rgba(255, 255, 255, 0.1);
    }

    .qa-modal-body {
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-height: 75vh;
      overflow-y: auto;
    }

    .qa-form-row {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .qa-form-two-col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }

    .qa-label {
      font-size: 11px;
      font-weight: 600;
      color: #a29bfe;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .qa-label span {
      font-size: 10px;
      color: #718096;
      font-weight: normal;
    }

    .qa-input-wrapper {
      position: relative;
      display: flex;
      align-items: center;
    }

    .qa-input-prefix-icon {
      position: absolute;
      left: 10px;
      color: #6c5ce7;
      font-weight: 700;
      font-size: 13px;
      pointer-events: none;
    }

    .qa-input, .qa-select {
      width: 100%;
      height: 34px;
      background: #0f3460;
      border: 1px solid rgba(108, 92, 231, 0.35);
      border-radius: 6px;
      color: #ffffff;
      font-size: 12px;
      padding: 0 10px;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
    }

    .qa-input.has-prefix {
      padding-left: 24px;
    }

    .qa-input:focus, .qa-select:focus {
      border-color: #6c5ce7;
      box-shadow: 0 0 0 2px rgba(108, 92, 231, 0.3);
    }

    .qa-select option {
      background: #16213e;
      color: #ffffff;
    }

    .qa-preview-box {
      background: rgba(15, 23, 42, 0.8);
      border: 1px solid rgba(108, 92, 231, 0.25);
      border-radius: 6px;
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .qa-preview-header {
      font-size: 10px;
      font-weight: 700;
      color: #a29bfe;
      display: flex;
      justify-content: space-between;
      align-items: center;
      text-transform: uppercase;
    }

    .qa-preview-refresh {
      background: none;
      border: none;
      color: #94a3b8;
      cursor: pointer;
      font-size: 10px;
      text-decoration: underline;
    }
    .qa-preview-refresh:hover {
      color: #ffffff;
    }

    .qa-preview-val {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      color: #38bdf8;
      word-break: break-all;
      background: rgba(0, 0, 0, 0.25);
      padding: 5px 8px;
      border-radius: 4px;
    }

    .qa-error-box {
      font-size: 11px;
      color: #f87171;
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      padding: 6px 10px;
      border-radius: 4px;
      display: none;
    }

    .qa-modal-footer {
      padding: 12px 16px;
      background: #16213e;
      border-top: 1px solid rgba(108, 92, 231, 0.25);
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    .qa-btn {
      height: 32px;
      padding: 0 14px;
      border-radius: 5px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all 0.15s ease;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .qa-btn-secondary {
      background: rgba(255, 255, 255, 0.08);
      color: #cbd5e1;
      border-color: rgba(255, 255, 255, 0.1);
    }
    .qa-btn-secondary:hover {
      background: rgba(255, 255, 255, 0.15);
      color: #ffffff;
    }

    .qa-btn-primary {
      background: #6c5ce7;
      color: #ffffff;
    }
    .qa-btn-primary:hover {
      background: #5b4bc4;
      box-shadow: 0 2px 8px rgba(108, 92, 231, 0.4);
    }
    .qa-btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      box-shadow: none;
    }
  `;

  function initShadowHost() {
    if (shadowRoot) return;

    hostElement = document.createElement('div');
    hostElement.id = 'qa-var-autocomplete-host';
    document.documentElement.appendChild(hostElement);

    // Closed shadow DOM for complete CSS and DOM isolation
    shadowRoot = hostElement.attachShadow({ mode: 'closed' });

    const styleEl = document.createElement('style');
    styleEl.textContent = SHADOW_STYLES;
    shadowRoot.appendChild(styleEl);

    // Create container for dropdown
    dropdownEl = document.createElement('div');
    dropdownEl.className = 'qa-ac-popover';
    dropdownEl.style.display = 'none';
    shadowRoot.appendChild(dropdownEl);

    // Create container for mini-modal
    miniModalEl = document.createElement('div');
    miniModalEl.className = 'qa-modal-backdrop';
    miniModalEl.style.display = 'none';
    shadowRoot.appendChild(miniModalEl);
  }

  // ── Sync with Extension & Local Storage ─────────────────────────────────────
  function loadVariablesFromStorage() {
    try {
      chrome.storage.local.get(['flow_variables', 'flow_draft'], (res) => {
        if (chrome.runtime.lastError) return;
        if (res.flow_variables) {
          flowVariables = res.flow_variables;
        } else if (res.flow_draft && res.flow_draft.variables) {
          flowVariables = res.flow_draft.variables;
        }
      });
    } catch (_) {}
  }

  function fetchVariablesFromBackground() {
    try {
      chrome.runtime.sendMessage({ type: 'GET_FLOW_VARIABLES' }, (res) => {
        if (chrome.runtime.lastError) return;
        if (res && res.variables) {
          flowVariables = res.variables;
        }
      });
    } catch (_) {}
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SYNC_VARIABLES') {
      flowVariables = msg.variables || {};
      if (isDropdownVisible) renderDropdown();
      sendResponse({ ok: true });
    }
  });

  document.addEventListener('qa-sync-variables', (e) => {
    if (e.detail) {
      flowVariables = e.detail;
      if (isDropdownVisible) renderDropdown();
    }
  });

  // Initial fetch
  loadVariablesFromStorage();
  fetchVariablesFromBackground();

  // ── Cursor & Input Parsing ──────────────────────────────────────────────────
  function isEditableElement(el) {
    if (!el || !(el instanceof HTMLElement)) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return !el.readOnly && !el.disabled;
    if (tag === 'input') {
      if (el.readOnly || el.disabled) return false;
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return ['text', 'search', 'url', 'tel', 'email', 'password', ''].includes(type);
    }
    return false;
  }

  function getActiveTextAndCaret(el) {
    if (el.isContentEditable) {
      const sel = window.getSelection();
      if (!sel.rangeCount) return null;
      const range = sel.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType === Node.TEXT_NODE) {
        return {
          text: node.textContent,
          caret: range.startOffset,
          isContentEditable: true,
          node: node
        };
      }
      return null;
    }
    return {
      text: el.value || '',
      caret: el.selectionStart ?? (el.value || '').length,
      isContentEditable: false
    };
  }

  function checkForHashTrigger(el) {
    const info = getActiveTextAndCaret(el);
    if (!info) {
      hideDropdown();
      return;
    }

    const { text, caret } = info;
    const textBeforeCaret = text.slice(0, caret);

    // Look for '#' followed by word characters right up to the caret.
    // Must be preceded by start of string, space, or non-word character (e.g. "foo #em" or "#var")
    const match = textBeforeCaret.match(/(?:^|[^\w])#([A-Za-z0-9_]*)$/);
    if (match) {
      currentQuery = match[1]; // query after '#'
      queryStartIndex = caret - currentQuery.length - 1; // position of '#'
      activeInputElement = el;
      showDropdown();
    } else {
      hideDropdown();
    }
  }

  // ── Dropdown Positioning ───────────────────────────────────────────────────
  function positionDropdown() {
    if (!dropdownEl || !activeInputElement) return;

    const rect = activeInputElement.getBoundingClientRect();
    const dropdownWidth = 320;
    const estimatedHeight = Math.min(300, (filteredVariables.length * 42) + 80);

    let top = rect.bottom + 4;
    let left = rect.left;

    // Viewport overflow bounds check
    if (left + dropdownWidth > window.innerWidth - 12) {
      left = Math.max(8, window.innerWidth - dropdownWidth - 12);
    }

    // If bottom overflow, flip above input
    if (top + estimatedHeight > window.innerHeight - 8) {
      top = Math.max(8, rect.top - estimatedHeight - 4);
    }

    dropdownEl.style.top = `${top}px`;
    dropdownEl.style.left = `${left}px`;
  }

  // ── Dropdown Rendering ─────────────────────────────────────────────────────
  function filterVariables() {
    const allNames = Object.keys(flowVariables || {});
    if (!currentQuery) {
      filteredVariables = allNames;
      return;
    }

    const q = currentQuery.toLowerCase();
    // Prioritize names that start with query, then names that contain query
    const startsWith = [];
    const contains = [];

    for (const name of allNames) {
      const lower = name.toLowerCase();
      if (lower.startsWith(q)) {
        startsWith.push(name);
      } else if (lower.includes(q)) {
        contains.push(name);
      }
    }
    filteredVariables = [...startsWith, ...contains];
  }

  function renderDropdown() {
    if (!dropdownEl) return;

    filterVariables();
    const totalItems = filteredVariables.length + 1; // +1 for "+ New Variable..."
    if (highlightedIndex >= totalItems) {
      highlightedIndex = Math.max(0, totalItems - 1);
    }

    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    let listHtml = '';
    if (filteredVariables.length === 0) {
      listHtml = `<li class="qa-ac-empty">No variables matching "#${esc(currentQuery)}"</li>`;
    } else {
      filteredVariables.forEach((name, idx) => {
        const def = flowVariables[name] || {};
        const isSelected = idx === highlightedIndex;
        const typeClass = def.type === 'NUMBER' ? 'qa-badge-number' : 'qa-badge-string';
        const typeLabel = def.type || 'STRING';

        // Highlight matching query text
        let displayNameHtml = esc(name);
        if (currentQuery) {
          const matchIndex = name.toLowerCase().indexOf(currentQuery.toLowerCase());
          if (matchIndex !== -1) {
            const before = name.slice(0, matchIndex);
            const matchText = name.slice(matchIndex, matchIndex + currentQuery.length);
            const after = name.slice(matchIndex + currentQuery.length);
            displayNameHtml = `${esc(before)}<mark>${esc(matchText)}</mark>${esc(after)}`;
          }
        }

        const previewVal = generatePreviewValue(def);

        listHtml += `
          <li class="qa-ac-item ${isSelected ? 'is-selected' : ''}" data-index="${idx}" data-name="${esc(name)}">
            <div class="qa-ac-item-left">
              <span class="qa-ac-hash">#</span>
              <span class="qa-ac-name">${displayNameHtml}</span>
            </div>
            <div class="qa-ac-badges">
              <span class="qa-badge-preview" title="Sample: ${esc(previewVal)}">${esc(previewVal)}</span>
              <span class="qa-badge ${typeClass}">${typeLabel}</span>
            </div>
          </li>
        `;
      });
    }

    const isNewVarSelected = highlightedIndex === filteredVariables.length;

    dropdownEl.innerHTML = `
      <div class="qa-ac-header">
        <span>Flow Variables</span>
        <span class="qa-ac-hint">↑↓ Navigate · ↵ Select · Esc Close</span>
      </div>
      <ul class="qa-ac-list" id="qa-ac-list">
        ${listHtml}
      </ul>
      <div class="qa-ac-footer">
        <button type="button" class="qa-ac-btn-new ${isNewVarSelected ? 'is-selected' : ''}" id="qa-btn-open-mini-modal">
          <span>+</span>
          <span>New Variable...</span>
        </button>
      </div>
    `;

    // Click listeners on items
    dropdownEl.querySelectorAll('.qa-ac-item').forEach((item) => {
      item.addEventListener('mousedown', (e) => {
        e.preventDefault(); // Don't steal focus from input
        e.stopPropagation();
        const varName = item.dataset.name;
        if (varName) selectVariable(varName);
      });
    });

    const newBtn = dropdownEl.querySelector('#qa-btn-open-mini-modal');
    if (newBtn) {
      newBtn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openMiniModal(currentQuery);
      });
    }

    // Scroll active item into view
    const selectedItem = dropdownEl.querySelector('.is-selected');
    if (selectedItem) {
      selectedItem.scrollIntoView({ block: 'nearest' });
    }

    positionDropdown();
  }

  function showDropdown() {
    initShadowHost();
    isDropdownVisible = true;
    highlightedIndex = 0;
    dropdownEl.style.display = 'flex';
    renderDropdown();
  }

  function hideDropdown() {
    if (!isDropdownVisible) return;
    isDropdownVisible = false;
    if (dropdownEl) dropdownEl.style.display = 'none';
  }

  // ── Variable Selection & Framework-Safe Input Replacement ──────────────────
  function selectVariable(varName) {
    if (!activeInputElement) return;

    const el = activeInputElement;
    const token = `#${varName}`;

    if (el.isContentEditable) {
      // ContentEditable replacement
      const sel = window.getSelection();
      if (sel.rangeCount) {
        const range = sel.getRangeAt(0);
        const node = range.startContainer;
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent;
          let before = text.slice(0, queryStartIndex);
          let after = text.slice(range.startOffset);
          if (!before.trim()) {
            before = '';
          } else {
            before = before.trimEnd() + ' ';
          }
          if (!after.trim()) {
            after = '';
          }
          const finalVal = (before + token + after).trimStart();
          node.textContent = finalVal;
          // Set caret after token
          const newRange = document.createRange();
          newRange.setStart(node, Math.min(node.textContent.length, before.length + token.length));
          newRange.collapse(true);
          sel.removeAllRanges();
          sel.addRange(newRange);
        }
      }
    } else {
      // Standard input or textarea
      const text = el.value || '';
      let before = text.slice(0, queryStartIndex);
      let after = text.slice(el.selectionStart);
      // Strip accidental leading whitespace so variable does not have empty space before #
      if (!before.trim()) {
        before = '';
      } else {
        before = before.trimEnd() + ' ';
      }
      if (!after.trim()) {
        after = '';
      }
      const newValue = (before + token + after).trimStart();
      const newCaretPos = before.length + token.length;

      // React / Vue / Angular Native Prototype Setter Bypass
      const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(el, newValue);
      } else {
        el.value = newValue;
      }

      // Restore caret position
      try {
        el.setSelectionRange(newCaretPos, newCaretPos);
      } catch (_) {}

      // Dispatch standard input and change events so page frameworks register the change
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }

    hideDropdown();

    // ── Step Recording Hook ──────────────────────────────────────────────────
    // Notify overlay.js that a dynamic variable was inserted into this element
    emitVariableInsertedStep(el, varName);
  }

  function emitVariableInsertedStep(el, varName) {
    document.dispatchEvent(new CustomEvent('qa-variable-inserted', {
      detail: {
        element: el,
        variableName: varName,
        token: `#${varName}`
      }
    }));
  }

  // ── Keyboard Interception ──────────────────────────────────────────────────
  function handleKeyDown(e) {
    if (isMiniModalVisible) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeMiniModal();
      }
      return;
    }

    if (!isDropdownVisible) return;

    const totalItems = filteredVariables.length + 1; // items + "+ New Variable..."

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        highlightedIndex = (highlightedIndex + 1) % totalItems;
        renderDropdown();
        break;

      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        highlightedIndex = (highlightedIndex - 1 + totalItems) % totalItems;
        renderDropdown();
        break;

      case 'Enter':
      case 'Tab':
        e.preventDefault();
        e.stopPropagation();
        if (highlightedIndex === filteredVariables.length) {
          // Selected "+ New Variable..."
          openMiniModal(currentQuery);
        } else if (filteredVariables[highlightedIndex]) {
          selectVariable(filteredVariables[highlightedIndex]);
        }
        break;

      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        hideDropdown();
        break;

      default:
        break;
    }
  }

  // ── In-Page Mini-Modal for Defining New Variables ──────────────────────────
  function openMiniModal(initialName = '') {
    initShadowHost();
    hideDropdown();
    isMiniModalVisible = true;

    const initialClean = (initialName || '').replace(/[^A-Za-z0-9_]/g, '');

    miniModalEl.innerHTML = `
      <div class="qa-modal-card">
        <div class="qa-modal-header">
          <div class="qa-modal-title">
            <span class="qa-modal-title-hash">#</span>
            <span>New Flow Variable</span>
          </div>
          <button type="button" class="qa-modal-close-btn" id="qa-modal-btn-close" title="Close">✕</button>
        </div>

        <div class="qa-modal-body">
          <div class="qa-form-row">
            <label class="qa-label" for="qa-var-name">
              Variable Name <span>(starts with letter, no spaces)</span>
            </label>
            <div class="qa-input-wrapper">
              <span class="qa-input-prefix-icon">#</span>
              <input type="text" id="qa-var-name" class="qa-input has-prefix" placeholder="e.g. email, phone, orderId" value="${initialClean}" autocomplete="off" spellcheck="false" />
            </div>
          </div>

          <div class="qa-form-two-col">
            <div class="qa-form-row">
              <label class="qa-label" for="qa-var-charset">Charset</label>
              <select id="qa-var-charset" class="qa-select">
                <option value="ALPHANUMERIC">ALPHANUMERIC</option>
                <option value="LETTERS">LETTERS</option>
                <option value="DIGITS">DIGITS (Numbers)</option>
              </select>
            </div>
            <div class="qa-form-row">
              <label class="qa-label" for="qa-var-length">
                Length <span>(1 - 256)</span>
              </label>
              <input type="number" id="qa-var-length" class="qa-input" min="1" max="256" value="10" />
            </div>
          </div>

          <div class="qa-form-two-col">
            <div class="qa-form-row">
              <label class="qa-label" for="qa-var-prefix">Prefix <span>(optional)</span></label>
              <input type="text" id="qa-var-prefix" class="qa-input" placeholder="e.g. qa_" autocomplete="off" />
            </div>
            <div class="qa-form-row">
              <label class="qa-label" for="qa-var-suffix">Suffix <span>(optional)</span></label>
              <input type="text" id="qa-var-suffix" class="qa-input" placeholder="e.g. @test.com" autocomplete="off" />
            </div>
          </div>

          <div class="qa-preview-box">
            <div class="qa-preview-header">
              <span>⚡ Live Preview</span>
              <button type="button" class="qa-preview-refresh" id="qa-btn-regen-preview">Regenerate</button>
            </div>
            <div class="qa-preview-val" id="qa-preview-display">—</div>
          </div>

          <div class="qa-error-box" id="qa-modal-error"></div>
        </div>

        <div class="qa-modal-footer">
          <button type="button" class="qa-btn qa-btn-secondary" id="qa-modal-btn-cancel">Cancel</button>
          <button type="button" class="qa-btn qa-btn-primary" id="qa-modal-btn-save">Create & Insert</button>
        </div>
      </div>
    `;

    miniModalEl.style.display = 'flex';

    // Inputs
    const nameInput = miniModalEl.querySelector('#qa-var-name');
    const lengthInput = miniModalEl.querySelector('#qa-var-length');
    const charsetSelect = miniModalEl.querySelector('#qa-var-charset');
    const prefixInput = miniModalEl.querySelector('#qa-var-prefix');
    const suffixInput = miniModalEl.querySelector('#qa-var-suffix');
    const previewDisplay = miniModalEl.querySelector('#qa-preview-display');
    const errorBox = miniModalEl.querySelector('#qa-modal-error');
    const saveBtn = miniModalEl.querySelector('#qa-modal-btn-save');
    const cancelBtn = miniModalEl.querySelector('#qa-modal-btn-cancel');
    const closeBtn = miniModalEl.querySelector('#qa-modal-btn-close');
    const regenBtn = miniModalEl.querySelector('#qa-btn-regen-preview');

    function updatePreviewAndValidate() {
      const name = nameInput.value.trim();
      const charset = charsetSelect.value;
      const type = charset === 'DIGITS' ? 'NUMBER' : 'STRING';
      const length = parseInt(lengthInput.value, 10);
      const prefix = prefixInput.value;
      const suffix = suffixInput.value;

      // Live preview
      const preview = generatePreviewValue({
        type,
        length: isNaN(length) ? 10 : length,
        charset,
        prefix,
        suffix
      });
      previewDisplay.textContent = preview;

      // Validation
      const result = validateVariableConfig({
        name,
        type,
        length,
        charset,
        prefix,
        suffix
      }, flowVariables);

      if (!result.valid) {
        errorBox.textContent = result.error;
        errorBox.style.display = 'block';
        saveBtn.disabled = true;
      } else {
        errorBox.style.display = 'none';
        saveBtn.disabled = false;
      }
    }

    [nameInput, lengthInput, prefixInput, suffixInput].forEach((input) => {
      input.addEventListener('input', updatePreviewAndValidate);
    });

    charsetSelect.addEventListener('change', updatePreviewAndValidate);
    regenBtn.addEventListener('click', updatePreviewAndValidate);

    cancelBtn.addEventListener('click', closeMiniModal);
    closeBtn.addEventListener('click', closeMiniModal);

    saveBtn.addEventListener('click', () => {
      const name = nameInput.value.trim();
      const charset = charsetSelect.value;
      const type = charset === 'DIGITS' ? 'NUMBER' : 'STRING';
      const length = parseInt(lengthInput.value, 10);
      const prefix = prefixInput.value;
      const suffix = suffixInput.value;

      const result = validateVariableConfig({
        name,
        type,
        length,
        charset,
        prefix,
        suffix
      }, flowVariables);

      if (!result.valid) {
        errorBox.textContent = result.error;
        errorBox.style.display = 'block';
        return;
      }

      const varName = result.name;
      const varDef = result.data;

      // 1. Add to local cache immediately
      flowVariables[varName] = varDef;

      // 2. Broadcast / sync with extension background & popup
      try {
        chrome.runtime.sendMessage({
          type: 'ADD_FLOW_VARIABLE',
          name: varName,
          definition: varDef
        });
      } catch (_) {}

      // 3. Persist to chrome.storage.local
      try {
        chrome.storage.local.get(['flow_variables', 'flow_draft'], (res) => {
          const current = res.flow_variables || {};
          current[varName] = varDef;
          const updates = { flow_variables: current };
          if (res.flow_draft) {
            res.flow_draft.variables = res.flow_draft.variables || {};
            res.flow_draft.variables[varName] = varDef;
            updates.flow_draft = res.flow_draft;
          }
          chrome.storage.local.set(updates);
        });
      } catch (_) {}

      // 4. Close mini-modal and insert into active input
      closeMiniModal();
      selectVariable(varName);
    });

    // Initial state
    updatePreviewAndValidate();
    setTimeout(() => nameInput.focus(), 50);
  }

  function closeMiniModal() {
    isMiniModalVisible = false;
    if (miniModalEl) miniModalEl.style.display = 'none';
    if (activeInputElement) {
      try { activeInputElement.focus(); } catch (_) {}
    }
  }

  // ── Document Event Listeners ───────────────────────────────────────────────
  document.addEventListener('input', (e) => {
    if (!isEditableElement(e.target)) return;
    checkForHashTrigger(e.target);
  }, true);

  document.addEventListener('keydown', (e) => {
    if (isDropdownVisible || isMiniModalVisible) {
      handleKeyDown(e);
    }
  }, true);

  document.addEventListener('click', (e) => {
    if (!isDropdownVisible) return;
    // If click is outside the shadow root host, hide dropdown
    if (e.target !== hostElement && !hostElement.contains(e.target)) {
      hideDropdown();
    }
  }, true);

  window.addEventListener('scroll', () => {
    if (isDropdownVisible) positionDropdown();
  }, { passive: true });

  window.addEventListener('resize', () => {
    if (isDropdownVisible) positionDropdown();
  });

  document.addEventListener('selectionchange', () => {
    if (!isDropdownVisible || !activeInputElement) return;
    if (document.activeElement !== activeInputElement) {
      hideDropdown();
      return;
    }
    checkForHashTrigger(activeInputElement);
  });

  console.log('[QA Autocomplete] In-page dynamic variable autocomplete initialized.');
})();
