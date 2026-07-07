// ─── locator-generator.js ────────────────────────────────────────────────────
// Generates ranked CSS / XPath locators for any DOM element.
// Also extracts human-readable value from an element.

(function () {
  'use strict';

  window.LocatorGenerator = {

    // Returns { bestLocator, confidence, locators: [{type,value,score,note}] }
    generate(el) {
      const candidates = [];

      // 1. ID
      if (el.id && !el.id.includes('select2-')) {
        const sel = `#${CSS.escape(el.id)}`;
        candidates.push({ type: 'ID', value: sel, score: 100, note: 'Unique ID — most stable' });
      }

      // 2. data-testid / data-cy / data-qa
      const testAttrs = ['data-testid', 'data-cy', 'data-qa', 'data-test'];
      for (const attr of testAttrs) {
        const val = el.getAttribute(attr);
        if (val) {
          const sel = `[${attr}="${val}"]`;
          candidates.push({ type: attr, value: sel, score: 95, note: 'Test attribute — very stable' });
        }
      }

      // 3. name attribute (forms)
      if (el.name) {
        const sel = `${el.tagName.toLowerCase()}[name="${el.name}"]`;
        candidates.push({ type: 'name', value: sel, score: 80, note: 'Form name attribute' });
      }

      // 4. aria-label
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) {
        const sel = `[aria-label="${ariaLabel}"]`;
        candidates.push({ type: 'aria-label', value: sel, score: 75, note: 'ARIA label — accessible' });
      }

      // 5. aria-labelledby → resolved text
      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const labEl = document.getElementById(labelledBy);
        if (labEl) {
          const text = labEl.textContent.trim();
          candidates.push({ type: 'aria-labelledby', value: `[aria-labelledby="${labelledBy}"]`, score: 70, note: `Labels: "${text}"` });
        }
      }

      // 6. role
      const role = el.getAttribute('role');
      if (role) {
        const roleSel = `[role="${role}"]`;
        const unique = document.querySelectorAll(roleSel).length === 1;
        if (unique) {
          candidates.push({ type: 'role', value: roleSel, score: 65, note: 'Unique ARIA role' });
        }
      }

      // 7. Smart CSS path
      const cssPath = buildCssPath(el);
      if (cssPath) {
        const unique = document.querySelectorAll(cssPath).length === 1;
        candidates.push({ type: 'CSS', value: cssPath, score: unique ? 60 : 40, note: unique ? 'Unique CSS path' : 'CSS path (may match multiple)' });
      }

      // 8. XPath
      const xpath = buildXPath(el);
      candidates.push({ type: 'XPath', value: xpath, score: 50, note: 'Full XPath — brittle but precise' });

      // 9. Text content (buttons / links / select2)
      const text = (el.textContent || '').trim();
      const isSelect2 = (typeof el.className === 'string' && el.className.includes('select2')) || (el.id && el.id.includes('select2'));
      if (text && text.length < 60 && (isSelect2 || ['BUTTON', 'A', 'LABEL', 'SPAN', 'LI'].includes(el.tagName))) {
        const byText = `//${el.tagName.toLowerCase()}[normalize-space(.)="${text}"]`;
        candidates.push({ type: 'text', value: byText, score: isSelect2 ? 90 : 55, note: `By visible text: "${text}"` });
      }

      // Sort descending by score
      candidates.sort((a, b) => b.score - a.score);

      return {
        bestLocator: candidates[0]?.value ?? '',
        confidence: candidates[0]?.score ?? 0,
        locators: candidates
      };
    },

    // Extract visible text shown to the user — used for verification value only
    extractValue(el) {
      return (el.innerText || el.textContent || '').trim();
    },

    // Full info dump for hover tooltip
    getElementInfo(el) {
      const locatorResult = this.generate(el);
      const rect = el.getBoundingClientRect();

      // Collect all ARIA attributes
      const ariaAttrs = {};
      for (const attr of el.attributes) {
        if (attr.name.startsWith('aria-') || attr.name === 'role') {
          ariaAttrs[attr.name] = attr.value;
        }
      }

      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        classes: Array.from(el.classList),
        type: el.getAttribute('type') || null,
        name: el.getAttribute('name') || null,
        placeholder: el.getAttribute('placeholder') || null,
        value: this.extractValue(el),
        textContent: (el.textContent || '').trim().slice(0, 80),
        ariaAttrs,
        bestLocator: locatorResult.bestLocator,
        confidence: locatorResult.confidence,
        locators: locatorResult.locators,
        rect: { width: Math.round(rect.width), height: Math.round(rect.height) }
      };
    }
  };

  // ── CSS path builder ───────────────────────────────────────────────────────
  function buildCssPath(el) {
    const parts = [];
    let node = el;

    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
      let selector = node.tagName.toLowerCase();

      if (node.id && !node.id.includes('select2-')) {
        selector = `#${CSS.escape(node.id)}`;
        parts.unshift(selector);
        break; // ID is enough
      }

      // Prefer stable class
      const stableClass = Array.from(node.classList).find(c =>
        !c.match(/^(active|selected|hover|focus|disabled|open|visible|show|hide|\d)/)
      );
      if (stableClass) selector += `.${CSS.escape(stableClass)}`;

      // Add :nth-child only when needed for uniqueness
      if (node.parentElement) {
        const siblings = Array.from(node.parentElement.children).filter(s => s.tagName === node.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(node) + 1;
          selector += `:nth-of-type(${idx})`;
        }
      }

      parts.unshift(selector);
      node = node.parentElement;
    }

    return parts.join(' > ');
  }

  // ── XPath builder ─────────────────────────────────────────────────────────
  function buildXPath(el) {
    const parts = [];
    let node = el;

    while (node && node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();

      if (node.id && !node.id.includes('select2-')) {
        parts.unshift(`//${tag}[@id="${node.id}"]`);
        break;
      }

      let part = tag;
      if (node.parentElement) {
        const siblings = Array.from(node.parentElement.children).filter(s => s.tagName === node.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(node) + 1;
          part += `[${idx}]`;
        }
      }

      parts.unshift(part);
      node = node.parentElement;
    }

    // If we broke out at an ID, the first entry already has //tag[@id=...]
    if (parts[0]?.startsWith('//')) return parts.join('/');
    return '//' + parts.join('/');
  }

})();
