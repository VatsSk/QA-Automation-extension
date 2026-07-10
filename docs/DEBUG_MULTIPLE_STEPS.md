# Debugging Multiple Steps Issue

## Problem

Multiple steps are being created for a single click, with different selectors:
- `a.task-description[data-target="#edit-task-modal"]`
- `#\36 a4e00cadc41e67881c1ed1a > td.sorting_2:nth-of-type(2) > div > a.task-description`
- `//a[contains(@class,'task-description') and normalize-space()="task1"]`
- etc.

## Diagnostic Steps

### Step 1: Check Console Logs

Open **3 different console windows**:

#### Console 1: Target Page (where you click)
1. Press F12 on the page where you're recording
2. Go to Console tab
3. Click an element
4. Look for messages in this order:

```
[Overlay] Dispatching step: {action: "click", selector: "...", element: "A", timestamp: 123456}
[Overlay] Dispatching step: {action: "click", selector: "...", element: "A", timestamp: 123456}  ← DUPLICATE?
```

**If you see 2+ "Dispatching step" messages:**
→ Problem is in `overlay.js` - element resolution or deduplication failing

**If you see only 1 "Dispatching step" message:**
→ Problem is downstream (content.js or service-worker)

---

#### Console 2: Background Service Worker
1. Go to `chrome://extensions`
2. Enable "Developer mode"
3. Click "service worker" link under your extension
4. Click an element on target page
5. Look for:

```
[SW] Forwarding STEP_RECORDED: a.task-description[data-target="..."]
[SW] Forwarding STEP_RECORDED: a.task-description[data-target="..."]  ← DUPLICATE?
```

**If you see multiple forwarding messages:**
→ Problem is in `content.js` - event listener firing multiple times

---

#### Console 3: Popup/Recorder Window
1. Open the recorder window
2. Press F12 to open DevTools for the recorder
3. Go to Console tab
4. Click an element on target page
5. Look for:

```
[Flow] Received message: STEP_RECORDED {selector: "a.task-description[...]"}
[Flow] Processing STEP_RECORDED
[QA] Duplicate step ignored: {type: "click", selector: "a.task-description[...]", value: ""}
```

**If you see multiple "Received message" without "Duplicate ignored":**
→ Problem is popup receiving multiple messages OR deduplication not working

---

### Step 2: Identify the Pattern

Check which selectors are being created:

#### Pattern A: Same selector multiple times
```
a.task-description[data-target="#edit"]
a.task-description[data-target="#edit"]
a.task-description[data-target="#edit"]
```
**Diagnosis:** Event duplication (mousedown + click, or multiple listeners)
**Fix:** Check event listener deduplication in `overlay.js`

---

#### Pattern B: Different selectors for same element
```
a.task-description[data-target="#edit"]
#someId > td > a.task-description
//a[contains(@class,'task-description')]
```
**Diagnosis:** Locator generator being called multiple times with different results, OR alternative locators being added as separate steps
**Fix:** Check if `loc.locators` array is being iterated instead of using `loc.bestLocator`

---

#### Pattern C: Mixed - some same, some different
```
a.task-description
a.task-description  (duplicate)
//a[normalize-space()="task1"]
//a[normalize-space()="task1"]  (duplicate)
```
**Diagnosis:** Multiple issues combined
**Fix:** Apply all fixes

---

### Step 3: Check Injection Count

In the target page console, check:

```javascript
// Check if content script loaded multiple times
console.log('Content loaded?', window.__qaContentLoaded);

// Check if overlay loaded multiple times  
console.log('Overlay loaded?', window.__qaOverlayLoaded);

// Check number of event listeners (rough estimate)
getEventListeners(document)['qa-step-recorded']?.length
```

**Expected:** 
- `__qaContentLoaded`: true
- `__qaOverlayLoaded`: true
- Event listeners: 1

**If listeners > 1:**
→ Scripts injected multiple times, listeners stacking up

---

### Step 4: Check Timestamp Gaps

Look at timestamps in console logs:

```
[Overlay] Dispatching step: {..., timestamp: 1720519200000}
[Content] Forwarding qa-step-recorded: ...
[SW] Forwarding STEP_RECORDED: ...
[Flow] Received message: STEP_RECORDED
[Flow] Processing STEP_RECORDED

... 50ms gap ...

[Overlay] Dispatching step: {..., timestamp: 1720519200050}
```

**If timestamp gap < 100ms between identical selectors:**
→ Duplicate event issue

**If timestamp gap > 500ms:**
→ Legitimate second click (user error or test issue)

---

## Fixes Applied

### Fix 1: Event Listener Deduplication (content.js)

**Added:**
```javascript
let lastEventDetail = null;
let lastEventTime = 0;

document.addEventListener('qa-step-recorded', (e) => {
  const now = Date.now();
  const detail = JSON.stringify(e.detail);
  
  // Prevent duplicate event forwarding within 500ms
  if (detail === lastEventDetail && (now - lastEventTime) < 500) {
    console.log('[Content] Duplicate qa-step-recorded event blocked');
    return;
  }
  
  lastEventDetail = detail;
  lastEventTime = now;
  
  console.log('[Content] Forwarding qa-step-recorded:', e.detail.target?.cssSelector);
  chrome.runtime.sendMessage({ type: 'STEP_RECORDED', data: e.detail });
});
```

