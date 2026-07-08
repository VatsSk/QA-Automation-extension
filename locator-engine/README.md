# Locator Engine

## Overview

The Locator Engine generates **stable, automation-friendly selectors** for web elements. It prioritizes test attributes, semantic classes, and ARIA labels while avoiding dynamic IDs, framework-generated classes, and position-based selectors.

---

## Quick Start

```javascript
// In your browser extension or web page
const element = document.querySelector('.my-button');
const result = window.LocatorGenerator.generate(element);

console.log(result.bestLocator);  // "[data-testid='submit-btn']"
console.log(result.confidence);   // 100
console.log(result.locators);     // Array of all ranked locators
```

---

## Key Features

### ✅ Stable Selector Generation
- **Prioritizes test attributes**: `data-testid`, `data-test`, `data-cy`, `data-qa`
- **Uses semantic attributes**: `name`, `aria-label`, `role`
- **Filters framework classes**: Ignores `Mui*`, `css-*`, `ng-*`, `ant-*`, etc.
- **Detects dynamic IDs**: Automatically ignores Mongo ObjectIds, UUIDs, numeric IDs

### ✅ Position-Independent
- **No nth-child/nth-of-type**: Avoids brittle position-based selectors
- **No long DOM chains**: Generates concise, readable selectors
- **Context-aware**: Combines semantic classes with stable attributes

### ✅ Uniqueness Verification
- **Real-time validation**: Checks if each selector matches exactly one element
- **Score adjustment**: Downgrades non-unique selectors automatically
- **Multiple alternatives**: Provides ranked fallback options

---

## Files

| File | Description |
|------|-------------|
| **`locator-generator.js`** | Core selector generation logic |
| **`LOCATOR_STRATEGY.md`** | Detailed strategy documentation |
| **`COMPARISON.md`** | Before/after examples with migration guide |
| **`test-locators.html`** | Interactive test page with automated tests |
| **`README.md`** | This file |

---

## Selector Priority

The engine ranks selectors based on stability:

### 🥇 Tier 1: Test Attributes (Score: 95-100)
```html
<button data-testid="submit-btn">Submit</button>
```
**Generated:** `[data-testid="submit-btn"]` (Score: 100)

### 🥈 Tier 2: Stable IDs & Form Attributes (Score: 85-95)
```html
<input name="email" aria-label="Email address" />
```
**Generated:** `input[name="email"]` (Score: 90)

### 🥉 Tier 3: Semantic Classes & ARIA (Score: 70-85)
```html
<button class="login-btn MuiButton-root css-xyz">Login</button>
```
**Generated:** `button.login-btn` (Score: 75)  
*(Framework classes `MuiButton-root`, `css-xyz` are filtered out)*

### 📊 Tier 4: Custom Data Attributes (Score: 65-70)
```html
<a data-target="#modal" href="/edit">Edit</a>
```
**Generated:** `[data-target="#modal"]` (Score: 70)

### 📝 Tier 5: Text-Based (Score: 55-65)
```html
<button>Submit Form</button>
```
**Generated:** `//button[normalize-space(.)="Submit Form"]` (Score: 60)

### ⚠️ Tier 6: Fallback (Score: <55)
```html
<div class="css-abc123"><span>Text</span></div>
```
**Generated:** `div > span` (Score: 50)  
**Recommendation:** Add `data-testid` attribute

---

## Dynamic ID Detection

The following ID patterns are automatically ignored:

```javascript
// ❌ Ignored (Dynamic)
id="6a4e00cadc41e67881c1ed1a"     // Mongo ObjectId
id="2f84b7a9-1eca-b432-..."       // UUID
id="8b72c8a4d93f4a72"             // Long hex
id="1698273412345"                // Numeric
id="select2-country-container"     // Framework prefix

// ✅ Used (Stable)
id="submit-form"
id="user-dashboard"
id="help-link"
```

---

## Framework Class Filtering

Framework-generated classes are automatically removed:

