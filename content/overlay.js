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
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKeyDown, true);
    },

    stop() {
      active = false;
      captureCallback = null;
      cleanup();
    }
  };

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
    if (!active) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const el = e.target;
    if (el === highlight || el === tooltip || el === banner) return;

    const result = {};

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

    const cb = captureCallback;
    cleanup();

    if (cb) cb(captureMode, result);
  }

  function onKeyDown(e) {
    if (!active) return;
    if (e.key === 'Escape') {
      cleanup();
      if (captureCallback) captureCallback(captureMode, null); // null = cancelled
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
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
  }

})();