**Purpose:** Prevents content.js from forwarding duplicate custom events

---

### Fix 2: Custom Event Configuration (overlay.js)

**Changed:**
```javascript
document.dispatchEvent(new CustomEvent('qa-step-recorded', { 
  detail: stepData,
  bubbles: false,   // 🆕 Don't bubble to prevent multiple captures
  cancelable: false // 🆕 Not cancelable
}));
```

**Purpose:** Prevents event from bubbling and being captured multiple times

---

### Fix 3: Enhanced Logging

**Added logging at every stage:**
- `[Overlay]` - When step is dispatched
- `[Content]` - When event is forwarded
- `[SW]` - When service worker forwards to popup
- `[Flow]` - When popup receives and processes

**Purpose:** Track exact flow and identify where duplication occurs

---

## Testing Procedure

### Test 1: Single Button Click

1. Open all 3 console windows
2. Click a simple button once
3. Check logs:

**Expected:**
```
TARGET PAGE:
[Overlay] Dispatching step: {action: "click", selector: "button.btn", ...}

SERVICE WORKER:
[SW] Forwarding STEP_RECORDED: button.btn

POPUP:
[Flow] Received message: STEP_RECORDED {selector: "button.btn"}
[Flow] Processing STEP_RECORDED
```

**Expected Result:** 1 step in timeline

---

### Test 2: Complex Nested Element

HTML:
```html
<tr id="6a4e00cadc41e67881c1ed1a">
  <td class="sorting_2">
    <div>
      <a class="task-description" data-target="#edit">task1</a>
    </div>
  </td>
</tr>
```

Click the `<a>` element once.

**Expected:**
```
TARGET PAGE:
[Overlay] Dispatching step: {selector: "a.task-description[data-target='#edit']", ...}

SERVICE WORKER:
[SW] Forwarding STEP_RECORDED: a.task-description[data-target='#edit']

POPUP:
[Flow] Received message: STEP_RECORDED {selector: "a.task-description[...]"}
[Flow] Processing STEP_RECORDED
```

**Expected Result:** 1 step with selector `a.task-description[data-target="#edit"]`

**NOT:**
- Multiple steps with different selectors
- Steps with full DOM paths
- Steps with XPath alternatives

---

### Test 3: Rapid Clicking

Click the same button 3 times rapidly (within 1 second)

**Expected:**
```
TARGET PAGE:
[Overlay] Dispatching step: {..., timestamp: 1000}
[Overlay] Duplicate click ignored (same element within 500ms)
[Overlay] Duplicate click ignored (same element within 500ms)

POPUP:
[Flow] Received message: STEP_RECORDED
[Flow] Processing STEP_RECORDED
```

**Expected Result:** 1 step only (2nd and 3rd clicks blocked)

---

## Common Issues

### Issue 1: loc.locators array being iterated

**Symptom:** Each alternative locator becomes a separate step

**Check:** Search for this pattern in code:
```javascript
// ❌ WRONG
loc.locators.forEach(locator => {
  addStep(locator.value);
});

// ✅ CORRECT
const bestLocator = loc.bestLocator;
addStep(bestLocator);
```

**Fix:** Only use `loc.bestLocator`, never iterate `loc.locators`

---

### Issue 2: Event listener stacking

**Symptom:** Each click creates N steps, where N = number of times scripts injected

**Check:** 
```javascript
getEventListeners(document)['qa-step-recorded']?.length
```

**Fix:** Add protection flag at top of content.js and overlay.js:
```javascript
if (window.__qaContentLoaded) return;
window.__qaContentLoaded = true;
```

---

### Issue 3: Message loop

**Symptom:** Messages bounce between service worker and popup

**Check:** Look for message forwarding loops in logs

**Fix:** Ensure service worker only forwards to popup, not back to content

---

## Emergency Rollback

If issues persist, temporarily disable smart recording:

```javascript
// In overlay.js, add at top of onSmartClick:
function onSmartClick(e) {
  console.error('[DEBUG] Smart recording temporarily disabled');
  return;  // 🚨 TEMPORARY - blocks all recording
  
  // ... rest of function
}
```

Then investigate with logging active but no steps being created.

---

## Success Criteria

✅ **Target Page Console:** Only 1 "[Overlay] Dispatching step" per click
✅ **Service Worker Console:** Only 1 "[SW] Forwarding" per click
✅ **Popup Console:** Only 1 "[Flow] Received message" per click
✅ **Timeline:** Only 1 step per click
✅ **Selector:** Best locator only (e.g., `a.task-description[data-target="#edit"]`)
✅ **No alternatives:** XPath/CSS alternatives NOT added as separate steps

---

## Next Steps

If problem persists after all fixes:

1. **Clear extension and reload:**
   ```
   chrome://extensions → Remove → Reinstall
   ```

2. **Check for conflicting extensions:**
   - Disable other developer tools
   - Test in Incognito mode

3. **Verify script injection order:**
   ```javascript
   // In service-worker.js, check this order:
   'locator-engine/locator-generator.js',  // First
   'content/overlay.js',                   // Second
   'content/content.js'                    // Third
   ```

4. **Report detailed logs:**
   - Export all 3 console outputs
   - Include HTML of problem element
   - Share timeline screenshot showing duplicate steps