```javascript
// ❌ Filtered Out
.active, .selected, .focus, .hover
.ng-valid, .ng-pristine
.css-1x2y3z, .jss123
.MuiButton-root, .MuiPaper-elevation2
.chakra-button, .ant-btn
.mat-raised-button, .v-btn
._a1b2c3d4  // Hash-like

// ✅ Kept (Semantic)
.login-btn
.submit-button
.task-description
.user-profile
```

---

## Usage Examples

### Example 1: Generate Locator for Element
```javascript
const button = document.querySelector('.submit-btn');
const result = window.LocatorGenerator.generate(button);

console.log(result);
// {
//   bestLocator: "[data-testid='submit-form']",
//   confidence: 100,
//   locators: [
//     { type: 'data-testid', value: "[data-testid='submit-form']", score: 100, note: '...' },
//     { type: 'semantic-class', value: "button.submit-btn", score: 75, note: '...' },
//     // ... more alternatives
//   ]
// }
```

### Example 2: Extract Element Value
```javascript
const input = document.querySelector('input[name="email"]');
const value = window.LocatorGenerator.extractValue(input);
console.log(value);  // User's email address
```

### Example 3: Get Full Element Info
```javascript
const element = document.querySelector('.my-element');
const info = window.LocatorGenerator.getElementInfo(element);

console.log(info);
// {
//   tag: 'button',
//   id: 'submit-btn',
//   classes: ['submit-btn', 'primary'],
//   type: null,
//   name: null,
//   value: 'Submit',
//   ariaAttrs: { 'aria-label': 'Submit form' },
//   bestLocator: "[data-testid='submit']",
//   confidence: 100,
//   locators: [...],
//   rect: { width: 120, height: 40 }
// }
```

---

## Testing

### Interactive Testing

1. Open `test-locators.html` in a browser
2. Click any element on the page
3. View generated locators and scores in the results panel

### Automated Testing

Open browser console after loading `test-locators.html`:

```
=== Running Locator Generator Tests ===

✅ Test 1 Passed: data-testid is top priority
✅ Test 2 Passed: Dynamic ID ignored
✅ Test 3 Passed: Framework classes filtered
✅ Test 4 Passed: name attribute prioritized
✅ Test 5 Passed: Contextual locator with data-target
✅ Test 6 Passed: Stable ID used

=== All Tests Passed! ===
```

---

## Integration

### In Browser Extensions

The locator generator is automatically loaded in content scripts:

```javascript
// content.js or overlay.js
const element = event.target;
const locator = window.LocatorGenerator.generate(element);
sendToPopup({ locator: locator.bestLocator });
```

### In Web Applications

Include the script in your HTML:

```html
<script src="locator-engine/locator-generator.js"></script>
<script>
  document.addEventListener('click', (e) => {
    const locator = window.LocatorGenerator.generate(e.target);
    console.log('Clicked:', locator.bestLocator);
  });
</script>
```

---

## Best Practices for Developers

### ✅ DO: Add Test Attributes
```html
<!-- Excellent -->
<button data-testid="submit-form" class="btn-primary">Submit</button>

<!-- Good -->
<input name="email" aria-label="Email address" />

<!-- Acceptable -->
<a href="/dashboard" class="nav-link">Dashboard</a>
```

### ❌ DON'T: Use Dynamic IDs
```html
<!-- Bad: Dynamic ID -->
<button id="1698273412345">Submit</button>

<!-- Bad: Framework classes only -->
<button class="MuiButton-root css-1x2y3z">Submit</button>

<!-- Bad: No semantic attributes -->
<div class="css-abc"><div class="css-xyz">Content</div></div>
```

---

## Best Practices for QA Engineers

### 1. Review Locator Scores
- **Score ≥ 80**: Excellent, use as-is
- **Score 60-79**: Good, acceptable
- **Score 40-59**: Fair, consider requesting improvements
- **Score < 40**: Poor, needs test attributes

### 2. Request Test Attributes
Work with developers to add `data-testid` to critical elements:
```html
<button data-testid="checkout-confirm">Confirm Purchase</button>
```

### 3. Use Alternative Locators
If the best locator fails, try alternatives:
```javascript
const result = window.LocatorGenerator.generate(element);
for (const loc of result.locators) {
  try {
    // Try each locator until one works
    if (loc.type.includes('xpath')) {
      element = driver.findElement(By.xpath(loc.value));
    } else {
      element = driver.findElement(By.css(loc.value));
    }
    break;
  } catch (e) {
    continue;
  }
}
```

