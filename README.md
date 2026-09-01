# Smart QA Test Case Creator

## Iframe Support

## Overview
This extension now fully supports capturing elements and interacting with elements inside iframes, including nested iframes. The extension intelligently tracks the document context when an element is clicked and provides a precise `framePath` along with the standard element locator, ensuring cross-origin and same-origin frames are supported correctly without violating browser security policies.

## Why iframe handling is different
An `<iframe>` creates an entirely separate `document` context. Normal CSS selectors like `iframe#my-frame .my-button` do not work because the browser prevents piercing the iframe boundary natively. Test execution tools (Selenium, Playwright, Cypress) require explicitly switching their driver context to the target iframe before locating the element inside it.

## Architecture
The extension relies on its existing architecture and Chrome's content script injection:
1. **Script Injection:** Background script (`service-worker.js`) now uses `allFrames: true` (or frame-specific targeting) to inject `content.js` and `overlay.js` into every iframe (same-origin and cross-origin).
2. **Path Discovery:** When `content.js` initializes in an iframe context (`window !== window.top`), it sends a `postMessage` (`QA_EXTENSION_GET_IFRAME_LOCATOR`) to its parent window.
3. **Hierarchy Building:** The parent window identifies which `<iframe>` element corresponds to the child window, generates a stable locator for it, prepends its own `framePath` (if any), and sends the complete path back to the child.
4. **Recording:** When an interaction occurs inside the iframe, `overlay.js` includes the discovered `framePath` in the captured payload.

## How iframe detection works
We use `window.parent.postMessage` to communicate up the frame hierarchy. The parent uses `event.source` to find the exact `<iframe>` element in its DOM that fired the message. This avoids CORS issues because `postMessage` is explicitly designed for cross-origin communication.

## Same-origin iframe handling
Handled naturally via the content script injection and `postMessage` architecture. No special bypasses are used.

## Cross-origin iframe handling
Handled exactly the same as same-origin frames. Chrome injects the content script into the cross-origin frame (using standard extension permissions), and `postMessage` handles the path discovery across boundaries without violating the same-origin policy.

## Nested iframe handling
By communicating sequentially up the frame hierarchy (child -> parent -> grandparent), nested iframes automatically accumulate their complete paths. A nested frame will wait for its parent to resolve its own `framePath` before the parent resolves the child's path.

## Captured data structure
The capture payload for any step now includes a `framePath` array alongside the usual element target.

## framePath specification
The `framePath` is an ordered array of frame locator objects, starting from the outermost frame (closest to the main document) down to the innermost frame containing the element.

```json
[
  {
    "selector": "#outer-frame",
    "selectorType": "css",
    "index": 0,
    "id": "outer-frame",
    "name": "payment-frame",
    "title": "Payment",
    "src": "https://example.com/payment"
  }
]
```

## Element locator specification
The element locator remains exactly the same as before, preserving backward compatibility.
```json
{
  "tag": "button",
  "id": "submit-btn",
  "classes": ["btn", "primary"],
  "cssSelector": "button#submit-btn",
  "customLocator": "data-testid=submit",
  "attributes": { "type": "submit" }
}
```

## Example captured payloads

### Normal element
For an element in the main document, `framePath` is an empty array.
```json
{
  "action": "click",
  "target": {
    "tag": "button",
    "cssSelector": "#login"
  },
  "framePath": []
}
```

### Element inside iframe
```json
{
  "action": "type",
  "target": {
    "cssSelector": "#cardNumber"
  },
  "framePath": [
    {
      "selector": "#payment-frame",
      "selectorType": "css",
      "index": 0,
      "id": "payment-frame",
      "name": "payment"
    }
  ]
}
```

### Element inside nested iframe
```json
{
  "action": "click",
  "target": {
    "cssSelector": "#submit"
  },
  "framePath": [
    {
      "selector": "#outer-frame",
      "selectorType": "css",
      "index": 0
    },
    {
      "selector": "iframe[name='checkout']",
      "selectorType": "css",
      "index": 0
    }
  ]
}
```

## Flow behavior
Existing workflows remain exactly the same. The `framePath` is purely additive. If the user interacts with an element in the main document, `framePath: []` is recorded. If they click an element in an iframe, the `framePath` is recorded alongside the click. We do not automatically insert explicit "Switch Frame" steps into the UI timeline; instead, the context is bound directly to the interaction step.

## Backend Integration Contract
The backend receives a flow containing sequential steps. Each step includes an `action`, `target` (element locator), and `framePath`.
The backend **must** execute the action in the appropriate document context by dynamically switching to the iframes defined in the `framePath`.

## Selenium execution strategy
```python
driver.switch_to.default_content()

# Switch down the hierarchy
for frame in step.get("framePath", []):
    frame_element = locate_frame(frame)
    WebDriverWait(driver, 10).until(
        EC.frame_to_be_available_and_switch_to_it(frame_element)
    )

element = locate_element(step.get("target"))
execute_action(element, step.get("action"))

# Optional: Return to default content if the backend prefers a clean slate per step
driver.switch_to.default_content()
```

## Frame locator resolution
Backends should resolve frames in the following priority order based on the provided metadata:
1. stable ID (`frame.id`)
2. stable name (`frame.name`)
3. stable CSS selector (`frame.selector`)
4. XPath
5. frame index (`frame.index` fallback)

## Wait strategy
Backends should use explicit waits (`frame_to_be_available_and_switch_to_it` in Selenium) when switching frames, as iframes may load dynamically or be delayed.

## Dynamic iframe handling
If an iframe is added dynamically via AJAX, Chrome's `webNavigation.onCompleted` detects the new subframe and automatically injects `content.js`, which then immediately asks its parent for the `framePath`.

## Error handling
If a frame is unavailable during test execution, the backend should raise a specific `FRAME_NOT_FOUND` error outlining the failure at a specific depth in the `framePath`, rather than falling back to the main document.

## Limitations
- Heavily restricted cross-origin policies (like `sandbox="allow-scripts"` without `allow-same-origin`) may sometimes block Chrome extension content scripts from functioning normally, though this is rare in typical test environments.

## Security considerations
We rely entirely on standard Chrome Extension messaging (`postMessage` and `chrome.runtime.sendMessage`). No CORS policies are bypassed, and no sensitive tokens/URLs are stored unnecessarily (e.g. `src` is captured, but we prefer ID/Name locators).

## Backward compatibility
`framePath: []` completely preserves the behavior for all existing non-iframe flows.

## Testing
We have added an automated HTML-based test suite in `tests/iframe-tests.html`. Open it in the browser to run validation for:
- Normal page interactions
- Single iframes
- Nested iframes
- Dynamic iframes
- Multiple sibling iframes
- Cross-origin simulation

## Example end-to-end flow
```json
[
  {
    "action": "click",
    "target": { "cssSelector": "#login-btn" },
    "framePath": []
  },
  {
    "action": "type",
    "value": "12345",
    "target": { "cssSelector": "#cc-number" },
    "framePath": [
      { "selector": "#stripe-frame", "selectorType": "css", "index": 0 }
    ]
  }
]
```