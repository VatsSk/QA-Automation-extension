// ─── overlay.js ──────────────────────────────────────────────────────────────
// Manages the visual highlight ring and rich tooltip during element capture.
// Works for captureMode: 'LOCATOR' | 'VALUE' | 'BOTH'

(function () {
  'use strict';

  if (window.__qaOverlayLoaded) return;
  window.__qaOverlayLoaded = true;

  let active = false;
  let captureMode = 'BOTH';
  let captureCallback = null;
  let lastTarget = null;
  
  // Smart Flow State
  let smartRecording = false;
  let smartPaused = false;
  let smartVerification = false;
  let smartHoverCapture = false;
  let bannerTimeout = null;

  // ── DOM elements ──────────────────────────────────────────────────────────
  const highlight = document.createElement('div');
  highlight.id = 'qa-overlay-highlight';
  highlight.style.display = 'none';

  const tooltip = document.createElement('div');
  tooltip.id = 'qa-tooltip';
  tooltip.style.display = 'none';

  const banner = document.createElement('div');
  banner.id = 'qa-capture-banner';
  banner.style.display = 'none';

  document.documentElement.appendChild(highlight);
  document.documentElement.appendChild(tooltip);
  document.documentElement.appendChild(banner);

  // ── Public API ────────────────────────────────────────────────────────────
  window.QAOverlay = {
    start(mode, callback) {
      captureMode = mode || 'BOTH';
      captureCallback = callback;
      active = true;

      document.body.classList.add('qa-capturing');
      highlight.className = `capture-${captureMode.toLowerCase()}`;
      highlight.style.display = 'block';
      tooltip.style.display = 'none';
      banner.style.display = 'none';
      banner.className = `mode-${captureMode.toLowerCase()}`;

      const modeLabel = captureMode === 'BOTH'
        ? '🎯 Click any element to capture Locator + Value'
        : captureMode === 'LOCATOR'
          ? '🎯 Click any element to capture Locator'
          : '📋 Click any element to capture Value';

      banner.innerHTML = `${modeLabel} &nbsp;·&nbsp; <kbd>Esc</kbd> to cancel`;

      document.addEventListener('mouseover', onMouseOver, true);
      document.addEventListener('mouseout', onMouseOut, true);
      document.addEventListener('mousedown', onClick, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKeyDown, true);
    },

    stop() {
      active = false;
      captureCallback = null;
      cleanup();
    },

    handleSmartCommand(command) {
      switch (command) {
        case 'START_RECORDING':
          smartRecording = true;
          smartPaused = false;
          highlight.className = 'capture-smart';
          highlight.style.display = 'block';
          document.addEventListener('mouseover', onSmartMouseOver, true);
          document.addEventListener('mouseout', onSmartMouseOut, true);
          bindSmartListeners();
          updateSmartBanner();
          break;
        case 'STOP_RECORDING':
          smartRecording = false;
          smartPaused = false;
          smartVerification = false;
          smartHoverCapture = false;
          unbindSmartListeners();
          document.removeEventListener('mouseover', onSmartMouseOver, true);
          document.removeEventListener('mouseout', onSmartMouseOut, true);
          highlight.style.display = 'none';
          tooltip.style.display = 'none';
          banner.style.display = 'none';
          cleanup();
          break;
        case 'PAUSE_RECORDING':
          smartPaused = true;
          highlight.style.display = 'none';
          document.removeEventListener('mouseover', onSmartMouseOver, true);
          document.removeEventListener('mouseout', onSmartMouseOut, true);
          updateSmartBanner();
          break;
        case 'START_VERIFICATION':
          smartVerification = true;
          active = true;
          document.body.classList.add('qa-capturing');
          highlight.className = 'capture-locator';
          highlight.style.display = 'block';
          updateSmartBanner();
          break;
        case 'STOP_VERIFICATION':
          smartVerification = false;
          highlight.className = 'capture-smart';
          if (!captureCallback) {
            active = false;
            document.body.classList.remove('qa-capturing');
            tooltip.style.display = 'none';
          }
          updateSmartBanner();
          break;
        case 'START_HOVER_CAPTURE':
          smartHoverCapture = true;
          active = true;
          document.body.classList.add('qa-capturing');
          highlight.className = 'capture-hover';
          highlight.style.display = 'block';
          updateSmartBanner();
          break;
        case 'STOP_HOVER_CAPTURE':
          smartHoverCapture = false;
          highlight.className = 'capture-smart';
          if (!captureCallback && !smartVerification) {
            active = false;
            document.body.classList.remove('qa-capturing');
            tooltip.style.display = 'none';
          }
          updateSmartBanner();
          break;
      }
    }
  };

  function updateSmartBanner() {
    clearTimeout(bannerTimeout);

    if (!smartRecording) {
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; }, 500);
      return;
    }
    
    banner.style.display = 'block';
    // Force a reflow so the opacity transition triggers if display was just changed
    void banner.offsetWidth;
    banner.style.opacity = '1';
    
    if (smartVerification) {
      banner.className = 'mode-locator';
      banner.innerHTML = `🔍 <b>Verification Mode</b> &nbsp;·&nbsp; Click element to verify &nbsp;·&nbsp; <kbd>Esc</kbd> or <kbd>Alt+Shift+Q</kbd> to exit`;
    } else if (smartHoverCapture) {
      banner.className = 'mode-value';
      banner.innerHTML = `🖐️ <b>Hover Capture Mode</b> &nbsp;·&nbsp; Click element to capture &nbsp;·&nbsp; <kbd>Esc</kbd> or <kbd>Alt+Shift+H</kbd> to exit`;
    } else if (smartPaused) {
      banner.className = 'mode-both';
      banner.innerHTML = `⏸️ <b>Recording Paused</b> &nbsp;·&nbsp; <kbd>Alt+Shift+Y</kbd> to Resume`;
    } else {
      banner.className = 'mode-both';
      banner.innerHTML = `🔴 <b>Recording Active</b> &nbsp;·&nbsp; <kbd>Alt+Shift+Y</kbd> Pause &nbsp;·&nbsp; <kbd>Alt+Shift+Q</kbd> Verify &nbsp;·&nbsp; <kbd>Alt+Shift+H</kbd> Hover`;
    }
    
    bannerTimeout = setTimeout(() => {
      banner.style.opacity = '0';
      setTimeout(() => {
        if (banner.style.opacity === '0') banner.style.display = 'none';
      }, 500);
    }, 4000);
  }
  // ── Smart Hover Highlight ────────────────────────────────────────────────
  function onSmartMouseOver(e) {
    if (!smartRecording || smartPaused) return;
    const el = e.target;
    if (el === highlight || el === tooltip || el === banner) return;

    // Only highlight interactive elements
    const interactive = findInteractiveAncestor(el);
    if (!interactive) {
      highlight.style.top = '-9999px';
      return;
    }

    const rect = interactive.getBoundingClientRect();
    highlight.style.top    = `${rect.top    - 2}px`;
    highlight.style.left   = `${rect.left   - 2}px`;
    highlight.style.width  = `${rect.width  + 4}px`;
    highlight.style.height = `${rect.height + 4}px`;

    // Build rich tooltip
    if (window.LocatorGenerator) {
      const info = window.LocatorGenerator.getElementInfo(interactive);
      renderTooltip(info, rect);
    }
  }

  function onSmartMouseOut(e) {
    if (e.relatedTarget === highlight || e.relatedTarget === tooltip) return;
    highlight.style.top = '-9999px';
    tooltip.style.display = 'none';
  }

  // ── Smart Event Listeners ─────────────────────────────────────────────────
  // ONLY listens on click. No browser events (change/input) are recorded.
  // On click, we inspect the element and create the correct step type.
  function bindSmartListeners() {
    // Listen to both mousedown and click to capture disappearing dropdown elements.
    // The strict 400ms debounce inside onSmartClick will safely ignore the redundant click.
    document.addEventListener('mousedown', onSmartClick, true);
    document.addEventListener('click', onSmartClick, true);
    document.addEventListener('keydown', onSmartKeyDown, true);
  }

  function unbindSmartListeners() {
    document.removeEventListener('mousedown', onSmartClick, true);
    document.removeEventListener('click', onSmartClick, true);
    document.removeEventListener('keydown', onSmartKeyDown, true);
  }

  function onSmartKeyDown(e) {
    if (!smartRecording) return;
    
    // Escape = Exit Verification/Hover modes
    if (e.key === 'Escape') {
      if (smartVerification) {
        e.preventDefault();
        console.log('[QA] Shortcut detected: Escape -> TOGGLE_VERIFICATION_MODE');
        document.dispatchEvent(new CustomEvent('qa-ext-shortcut', { detail: 'TOGGLE_VERIFICATION_MODE' }));
      } else if (smartHoverCapture) {
        e.preventDefault();
        console.log('[QA] Shortcut detected: Escape -> TOGGLE_HOVER_MODE');
        document.dispatchEvent(new CustomEvent('qa-ext-shortcut', { detail: 'TOGGLE_HOVER_MODE' }));
      }
    }
  }

  function dispatchSmartStep(action, el, value = '') {
    if (!smartRecording || smartPaused || smartVerification || smartHoverCapture) return;
    if (!window.LocatorGenerator) return;

    const loc = window.LocatorGenerator.generate(el);
    const info = window.LocatorGenerator.getElementInfo(el);
    
    const stepData = {
      action: action,
      target: {
        tag: info.tag,
        id: info.id,
        classes: info.classes,
        cssSelector: loc.bestLocator,
        customLocator: loc.locators.custom || '',
        attributes: { type: info.type }
      },
      value: value,
      timestamp: Date.now()
    };

    console.log('[Overlay] Dispatching step:', {
      action,
      selector: loc.bestLocator,
      element: el.tagName,
      value: value ? value.substring(0, 20) : '',
      timestamp: Date.now()
    });

    document.dispatchEvent(new CustomEvent('qa-step-recorded', { 
      detail: stepData,
      bubbles: false,  // Don't bubble to prevent multiple captures
      cancelable: false
    }));
  }

  // Walk up the DOM to find the nearest meaningful interactive element.
  // Returns null if nothing interactive is found — plain text is ignored.
  function findInteractiveAncestor(el) {
    const interactiveTags = new Set(['input', 'select', 'textarea', 'button', 'a', 'li', 'label']);
    let node = el;
    for (let i = 0; i < 6 && node && node !== document.body; i++) {
      const tag = node.tagName.toLowerCase();
      if (interactiveTags.has(tag)) return node;
      const role = node.getAttribute('role');
      if (role && ['button', 'checkbox', 'radio', 'link', 'tab', 'menuitem', 'option', 'switch'].includes(role)) return node;
      // Check for clickable attributes
      if (node.onclick || node.getAttribute('ng-click') || node.getAttribute('@click') || node.getAttribute('data-action')) return node;
      
      // Check for computed cursor:pointer (common for non-semantic React/Vue buttons)
      try {
        if (window.getComputedStyle(node).cursor === 'pointer') return node;
      } catch (e) {}
      
      node = node.parentElement;
    }
    return el; // Return original element instead of null
  }

  // Inspect the element and decide what step type to create
  function detectStepFromElement(el) {
    const tag = (el.tagName || '').toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();

    if (tag === 'input') {

        // 🚨 CRITICAL FIX: handle non-editable first
      if (el.readOnly || el.disabled) {
        return { action: 'click', value: '' };
      }
      if (['text', 'password', 'email', 'number', 'search', 'url', 'tel', ''].includes(type)) {
        return { action: 'type', value: el.value || '' };
      }
      if (type === 'checkbox') return { action: 'check', value: el.checked ? 'Checked' : 'Unchecked' };
      if (type === 'radio')    return { action: 'check', value: el.checked ? 'Selected' : 'Unselected' };
      if (type === 'file')     return { action: 'upload', value: '' };
      if (type === 'date' || type === 'datetime-local') return { action: 'date', value: el.value || '' };
      return { action: 'click', value: '' };
    }
    if (tag === 'textarea') return { action: 'type', value: el.value || '' };
    if (tag === 'select')   return { action: 'select', value: el.options?.[el.selectedIndex]?.text || el.value || '' };
    if (tag === 'button')   return { action: 'click', value: '' };
    if (tag === 'a')        return { action: 'click', value: '' };

    // Elements matched by role or click handler
    const role = el.getAttribute('role');
    if (role === 'checkbox') return { action: 'check', value: el.getAttribute('aria-checked') === 'true' ? 'Checked' : 'Unchecked' };
    if (role === 'radio')    return { action: 'check', value: el.getAttribute('aria-checked') === 'true' ? 'Selected' : 'Unselected' };
    if (role === 'switch')   return { action: 'check', value: el.getAttribute('aria-checked') === 'true' ? 'On' : 'Off' };

    return { action: 'click', value: '' };
  }

  let lastClickTime = 0;
  let lastResolvedElement = null;  // Track the resolved interactive element
  let clickDebugCounter = 0;  // Track click attempts

  function onSmartClick(e) {
    clickDebugCounter++;
    const debugId = clickDebugCounter;
    
    console.log(`[Overlay] Click #${debugId} - Event received:`, {
      type: e.type,
      target: e.target.tagName,
      targetClass: e.target.className,
      targetId: e.target.id
    });

    // Ignore clicks on the extension's own injected UI (overlay, backdrop, etc.)
    if (e.target && typeof e.target.id === 'string' && e.target.id.startsWith('qa-ext-')) return;
    
    if (!smartRecording || smartPaused) return;
    if (!e.isTrusted) return;

    // 🚨 Prevent default IMMEDIATELY for capture modes, before debounce can drop the event.
    // This ensures both 'mousedown' and the subsequent 'click' are blocked from the webpage.
    if (smartHoverCapture || smartVerification) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }

    // 🆕 STRICT Global Deduplication (Protects ALL modes: hover, verify, record)
    const now = Date.now();
    const timeSinceLastClick = now - lastClickTime;
    
    // Ignore ANY click within 400ms to absolutely prevent multi-step generation 
    if (timeSinceLastClick < 400) {
      console.log(`[Overlay] Click #${debugId} - Ignored (global debounce, ${timeSinceLastClick}ms gap)`);
      return;
    }
    
    lastClickTime = now;
    console.log(`[Overlay] Click #${debugId} - Proceeding (${timeSinceLastClick}ms gap)`);

    if (smartHoverCapture) {
      const el = e.target;
      if (el === highlight || el === tooltip || el === banner) return;

      if (window.LocatorGenerator) {
        const loc = window.LocatorGenerator.generate(el);
        const info = window.LocatorGenerator.getElementInfo(el);
        const data = {
          action: 'hover',
          target: {
            tag: info.tag,
            id: info.id,
            cssSelector: loc.bestLocator,
            customLocator: loc.locators.custom || '',
            attributes: { type: info.type }
          },
          value: '',
          timestamp: Date.now()
        };
        document.dispatchEvent(new CustomEvent('qa-step-recorded', { detail: data }));
        
        chrome.runtime.sendMessage({ type: 'TOGGLE_HOVER_MODE_OFF' });
        window.QAOverlay.handleSmartCommand('STOP_HOVER_CAPTURE');
      }
      return;
    }

    if (smartVerification) {
      const el = e.target;
      if (el === highlight || el === tooltip || el === banner) return;
      
      try {
        if (window.LocatorGenerator) {
          const loc = window.LocatorGenerator.generate(el);
          const info = window.LocatorGenerator.getElementInfo(el);
          const customLoc = loc.locators.find(l => ['data-testid', 'data-test', 'data-cy', 'data-qa'].includes(l.type))?.value || '';
          const data = {
            tag: info.tag,
            id: info.id,
            cssSelector: loc.bestLocator,
            customLocator: customLoc,
            attributes: { type: info.type },
            text: info.textContent || '',
            value: info.value || '',
            timestamp: Date.now()
          };
          document.dispatchEvent(new CustomEvent('qa-element-captured', { detail: data }));
        }
      } catch (err) {
        console.error('[QA] Smart extraction failed:', err);
      }
      return;
    }
    
    if (active && captureCallback) return;

    let el = e.target;
    if (el === highlight || el === tooltip || el === banner) return;

    // Resolve to the nearest interactive element BEFORE deduplication check
    const resolvedEl = findInteractiveAncestor(el);
    if (!resolvedEl) {
      console.log(`[Overlay] Click #${debugId} - No interactive element found, ignoring`);
      return; // Plain text click → do nothing
    }

    console.log(`[Overlay] Click #${debugId} - Resolved element:`, {
      tag: resolvedEl.tagName,
      id: resolvedEl.id,
      className: resolvedEl.className,
      ariaLabel: resolvedEl.getAttribute('aria-label')
    });

    lastResolvedElement = resolvedEl;

    const { action, value } = detectStepFromElement(resolvedEl);
    dispatchSmartStep(action, resolvedEl, value);
  }

  // ── Event handlers ────────────────────────────────────────────────────────
  function onMouseOver(e) {
    if (!active) return;
    const el = e.target;
    if (el === highlight || el === tooltip || el === banner) return;
    lastTarget = el;

    // Position highlight ring
    const rect = el.getBoundingClientRect();
    highlight.style.top    = `${rect.top    - 2}px`;
    highlight.style.left   = `${rect.left   - 2}px`;
    highlight.style.width  = `${rect.width  + 4}px`;
    highlight.style.height = `${rect.height + 4}px`;

    // Build rich tooltip
    if (window.LocatorGenerator) {
      const info = window.LocatorGenerator.getElementInfo(el);
      renderTooltip(info, rect);
    }
  }

  function onMouseOut(e) {
    if (!active) return;
    if (e.relatedTarget === highlight || e.relatedTarget === tooltip) return;
  }

  function onClick(e) {
    if (!e.isTrusted) return;

    // Prevent default immediately if active, or if we are dropping a redundant click
    const now = Date.now();
    const timeSinceLastClick = now - lastClickTime;
    
    if (active || timeSinceLastClick < 400) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    }

    if (!active || !captureCallback) return; // Only process if active
    if (timeSinceLastClick < 400) return; // Drop duplicates
    lastClickTime = now;

    let el = e.target;
    if (el === highlight || el === tooltip || el === banner) return;

    // 🚨 CRITICAL FIX: Resolve to nearest interactive element just like smart capture
    // This prevents capturing a raw <span> inside a <button> instead of the <button> itself!
    const resolvedEl = findInteractiveAncestor(el);
    if (resolvedEl) el = resolvedEl;

    const result = {};

    try {
      if ((captureMode === 'LOCATOR' || captureMode === 'BOTH') && window.LocatorGenerator) {
        const loc = window.LocatorGenerator.generate(el);
        result.locator = loc.bestLocator;
        result.confidence = loc.confidence;
        result.allLocators = loc.locators;
      }

      if ((captureMode === 'VALUE' || captureMode === 'BOTH') && window.LocatorGenerator) {
        result.value = window.LocatorGenerator.extractValue(el);
      }

      // Full element info always
      if (window.LocatorGenerator) {
        result.elementInfo = window.LocatorGenerator.getElementInfo(el);
      }
    } catch (err) {
      console.error('[QA] Extraction failed:', err);
    } finally {
      const cb = captureCallback;
      cleanup();
      if (cb) cb(captureMode, result);
    }
  }

  function onKeyDown(e) {
    if (!active) return;
    if (e.key === 'Escape') {
      if (smartVerification) {
        window.QAOverlay.handleSmartCommand('STOP_VERIFICATION');
        // Let popup know
        chrome.runtime.sendMessage({ type: 'TOGGLE_VERIFICATION_MODE' });
      } else if (smartHoverCapture) {
        window.QAOverlay.handleSmartCommand('STOP_HOVER_CAPTURE');
        chrome.runtime.sendMessage({ type: 'TOGGLE_HOVER_MODE_OFF' });
      } else {
        cleanup();
        if (captureCallback) captureCallback(captureMode, null); // null = cancelled
      }
    }
  }

  // ── Tooltip renderer ──────────────────────────────────────────────────────
  function renderTooltip(info, elRect) {
    let html = '';

    // Header: <tag>#id.class
    let tagLine = `<span class="qa-tt-tag">&lt;${info.tag}&gt;</span>`;
    if (info.id)      tagLine += ` <span class="qa-tt-id">#${info.id}</span>`;
    if (info.classes.length) {
      tagLine += ` <span class="qa-tt-class">.${info.classes.slice(0,3).join('.')}</span>`;
    }
    html += `<div class="qa-tt-row">${tagLine}</div>`;
    html += `<hr class="qa-tt-divider">`;

    // Best locator
    if (info.bestLocator) {
      html += row('Best Locator',
        `<span class="qa-tt-val locator">${esc(info.bestLocator)}</span>` +
        `<span class="qa-tt-score">${info.confidence}%</span>`
      );
    }

    // Value
    if (info.value) {
      html += row('Value', `<span class="qa-tt-val value">${esc(info.value.slice(0,60))}</span>`);
    }

    // Text content (if different from value)
    if (info.textContent && info.textContent !== info.value) {
      html += row('Text', `<span class="qa-tt-val">${esc(info.textContent.slice(0,60))}</span>`);
    }

    // Type / name / placeholder
    if (info.type)        html += row('Type',        `<span class="qa-tt-val">${esc(info.type)}</span>`);
    if (info.name)        html += row('Name',        `<span class="qa-tt-val">${esc(info.name)}</span>`);
    if (info.placeholder) html += row('Placeholder', `<span class="qa-tt-val">${esc(info.placeholder)}</span>`);

    // ARIA attributes
    const ariaKeys = Object.keys(info.ariaAttrs);
    if (ariaKeys.length) {
      html += `<hr class="qa-tt-divider">`;
      html += `<p class="qa-tt-header">ARIA</p>`;
      for (const k of ariaKeys) {
        html += row(k, `<span class="qa-tt-val aria">${esc(info.ariaAttrs[k])}</span>`);
      }
    }

    // Size
    html += `<hr class="qa-tt-divider">`;
    html += row('Size', `<span class="qa-tt-val">${info.rect.width} × ${info.rect.height}px</span>`);

    tooltip.innerHTML = html;
    tooltip.style.display = 'block';

    // Position tooltip — prefer below+right, flip if off-screen
    const tw = tooltip.offsetWidth  || 360;
    const th = tooltip.offsetHeight || 200;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top  = elRect.bottom + 8;
    let left = elRect.left;

    if (top + th > vh - 8)  top  = elRect.top - th - 8;
    if (left + tw > vw - 8) left = vw - tw - 8;
    if (top < 8)             top  = 8;
    if (left < 8)            left = 8;

    tooltip.style.top  = `${top}px`;
    tooltip.style.left = `${left}px`;
  }

  function row(label, valueHtml) {
    return `<div class="qa-tt-row">
      <span class="qa-tt-label">${label}</span>
      ${valueHtml}
    </div>`;
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  function cleanup() {
    active = false;
    lastTarget = null;
    document.body.classList.remove('qa-capturing');
    highlight.style.display = 'none';
    tooltip.style.display = 'none';
    banner.style.display = 'none';
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('mouseout', onMouseOut, true);
    document.removeEventListener('mousedown', onClick, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
  }

})();