---

## API Reference

### `LocatorGenerator.generate(element)`

Generates ranked selectors for a DOM element.

**Parameters:**
- `element` (HTMLElement): The target DOM element

**Returns:** Object
```javascript
{
  bestLocator: string,      // Highest-scoring selector
  confidence: number,       // Score of best locator (0-100)
  locators: Array<{        // All ranked alternatives
    type: string,          // Locator type (e.g., 'data-testid', 'CSS')
    value: string,         // Selector string
    score: number,         // Stability score (0-100)
    note: string           // Human-readable description
  }>
}
```

### `LocatorGenerator.extractValue(element)`

Extracts visible text from an element.

**Parameters:**
- `element` (HTMLElement): The target DOM element

**Returns:** string - Trimmed visible text

### `LocatorGenerator.getElementInfo(element)`

Returns comprehensive information about an element.

**Parameters:**
- `element` (HTMLElement): The target DOM element

**Returns:** Object
```javascript
{
  tag: string,             // Tag name (lowercase)
  id: string|null,         // Element ID
  classes: Array<string>,  // All classes
  type: string|null,       // Type attribute
  name: string|null,       // Name attribute
  placeholder: string|null,// Placeholder attribute
  value: string,           // Extracted text
  textContent: string,     // Text content (truncated)
  ariaAttrs: Object,       // ARIA attributes
  bestLocator: string,     // Best selector
  confidence: number,      // Confidence score
  locators: Array,         // All locators
  rect: Object            // Dimensions
}
```

---

## Troubleshooting

### Issue: Low Confidence Scores

**Problem:** Generated locators have scores < 60

**Solution:**
1. Add `data-testid` attributes to elements
2. Use semantic class names (not framework-generated)
3. Add `aria-label` or `name` attributes
4. Ensure stable `id` attributes (not auto-generated)

### Issue: Non-Unique Locators

**Problem:** Locators match multiple elements

**Solution:**
1. Combine attributes: `button.submit-btn[data-target="#modal"]`
2. Add unique test attributes
3. Use parent context: `#form-container > button.submit-btn`

### Issue: Framework Classes Filtered

**Problem:** Important classes are being ignored

**Solution:**
- Use semantic class names that don't match framework patterns
- Add custom `data-*` attributes
- Ensure classes don't start with `Mui`, `css-`, `ng-`, etc.

---

## Migration Guide

### From Old Locator Generator

The new generator is **backward compatible** but produces better selectors:

**Old Output:**
```javascript
{
  bestLocator: "#\36 a4e00cadc41e67881c1ed1a > td:nth-child(2) > a",
  confidence: 100
}
```

**New Output:**
```javascript
{
  bestLocator: "a.task-description[data-target='#edit']",
  confidence: 85,
  locators: [/* multiple alternatives */]
}
```

**Action Items:**
1. Review tests using position-based selectors (`:nth-child`)
2. Update tests using dynamic IDs
3. Regenerate locators for critical flows
4. Add `data-testid` attributes where scores are low

---

## Contributing

### Adding New Patterns

To add new dynamic ID or class patterns:

```javascript
// In locator-generator.js

const DYNAMIC_ID_PATTERNS = [
  // Existing patterns...
  /^your-new-pattern$/,  // Your description
];

const UNSTABLE_CLASS_PATTERNS = [
  // Existing patterns...
  /^your-class-pattern/,  // Your description
];
```

### Testing Changes

1. Update `locator-generator.js`
2. Open `test-locators.html` in a browser
3. Check console for test results
4. Click elements to verify interactive behavior
5. Ensure all existing tests pass

---

## License

This locator engine is part of the QA-Automation-Extension project.

---

## Support

For questions or issues:
1. Review `LOCATOR_STRATEGY.md` for detailed documentation
2. Check `COMPARISON.md` for before/after examples
3. Test with `test-locators.html` for interactive debugging
4. Review console logs for detailed locator analysis
