// ─── locator-generator.js ────────────────────────────────────────────────────
// Generates stable, automation-friendly CSS / XPath locators for any DOM element.
// Avoids dynamic IDs, DOM positions, and framework-generated classes.

(function () {
  'use strict';

  // ── Dynamic ID Detection Patterns ──────────────────────────────────────────
  const DYNAMIC_ID_PATTERNS = [
    /^[a-fA-F0-9]{24}$/,           // Mongo ObjectId
    /^[0-9a-fA-F-]{32,}$/,         // UUID
    /^[a-fA-F0-9]{16,}$/,          // Long hex strings
    /^[0-9]{6,}$/,                 // Mostly numeric
    /^[A-Za-z0-9_-]{16,}$/,        // Long random alphanumeric
    /^(select2-|css-|jss|react-|ember|MuiPaper|chakra|ant-)/ // Framework prefixes
  ];

  // ── Framework/Dynamic Class Patterns ───────────────────────────────────────
  const UNSTABLE_CLASS_PATTERNS = [
    /^(active|selected|focus|hover|disabled|open|visible|show|hide|checked|collapsed|expanded)$/i,
    /^ng-/,
    /^css-[a-zA-Z0-9]+$/,
    /^Mui/,
    /^chakra-/,
    /^ant-/,
    /^mat-/,
    /^v-/,
    /^react-/,
    /^ember/,
    /^jss\d+/,
    /^_[a-zA-Z0-9]{5,}$/, // Hash-like classes
    /^\d+$/                // Pure numeric classes
  ];

  window.LocatorGenerator = {

    // Returns { bestLocator, confidence, locators: [{type,value,score,note}] }
    generate(el) {
      const candidates = [];

      // Step 1: Check for stable attributes on the element itself
      this._generateStableLocators(el, candidates);

      // Step 2: Only if no unique stable locator found, try parent context
      const hasUniqueStable = candidates.some(c => c.score >= 80 && this._isUnique(c.value, c.type));
      if (!hasUniqueStable) {
        this._generateContextualLocators(el, candidates);
      }

      // Step 3: Fallback to text-based locators (only for interactive elements)
      if (candidates.length === 0 || !hasUniqueStable) {
        this._generateTextBasedLocators(el, candidates);
      }

      // Step 4: Last resort - smart CSS/XPath (avoid position-based)
      if (candidates.length === 0) {
        this._generateFallbackLocators(el, candidates);
      }

      // Verify uniqueness and adjust scores
      candidates.forEach(candidate => {
        const isUnique = this._isUnique(candidate.value, candidate.type);
        if (!isUnique && candidate.score > 50) {
          candidate.score = Math.min(candidate.score, 45);
          candidate.note += ' (⚠ not unique)';
        }
      });

      // Sort descending by score
      candidates.sort((a, b) => b.score - a.score);

      return {
        bestLocator: candidates[0]?.value ?? '',
        confidence: candidates[0]?.score ?? 0,
        locators: candidates
      };
    },

    // ── Generate stable attribute-based locators ──────────────────────────────
    _generateStableLocators(el, candidates) {
      // Priority 1: data-testid
      const testid = el.getAttribute('data-testid');
      if (testid) {
        candidates.push({ 
          type: 'data-testid', 
          value: `[data-testid="${this._escapeAttr(testid)}"]`, 
          score: 100, 
          note: 'data-testid — most stable' 
        });
      }

      // Priority 2: data-test
      const dataTest = el.getAttribute('data-test');
      if (dataTest) {
        candidates.push({ 
          type: 'data-test', 
          value: `[data-test="${this._escapeAttr(dataTest)}"]`, 
          score: 98, 
          note: 'data-test — very stable' 
        });
      }

      // Priority 3: data-cy
      const dataCy = el.getAttribute('data-cy');
      if (dataCy) {
        candidates.push({ 
          type: 'data-cy', 
          value: `[data-cy="${this._escapeAttr(dataCy)}"]`, 
          score: 98, 
          note: 'data-cy (Cypress) — very stable' 
        });
      }

      // Priority 4: data-qa
      const dataQa = el.getAttribute('data-qa');
      if (dataQa) {
        candidates.push({ 
          type: 'data-qa', 
          value: `[data-qa="${this._escapeAttr(dataQa)}"]`, 
          score: 98, 
          note: 'data-qa — very stable' 
        });
      }

      // Priority 5: name (for form elements)
      const name = el.getAttribute('name');
      if (name) {
        const tag = el.tagName.toLowerCase();
        candidates.push({ 
          type: 'name', 
          value: `${tag}[name="${this._escapeAttr(name)}"]`, 
          score: 90, 
          note: 'name attribute — stable for forms' 
        });
        // XPath alternative
        candidates.push({ 
          type: 'name-xpath', 
          value: `//${tag}[@name="${this._escapeAttr(name)}"]`, 
          score: 88, 
          note: 'name attribute (XPath)' 
        });
      }

      // Priority 6: aria-label
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) {
        candidates.push({ 
          type: 'aria-label', 
          value: `[aria-label="${this._escapeAttr(ariaLabel)}"]`, 
          score: 85, 
          note: 'aria-label — accessible & stable' 
        });
      }

      // Priority 7: role (only if unique)
      const role = el.getAttribute('role');
      if (role) {
        const roleSel = `[role="${this._escapeAttr(role)}"]`;
        candidates.push({ 
          type: 'role', 
          value: roleSel, 
          score: 80, 
          note: 'ARIA role' 
        });
      }

      // Priority 8: Stable ID (non-dynamic)
      if (el.id && !this._isDynamicId(el.id)) {
        const sel = `#${CSS.escape(el.id)}`;
        candidates.push({ 
          type: 'ID', 
          value: sel, 
          score: 95, 
          note: 'Stable ID' 
        });
      }

      // Priority 9: Semantic classes
      const semanticClasses = this._getSemanticClasses(el);
      if (semanticClasses.length > 0) {
        const tag = el.tagName.toLowerCase();
        const classSelector = semanticClasses.map(c => `.${CSS.escape(c)}`).join('');
        candidates.push({ 
          type: 'semantic-class', 
          value: `${tag}${classSelector}`, 
          score: 75, 
          note: `Semantic class: ${semanticClasses.join('.')}` 
        });
      }

      // Priority 10: Custom data-* attributes (stable)
      Array.from(el.attributes).forEach(attr => {
        if (attr.name.startsWith('data-') && 
            !['data-testid', 'data-test', 'data-cy', 'data-qa'].includes(attr.name) &&
            !this._isDynamicValue(attr.value)) {
          candidates.push({ 
            type: attr.name, 
            value: `[${attr.name}="${this._escapeAttr(attr.value)}"]`, 
            score: 70, 
            note: `Custom ${attr.name} attribute` 
          });
        }
      });

      // Priority 11: href (for links)
      const href = el.getAttribute('href');
      if (href && !this._isDynamicValue(href)) {
        candidates.push({ 
          type: 'href', 
          value: `a[href="${this._escapeAttr(href)}"]`, 
          score: 70, 
          note: 'Stable href' 
        });
      }

      // Priority 12: title
      const title = el.getAttribute('title');
      if (title) {
        candidates.push({ 
          type: 'title', 
          value: `[title="${this._escapeAttr(title)}"]`, 
          score: 65, 
          note: 'title attribute' 
        });
      }

      // Priority 13: placeholder (for inputs)
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) {
        const tag = el.tagName.toLowerCase();
        candidates.push({ 
          type: 'placeholder', 
          value: `${tag}[placeholder="${this._escapeAttr(placeholder)}"]`, 
          score: 65, 
          note: 'placeholder attribute' 
        });
      }
    },

    // ── Generate contextual locators (with parent) ────────────────────────────
    _generateContextualLocators(el, candidates) {
      // Combine semantic class with stable attribute
      const semanticClasses = this._getSemanticClasses(el);
      if (semanticClasses.length > 0) {
        const tag = el.tagName.toLowerCase();
        const classSelector = semanticClasses.map(c => `.${CSS.escape(c)}`).join('');
        
        // Try combining with data attributes
        const dataTarget = el.getAttribute('data-target');
        if (dataTarget) {
          candidates.push({ 
            type: 'class+data', 
            value: `${tag}${classSelector}[data-target="${this._escapeAttr(dataTarget)}"]`, 
            score: 85, 
            note: 'Semantic class + data-target' 
          });
        }

        const href = el.getAttribute('href');
        if (href && !this._isDynamicValue(href)) {
          candidates.push({ 
            type: 'class+href', 
            value: `${tag}${classSelector}[href="${this._escapeAttr(href)}"]`, 
            score: 82, 
            note: 'Semantic class + href' 
          });
        }
      }

      // Check parent for stable context
      const parent = el.parentElement;
      if (parent && parent !== document.body) {
        const parentId = parent.id;
        if (parentId && !this._isDynamicId(parentId)) {
          const tag = el.tagName.toLowerCase();
          const childClasses = semanticClasses.length > 0 
            ? semanticClasses.map(c => `.${CSS.escape(c)}`).join('') 
            : '';
          candidates.push({ 
            type: 'parent-id', 
            value: `#${CSS.escape(parentId)} > ${tag}${childClasses}`, 
            score: 78, 
            note: 'Parent ID + child selector' 
          });
        }
      }
    },

    // ── Generate text-based locators ──────────────────────────────────────────
    _generateTextBasedLocators(el, candidates) {
      const text = (el.textContent || '').trim();
      const tag = el.tagName.toLowerCase();
      
      // Only for interactive elements with reasonable text length
      if (text && text.length > 0 && text.length < 80 && 
          ['button', 'a', 'label', 'span', 'li', 'td', 'th', 'div'].includes(tag)) {
        
        // Exact text match
        candidates.push({ 
          type: 'text-xpath', 
          value: `//${tag}[normalize-space(.)="${this._escapeXPath(text)}"]`, 
          score: 60, 
          note: `By exact text: "${text.slice(0, 40)}${text.length > 40 ? '...' : ''}"` 
        });

        // Partial text match (contains)
        if (text.length > 10) {
          candidates.push({ 
            type: 'text-contains', 
            value: `//${tag}[contains(normalize-space(.), "${this._escapeXPath(text)}")]`, 
            score: 55, 
            note: `Contains text: "${text.slice(0, 40)}${text.length > 40 ? '...' : ''}"` 
          });
        }
      }
    },

    // ── Generate fallback locators (avoid position) ───────────────────────────
    _generateFallbackLocators(el, candidates) {
      // Smart CSS path without nth-child
      const cssPath = this._buildSmartCssPath(el);
      if (cssPath) {
        candidates.push({ 
          type: 'CSS', 
          value: cssPath, 
          score: 50, 
          note: 'CSS path (no positions)' 
        });
      }

      // Smart XPath without positions
      const xpathSmart = this._buildSmartXPath(el);
      if (xpathSmart) {
        candidates.push({ 
          type: 'XPath', 
          value: xpathSmart, 
          score: 45, 
          note: 'XPath (no positions)' 
        });
      }
    },

    // ── Check if ID is dynamic ────────────────────────────────────────────────
    _isDynamicId(id) {
      return DYNAMIC_ID_PATTERNS.some(pattern => pattern.test(id));
    },

    // ── Check if value appears dynamic ────────────────────────────────────────
    _isDynamicValue(value) {
      return DYNAMIC_ID_PATTERNS.some(pattern => pattern.test(value));
    },

    // ── Get semantic (non-framework) classes ──────────────────────────────────
    _getSemanticClasses(el) {
      return Array.from(el.classList).filter(className => {
        return !UNSTABLE_CLASS_PATTERNS.some(pattern => pattern.test(className));
      });
    },

    // ── Check if locator is unique ────────────────────────────────────────────
    _isUnique(locator, type) {
      try {
        if (type.includes('xpath') || locator.startsWith('//')) {
          const result = document.evaluate(
            locator, 
            document, 
            null, 
            XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, 
            null
          );
          return result.snapshotLength === 1;
        } else {
          const matches = document.querySelectorAll(locator);
          return matches.length === 1;
        }
      } catch (e) {
        return false;
      }
    },

    // ── Build CSS path without position selectors ─────────────────────────────
    _buildSmartCssPath(el) {
      const tag = el.tagName.toLowerCase();
      const semanticClasses = this._getSemanticClasses(el);
      
      if (semanticClasses.length > 0) {
        return `${tag}${semanticClasses.map(c => `.${CSS.escape(c)}`).join('')}`;
      }

      // Try with parent context
      const parent = el.parentElement;
      if (parent && parent !== document.body) {
        const parentClasses = this._getSemanticClasses(parent);
        const parentTag = parent.tagName.toLowerCase();
        if (parentClasses.length > 0) {
          const childClasses = semanticClasses.length > 0 
            ? semanticClasses.map(c => `.${CSS.escape(c)}`).join('') 
            : '';
          return `${parentTag}${parentClasses.map(c => `.${CSS.escape(c)}`).join('')} > ${tag}${childClasses}`;
        }
      }

      return `${tag}`;
    },

    // ── Build XPath without position predicates ───────────────────────────────
    _buildSmartXPath(el) {
      const tag = el.tagName.toLowerCase();
      const semanticClasses = this._getSemanticClasses(el);
      
      if (semanticClasses.length > 0) {
        const classConditions = semanticClasses
          .map(c => `contains(@class, "${this._escapeXPath(c)}")`)
          .join(' and ');
        return `//${tag}[${classConditions}]`;
      }

      return `//${tag}`;
    },

    // ── Escape attribute values for CSS ───────────────────────────────────────
    _escapeAttr(value) {
      return value.replace(/"/g, '\\"');
    },

    // ── Escape values for XPath ───────────────────────────────────────────────
    _escapeXPath(value) {
      if (!value.includes("'")) return value;
      if (!value.includes('"')) return value;
      // Handle strings with both quotes
      return value.replace(/'/g, "\\'");
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

})();
