# Quick Debug: Multiple Steps Issue

## What to Do Right Now

### Step 1: Reload Extension
1. Go to `chrome://extensions`
2. Find "Smart QA Test Case Creator"
3. Click "Remove"
4. Reload the extension folder

### Step 2: Open Target Page Console
1. Go to the page where you're recording
2. Press **F12**
3. Go to **Console** tab
4. Click the **Clear** button (🚫)

### Step 3: Open Popup Console
1. Open the recorder popup
2. Press **F12** on the popup
3. Go to **Console** tab  
4. Click **Clear**

### Step 4: Click ONE Element
Click a single button/link on the target page

### Step 5: Check Target Page Console

You should see something like this:

```
[Overlay] Click #1 - Event received: {type: "click", target: "BUTTON", targetClass: "close-btn", targetId: ""}
[Overlay] Click #1 - Resolved element: {tag: "BUTTON", id: "task-edit-close-modal", className: "close-btn", ariaLabel: "Close"}
[Overlay] Click #1 - Proceeding (new element or 999999ms gap)
[Overlay] Dispatching step: {action: "click", selector: "#task-edit-close-modal", element: "BUTTON", ...}
```

**If you see Click #1, #2, #3, #4, etc. all from ONE click** → Problem is multiple click events firing

**If you see different selectors in "Dispatching step"** → Locator generator issue

### Step 6: Check Popup Console

You should see:

```
[Flow] Message #1 - Received STEP_RECORDED: {selector: "#task-edit-close-modal", action: "click", ...}
[Flow] Processing STEP_RECORDED
[Flow] Adding step: {type: "click", selector: "#task-edit-close-modal", value: ""}
```

**If you see Message #1, #2, #3, #4... for ONE click** → Problem is messages being duplicated

**If you see many "Duplicate step ignored"** → Messages arriving but being caught (good)

## Common Patterns

### Pattern A: Click Event Firing Multiple Times
```
[Overlay] Click #1 - Event received...
[Overlay] Click #2 - Event received...  ← Within milliseconds
[Overlay] Click #3 - Event received...
```
**Cause:** Still listening to multiple event types or event propagation issue

### Pattern B: Same Element, Multiple Dispatches
```
[Overlay] Click #1 - Resolved element: {tag: "BUTTON", id: "close-btn"}
[Overlay] Click #1 - Proceeding...
[Overlay] Dispatching step: {selector: "#close-btn"}
[Overlay] Dispatching step: {selector: "#close-btn"}  ← DUPLICATE!
```
**Cause:** `dispatchSmartStep` being called multiple times

### Pattern C: Different Elements Resolved
```
[Overlay] Click #1 - Resolved element: {tag: "BUTTON", id: "close-btn"}
[Overlay] Click #2 - Resolved element: {tag: "SPAN", id: "overlay"}  ← Different!
```
**Cause:** Clicking is propagating through DOM, multiple elements being captured

### Pattern D: Message Duplication
```
[Flow] Message #1 - Received STEP_RECORDED: {selector: "#close-btn"}
[Flow] Message #2 - Received STEP_RECORDED: {selector: "#close-btn"}
[Flow] Message #3 - Received STEP_RECORDED: {selector: "#close-btn"}
```
**Cause:** Content script or service worker forwarding multiple times

## Quick Fix Attempts

### Fix 1: If Click Events Multiplying

In `content/overlay.js`, try increasing the deduplication window:

```javascript
// Change this line:
if (lastResolvedElement === resolvedEl && timeSinceLastClick < 500) {

// To this:
if (lastResolvedElement === resolvedEl && timeSinceLastClick < 1000) {
```

### Fix 2: If Messages Duplicating

In `content/content.js`, try increasing the event deduplication:

```javascript
// Change this line:
if (detail === lastEventDetail && (now - lastEventTime) < 500) {

// To this:
if (detail === lastEventDetail && (now - lastEventTime) < 1000) {
```

### Fix 3: If Different Selectors

This means element or its properties are changing. Check if:
- Modal is animating (wait for animation to complete)
- Classes are being toggled on click
- DOM is being modified dynamically

## Share This Info

If issue persists, share:

1. **Target page console output** (all [Overlay] messages)
2. **Popup console output** (all [Flow] messages)
3. **HTML of the element** you're clicking (right-click → Inspect)
4. **How many steps** actually get added vs how many messages you see

This will pinpoint the exact issue!
