// ─── locator-generator.js ────────────────────────────────────────────────────
// Generates the SHORTEST, MOST STABLE, and UNIQUE locators for DOM elements.
// Thinks like Playwright/Cypress: validates uniqueness, prefers stable attributes.

(function () {
  'use strict';

  // ── Stability Detection Patterns ──────────────────────────────────────────
  const UNSTABLE_ID_PATTERNS = [
    /^[a-fA-F0-9]{24}$/,                    // Mongo ObjectId
    /^[0-9a-fA-F-]{32,}$/,                  // UUID
    /^[a-fA-F0-9]{16,}$/,                   // Long hex
    /^\d+$/,                                 // Only digits
    /^select2-/,                             // Select2 generated
    /^react-/,                               // React generated
    /^ember/,                                // Ember generated
    /^ext-gen/,                              // ExtJS generated
    /^cdk-/,                                 // Angular CDK
    /^mat-/,                                 // Material UI
    /^mui-/,                                 // MUI
    /^radix-/,                               // Radix UI
    /^headlessui-/,                          // Headless UI
    /^:r[a-z0-9]+:$/,                        // React 18 IDs
  ];

  const UNSTABLE_CLASS_PATTERNS = [
    /^(active|selected|hover|focus|show|hide|disabled|open|visible|checked|collapsed|expanded)$/i,
    /^ng-/,
    /^css-/,
    /^jsx-/,
    /^jss-?/,
    /^emotion-/,
    /^Mui/,
    /^chakra-/,
    /^ant-/,
    /^_[a-zA-Z0-9]{5,}$/,                   // Hash-like
    /^[a-z0-9]{32,}$/,                      // Long random string
  ];

  // ── Helper Functions ──────────────────────────────────────────────────────

  function isStableId(id) {
    if (!id) return false;
    return !UNSTABLE_ID_PATTERNS.some(pattern => pattern.test(id));
  }

  function isStableClass(className) {
    if (!className) return false;
    return !UNSTABLE_CLASS_PATTERNS.some(pattern => pattern.test(className));
  }

  function getStableClasses(el) {
    return Array.from(el.classList).filter(isStableClass);
  }

  function isUniqueCss(selector) {
    try {
      const matches = document.querySelectorAll(selector);
      return matches.length === 1;
    } catch (e) {
      return false;
    }
  }

  function isUniqueXPath(xpath) {
    try {
      const result = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      return result.snapshotLength === 1;
    } catch (e) {
      return false;
    }
  }

  function escapeAttr(value) {
    return value.replace(/"/g, '\\"');
  }

  function removeDuplicateCandidates(candidates) {
    const seen = new Set();
    return candidates.filter(c => {
      if (seen.has(c.value)) return false;
      seen.add(c.value);
      return true;
    });
  }

  window.LocatorGenerator = {

    // Returns { bestLocator, confidence, locators: [{type,value,score,note}] }
    generate(el) {
      const candidates = [];

      // 1. Test attributes (highest priority)
      this._generateTestAttributeLocators(el, candidates);

      // 2. Stable ID
      if (el.id && isStableId(el.id)) {
        const sel = `#${CSS.escape(el.id)}`;
        if (isUniqueCss(sel)) {
          candidates.push({ type: 'ID', value: sel, score: 100, note: 'Stable unique ID' });
        }
      }

      // 3. Name attribute
      if (el.name) {
        this._generateNameLocators(el, candidates);
      }

      // 4. ARIA attributes
      this._generateAriaLocators(el, candidates);

      // 5. Placeholder
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) {
        const tag = el.tagName.toLowerCase();
        const sel = `${tag}[placeholder="${escapeAttr(placeholder)}"]`;
        if (isUniqueCss(sel)) {
          candidates.push({ type: 'placeholder', value: sel, score: 86, note: 'Unique placeholder' });
        }
      }

      // 6. Text-based locators
      this._generateTextLocators(el, candidates);

      // 7. Shortest CSS selector
      const shortestCss = this._buildShortestCss(el);
      if (shortestCss) {
        const optimized = this._optimizeCss(shortestCss);
        if (isUniqueCss(optimized)) {
          candidates.push({ 
            type: 'CSS', 
            value: optimized, 
            score: 80, 
            note: 'Shortest unique CSS' 
          });
        }
      }

      // 8. Smart XPath
      const smartXPath = this._buildSmartXPath(el);
      if (smartXPath && isUniqueXPath(smartXPath)) {
        candidates.push({ 
          type: 'XPath', 
          value: smartXPath, 
          score: 75, 
          note: 'Smart XPath' 
        });
      }

      // 9. Select2 specific rules (preserve existing logic)
      this._generateSelect2Locators(el, candidates);

      // 10. Fallback: non-unique locators with low scores
      if (candidates.length === 0) {
        this._generateFallbackLocators(el, candidates, shortestCss, smartXPath);
      }

      // Remove duplicates and sort by score
      const unique = removeDuplicateCandidates(candidates);
      unique.sort((a, b) => b.score - a.score);

      return {
        bestLocator: unique[0]?.value ?? '',
        confidence: unique[0]?.score ?? 0,
        locators: unique
      };
    },

    _generateTestAttributeLocators(el, candidates) {
      const testAttrs = [
        { name: 'data-testid', score: 98 },
        { name: 'data-test', score: 97 },
        { name: 'data-cy', score: 97 },
        { name: 'data-qa', score: 97 },
      ];

      for (const { name, score } of testAttrs) {
        const val = el.getAttribute(name);
        if (val) {
          const sel = `[${name}="${escapeAttr(val)}"]`;
          if (isUniqueCss(sel)) {
            candidates.push({ 
              type: name, 
              value: sel, 
              score, 
              note: `Unique ${name} attribute` 
            });
          }
        }
      }
    },

    _generateNameLocators(el, candidates) {
      const tag = el.tagName.toLowerCase();
      const name = el.getAttribute('name');
      
      // Try name alone
      let sel = `${tag}[name="${escapeAttr(name)}"]`;
      if (isUniqueCss(sel)) {
        candidates.push({ 
          type: 'name', 
          value: sel, 
          score: 90, 
          note: 'Unique name attribute' 
        });
      } else {
        // Try name + type
        const type = el.getAttribute('type');
        if (type) {
          sel = `${tag}[name="${escapeAttr(name)}"][type="${escapeAttr(type)}"]`;
          if (isUniqueCss(sel)) {
            candidates.push({ 
              type: 'name+type', 
              value: sel, 
              score: 90, 
              note: 'Unique name+type combination' 
            });
          }
        }
      }

      // XPath alternative
      const xpath = `//${tag}[@name="${escapeAttr(name)}"]`;
      if (isUniqueXPath(xpath)) {
        candidates.push({ 
          type: 'name-xpath', 
          value: xpath, 
          score: 88, 
          note: 'Unique name (XPath)' 
        });
      }
    },

    _generateAriaLocators(el, candidates) {
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) {
        const sel = `[aria-label="${escapeAttr(ariaLabel)}"]`;
        if (isUniqueCss(sel)) {
          candidates.push({ 
            type: 'aria-label', 
            value: sel, 
            score: 88, 
            note: 'Unique ARIA label' 
          });
        }
      }

      const role = el.getAttribute('role');
      if (role) {
        const sel = `[role="${escapeAttr(role)}"]`;
        if (isUniqueCss(sel)) {
          candidates.push({ 
            type: 'role', 
            value: sel, 
            score: 85, 
            note: 'Unique ARIA role' 
          });
        }
      }

      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        const labEl = document.getElementById(labelledBy);
        if (labEl) {
          const text = labEl.textContent.trim();
          const sel = `[aria-labelledby="${escapeAttr(labelledBy)}"]`;
          if (isUniqueCss(sel)) {
            candidates.push({ 
              type: 'aria-labelledby', 
              value: sel, 
              score: 85, 
              note: `Labels: "${text.slice(0, 30)}${text.length > 30 ? '...' : ''}"` 
            });
          }
        }
      }
    },

    _generateTextLocators(el, candidates) {
      const text = (el.textContent || '').trim();
      const tag = el.tagName.toLowerCase();
      
      if (!text || text.length > 80) return;
      if (!['button', 'a', 'label', 'span', 'li'].includes(tag)) return;

      // Exact text match
      const xpath = `//${tag}[normalize-space()="${escapeAttr(text)}"]`;
      if (isUniqueXPath(xpath)) {
        candidates.push({ 
          type: 'text-exact', 
          value: xpath, 
          score: 85, 
          note: `By exact text: "${text.slice(0, 40)}${text.length > 40 ? '...' : ''}"` 
        });
      }

      // Text with class
      const stableClasses = getStableClasses(el);
      if (stableClasses.length > 0) {
        const classCondition = stableClasses
          .map(c => `contains(@class,'${escapeAttr(c)}')`)
          .join(' and ');
        const xpath2 = `//${tag}[${classCondition} and normalize-space()="${escapeAttr(text)}"]`;
        if (isUniqueXPath(xpath2)) {
          candidates.push({ 
            type: 'text+class', 
            value: xpath2, 
            score: 87, 
            note: `Text with class: "${text.slice(0, 30)}${text.length > 30 ? '...' : ''}"` 
          });
        }
      }
    },

    _generateSelect2Locators(el, candidates) {
      const isSelect2 = (typeof el.className === 'string' && el.className.includes('select2')) || 
                        (el.id && el.id.includes('select2-')) || 
                        (el.closest && el.closest('.select2-container') !== null);

      if (!isSelect2) return;

      const tag = el.tagName.toLowerCase();
      
      // Find container with select2 ID
      const container = (el.id && el.id.endsWith('-container') && el.id.startsWith('select2-')) 
          ? el 
          : (el.closest ? el.closest('[id^="select2-"][id$="-container"]') : null);
          
      if (container && container.id) {
         if (el === container) {
           const xpath = `//${container.tagName.toLowerCase()}[@id="${container.id}"]`;
           if (isUniqueXPath(xpath)) {
             candidates.push({ 
               type: 'Select2 ID', 
               value: xpath, 
               score: 100, 
               note: 'Select2 container ID' 
             });
           }
         } else {
           const relativeXPath = this._buildRelativeXPath(container, el);
           if (isUniqueXPath(relativeXPath)) {
             candidates.push({ 
               type: 'Select2 Child', 
               value: relativeXPath, 
               score: 100, 
               note: 'Select2 exact child element' 
             });
           }
         }
         
         // Try to find original select element
         const match = container.id.match(/^select2-(.+)-container$/);
         if (match && match[1] && document.getElementById(match[1])) {
            const anchorXPath = `//select[@id="${match[1]}"]/following-sibling::span//span[contains(@class,"select2-selection__rendered")]`;
            if (isUniqueXPath(anchorXPath)) {
              if (el === container) {
                candidates.push({ 
                  type: 'Select2 Anchor', 
                  value: anchorXPath, 
                  score: 90, 
                  note: 'Anchored to original select' 
                });
              }
            }
         }
      }
      
      // Class-based selectors
      if (typeof el.className === 'string') {
        const select2Text = (el.textContent || '').trim();
        
        if (el.className.includes('select2-selection__placeholder') && select2Text) {
           const xpath = `//${tag}[contains(@class,"select2-selection__placeholder") and normalize-space()="${escapeAttr(select2Text)}"]`;
           if (isUniqueXPath(xpath)) {
             candidates.push({ 
               type: 'Select2 Class', 
               value: xpath, 
               score: 95, 
               note: 'Select2 placeholder' 
             });
           }
        } else if (el.className.includes('select2-selection__rendered')) {
           const xpath = `//${tag}[contains(@class,"select2-selection__rendered")]`;
           if (isUniqueXPath(xpath)) {
             candidates.push({ 
               type: 'Select2 Class', 
               value: xpath, 
               score: 95, 
               note: 'Select2 rendered element' 
             });
           }
        } else if (el.className.includes('select2-results__option') && select2Text) {
           const xpath = `//${tag}[contains(@class,"select2-results__option") and normalize-space()="${escapeAttr(select2Text)}"]`;
           if (isUniqueXPath(xpath)) {
             candidates.push({ 
               type: 'Select2 Option', 
               value: xpath, 
               score: 95, 
               note: 'Select2 dropdown option' 
             });
           }
        }
      }
      
      // ARIA role fallback
      if (el.getAttribute('role') === 'combobox') {
         const xpath = `//${tag}[@role="combobox"]`;
         if (isUniqueXPath(xpath)) {
           candidates.push({ 
             type: 'Select2 ARIA', 
             value: xpath, 
             score: 75, 
             note: 'Select2 combobox role' 
           });
         }
      }
    },

    _buildShortestCss(el) {
      const tag = el.tagName.toLowerCase();
      const stableClasses = getStableClasses(el);

      // Try progressively more specific selectors
      const attempts = [];

      // 1. Stable ID (even if not globally unique, might be unique with parent)
      if (el.id && isStableId(el.id)) {
        attempts.push(`#${CSS.escape(el.id)}`);
        attempts.push(`${tag}#${CSS.escape(el.id)}`);
      }

      // 2. Just tag
      attempts.push(tag);

      // 3. Tag + first stable class
      if (stableClasses.length > 0) {
        attempts.push(`${tag}.${CSS.escape(stableClasses[0])}`);
      }

      // 4. Tag + all stable classes
      if (stableClasses.length > 1) {
        const classStr = stableClasses.map(c => `.${CSS.escape(c)}`).join('');
        attempts.push(`${tag}${classStr}`);
      }

      // 4. Add stable/semantic attributes
      const stableAttrNames = ['role', 'name', 'type', 'alt', 'title', 'href', 'for'];
      const stableAttrs = [];
      for (const attr of el.attributes) {
        if (stableAttrNames.includes(attr.name.toLowerCase())) {
          stableAttrs.push({ name: attr.name, value: attr.value });
        }
      }

      // Try combinations of tag + class + stable attribute
      for (const attr of stableAttrs) {
        const attrStr = `[${attr.name}="${escapeAttr(attr.value)}"]`;
        attempts.push(`${tag}${attrStr}`); // Just tag + attr
        
        if (stableClasses.length > 0) {
          const classStr = stableClasses.map(c => `.${CSS.escape(c)}`).join('');
          attempts.push(`${tag}${classStr}${attrStr}`); // Tag + classes + attr
        }
      }

      // Test each attempt
      for (const sel of attempts) {
        if (isUniqueCss(sel)) {
          return sel;
        }
      }

      // 5. Add parent context
      let parent = el.parentElement;
      let depth = 0;
      const maxDepth = 5; // Increased depth to reach modal wrappers

      while (parent && parent !== document.body && depth < maxDepth) {
        const parentTag = parent.tagName.toLowerCase();
        const parentClasses = getStableClasses(parent);
        
        let parentSel = parentTag;
        // Prioritize parent's stable ID to guarantee uniqueness
        if (parent.id && isStableId(parent.id)) {
          parentSel = `#${CSS.escape(parent.id)}`;
        } else if (parentClasses.length > 0) {
          parentSel += `.${CSS.escape(parentClasses[0])}`;
        }

        // Try parent + child combinations
        for (const childSel of attempts) {
          const combined = `${parentSel} ${childSel}`;
          if (isUniqueCss(combined)) {
            return combined;
          }
        }

        // NEW: If combinations failed, but parent is stable, generate exact relative path
        if ((parent.id && isStableId(parent.id)) || parentClasses.length > 0) {
          const relativeCss = this._buildRelativeCss(parent, el);
          if (isUniqueCss(relativeCss)) {
            return relativeCss;
          }
        }

        parent = parent.parentElement;
        depth++;
      }

      // Fallback: return best attempt even if not unique
      return attempts[attempts.length - 1] || tag;
    },

    _optimizeCss(selector) {
      if (!selector) return selector;

      let current = selector;
      const parts = selector.split(/\s+/);
      
      if (parts.length <= 1) return current;

      // Try removing unnecessary parts
      const removable = ['div', 'span', 'tbody', 'tr'];

      // Do not remove the last part because it defines the target element itself
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (part === '>') continue; // Skip combinators

        const tag = part.split(/[.#\[]/)[0];
        
        if (removable.includes(tag)) {
          // Try removing this part
          const newParts = [...parts];
          newParts.splice(i, 1);
          
          // Clean up dangling combinators (e.g. '>', '+') that might be left over
          if (newParts[0] === '>') newParts.shift();
          let newSelector = newParts.join(' ');
          newSelector = newSelector.replace(/\s*>\s*>\s*/g, ' > ');
          
          if (isUniqueCss(newSelector)) {
            current = newSelector;
            // Recursively optimize further
            return this._optimizeCss(current);
          }
        }
      }

      // Try removing nth-child/nth-of-type
      if (current.includes(':nth-')) {
        const withoutNth = current.replace(/:nth-(child|of-type)\(\d+\)/g, '');
        if (isUniqueCss(withoutNth)) {
          return withoutNth;
        }
      }

      return current;
    },

    _buildSmartXPath(el) {
      const tag = el.tagName.toLowerCase();
      const stableClasses = getStableClasses(el);

      // Try ID first
      if (el.id && isStableId(el.id)) {
        const idXPath = `//${tag}[@id="${escapeAttr(el.id)}"]`;
        if (isUniqueXPath(idXPath)) return idXPath;
        
        // Even if not unique globally, try it with classes just in case
        if (stableClasses.length > 0) {
          const classConditions = stableClasses.map(c => `contains(@class,'${escapeAttr(c)}')`).join(' and ');
          const combinedXpath = `//${tag}[@id="${escapeAttr(el.id)}" and ${classConditions}]`;
          if (isUniqueXPath(combinedXpath)) return combinedXpath;
        }
      }

      // Try attribute-based XPath first (stable semantic attributes)
      const attrs = ['name', 'type', 'role', 'alt', 'title', 'href'];
      const stableAttrs = [];
      for (const attr of attrs) {
        const val = el.getAttribute(attr);
        if (val) stableAttrs.push({ name: attr, value: val });
      }

      for (const attr of stableAttrs) {
        const xpath = `//${tag}[@${attr.name}="${escapeAttr(attr.value)}"]`;
        if (isUniqueXPath(xpath)) return xpath;
        
        // If not unique alone, try combining with classes
        if (stableClasses.length > 0) {
          const classConditions = stableClasses.map(c => `contains(@class,'${escapeAttr(c)}')`).join(' and ');
          const combinedXpath = `//${tag}[${classConditions} and @${attr.name}="${escapeAttr(attr.value)}"]`;
          if (isUniqueXPath(combinedXpath)) return combinedXpath;
        }
      }

      // Try class-based XPath
      if (stableClasses.length > 0) {
        const classConditions = stableClasses
          .map(c => `contains(@class,'${escapeAttr(c)}')`)
          .join(' and ');
        const xpath = `//${tag}[${classConditions}]`;
        if (isUniqueXPath(xpath)) {
          return xpath;
        }
      }

      // Try parent combinations if nothing was unique
      const attempts = [];
      if (el.id && isStableId(el.id)) attempts.push(`//${tag}[@id="${escapeAttr(el.id)}"]`);
      for (const attr of stableAttrs) {
        attempts.push(`//${tag}[@${attr.name}="${escapeAttr(attr.value)}"]`);
      }
      if (stableClasses.length > 0) {
        const classConditions = stableClasses.map(c => `contains(@class,'${escapeAttr(c)}')`).join(' and ');
        attempts.push(`//${tag}[${classConditions}]`);
      }
      attempts.push(`//${tag}`);

      let parent = el.parentElement;
      let depth = 0;
      const maxDepth = 5;

      while (parent && parent !== document.body && depth < maxDepth) {
        let parentXpath = `//${parent.tagName.toLowerCase()}`;
        let isStableParent = false;

        if (parent.id && isStableId(parent.id)) {
          parentXpath += `[@id="${escapeAttr(parent.id)}"]`;
          isStableParent = true;
        } else {
          const pClasses = getStableClasses(parent);
          if (pClasses.length > 0) {
            parentXpath += `[contains(@class,'${escapeAttr(pClasses[0])}')]`;
            isStableParent = true;
          }
        }

        for (const childXPath of attempts) {
          // Combine //parent... with //child... -> //parent...//child...
          const combined = parentXpath + childXPath;
          if (isUniqueXPath(combined)) return combined;
        }

        // NEW: If simple descendant combination wasn't unique, try exact relative path
        if (isStableParent) {
          const relativeXPath = this._buildRelativeXPath(parent, el);
          if (isUniqueXPath(relativeXPath)) {
            return relativeXPath;
          }
        }

        parent = parent.parentElement;
        depth++;
      }

      // Absolute Fallback: best attempt even if not unique
      return attempts[0] || `//${tag}`;
    },

    _generateFallbackLocators(el, candidates, shortestCss, smartXPath) {
      const tag = el.tagName.toLowerCase();
      
      // 1. Non-unique ID (still much better than classes)
      if (el.id && isStableId(el.id)) {
        candidates.push({ 
          type: 'ID', 
          value: `#${CSS.escape(el.id)}`, 
          score: 45, 
          note: 'Non-unique ID (needs improvement but preferred)' 
        });
      }

      // 2. Best attempted XPath with parent context
      if (smartXPath) {
        candidates.push({ 
          type: 'XPath', 
          value: smartXPath, 
          score: 43, 
          note: 'Non-unique XPath (has parent context)' 
        });
      }

      // 3. Best attempted CSS with parent context
      if (shortestCss) {
        candidates.push({ 
          type: 'CSS', 
          value: shortestCss, 
          score: 42, 
          note: 'Non-unique CSS (has parent context)' 
        });
      }

      // 4. Basic Non-unique CSS classes
      const stableClasses = getStableClasses(el);
      if (stableClasses.length > 0) {
        const classStr = stableClasses.map(c => `.${CSS.escape(c)}`).join('');
        candidates.push({ 
          type: 'CSS', 
          value: `${tag}${classStr}`, 
          score: 40, 
          note: 'Non-unique CSS classes' 
        });
      }

      // 5. Full DOM path as last resort
      const fullPath = this._buildFullDomPath(el);
      if (isUniqueCss(fullPath)) {
        candidates.push({ 
          type: 'DOM Path', 
          value: fullPath, 
          score: 50, // Beats non-unique fallbacks (45, 43, 42) because uniqueness is critical
          note: 'Unique full DOM path (brittle — add test attributes)' 
        });
      } else {
        candidates.push({ 
          type: 'DOM Path', 
          value: fullPath, 
          score: 20, 
          note: 'Non-unique DOM path' 
        });
      }
    },

    _buildRelativeCss(ancestor, child) {
      const parts = [];
      let node = child;

      while (node && node !== ancestor && node !== document.body) {
        const tag = node.tagName.toLowerCase();
        let selector = tag;
        
        const stableClasses = getStableClasses(node);
        const siblings = Array.from(node.parentElement.children);
        const sameTagSiblings = siblings.filter(s => s.tagName === node.tagName);
        
        if (sameTagSiblings.length > 1) {
           let classUnique = false;
           if (stableClasses.length > 0) {
              const testClass = stableClasses[0];
              const matchingSiblings = siblings.filter(s => 
                  s.tagName === node.tagName && s.classList.contains(testClass)
              );
              if (matchingSiblings.length === 1) {
                  selector = `${tag}.${CSS.escape(testClass)}`;
                  classUnique = true;
              }
           }
           
           if (!classUnique) {
              const idx = sameTagSiblings.indexOf(node) + 1;
              selector = `${tag}:nth-of-type(${idx})`;
           }
        } else if (stableClasses.length > 0) {
           selector = `${tag}.${CSS.escape(stableClasses[0])}`;
        }

        parts.unshift(selector);
        node = node.parentElement;
      }

      let ancestorSel = ancestor.tagName.toLowerCase();
      if (ancestor.id && isStableId(ancestor.id)) {
        ancestorSel = `#${CSS.escape(ancestor.id)}`;
      } else {
        const aClasses = getStableClasses(ancestor);
        if (aClasses.length > 0) {
          ancestorSel += `.${CSS.escape(aClasses[0])}`;
        }
      }

      return `${ancestorSel} > ${parts.join(' > ')}`;
    },

    _buildRelativeXPath(ancestor, child) {
      const parts = [];
      let node = child;

      while (node && node !== ancestor && node !== document.body) {
        const tag = node.tagName.toLowerCase();
        let selector = tag;

        const stableClasses = getStableClasses(node);
        const siblings = Array.from(node.parentElement.children);
        const sameTagSiblings = siblings.filter(s => s.tagName === node.tagName);

        if (sameTagSiblings.length > 1) {
           let classUnique = false;
           if (stableClasses.length > 0) {
              const testClass = stableClasses[0];
              const matchingSiblings = siblings.filter(s => 
                  s.tagName === node.tagName && s.classList.contains(testClass)
              );
              if (matchingSiblings.length === 1) {
                  selector = `${tag}[contains(@class,'${escapeAttr(testClass)}')]`;
                  classUnique = true;
              }
           }
           
           if (!classUnique) {
              const idx = sameTagSiblings.indexOf(node) + 1;
              selector = `${tag}[${idx}]`;
           }
        } else if (stableClasses.length > 0) {
           selector = `${tag}[contains(@class,'${escapeAttr(stableClasses[0])}')]`;
        }

        parts.unshift(selector);
        node = node.parentElement;
      }

      let ancestorSel = `//${ancestor.tagName.toLowerCase()}`;
      if (ancestor.id && isStableId(ancestor.id)) {
        ancestorSel += `[@id="${escapeAttr(ancestor.id)}"]`;
      } else {
        const aClasses = getStableClasses(ancestor);
        if (aClasses.length > 0) {
          ancestorSel += `[contains(@class,'${escapeAttr(aClasses[0])}')]`;
        }
      }

      return `${ancestorSel}/${parts.join('/')}`;
    },

    _buildFullDomPath(el) {
      const parts = [];
      let node = el;

      while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
        let selector = node.tagName.toLowerCase();

        if (node.id && isStableId(node.id)) {
          selector = `#${CSS.escape(node.id)}`;
          parts.unshift(selector);
          break;
        }

        const stableClasses = getStableClasses(node);
        if (stableClasses.length > 0) {
          selector += `.${CSS.escape(stableClasses[0])}`;
        }

        if (node.parentElement) {
          const siblings = Array.from(node.parentElement.children)
            .filter(s => s.tagName === node.tagName);
          if (siblings.length > 1) {
            const idx = siblings.indexOf(node) + 1;
            selector += `:nth-of-type(${idx})`;
          }
        }

        parts.unshift(selector);
        node = node.parentElement;
      }

      return parts.join(' > ');
    },


    // Extract visible text shown to the user — used for verification value only
    extractValue(el) {
      let val = el.innerText || el.textContent || '';
      
      // Fix for Select2: Selenium's getText() inserts a space after the clear button (×)
      // because of its CSS layout, whereas Chrome's innerText sometimes concatenates them (×pinku).
      const clearBtn = el.querySelector?.('.select2-selection__clear');
      if (clearBtn) {
        const clearText = (clearBtn.innerText || clearBtn.textContent || '').trim() || '×';
        if (val.startsWith(clearText) && !val.startsWith(clearText + ' ')) {
          val = clearText + ' ' + val.slice(clearText.length);
        }
      }
      
      return val.trim();
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
