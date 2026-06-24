# Smart QA Test Case Creator — Project Context

> **Type:** Chrome Extension (Manifest V3)
> **Purpose:** A persistent QA test run recorder with smart element capture. Records user interactions on web pages, captures DOM element locators, builds test scenarios, and exports them as executable test scripts (Playwright / Cypress / Selenium).

---

## 1. Project Structure

```
extension/
├── manifest.json                      # Chrome Extension Manifest V3 config
├── README.md
├── assets/                            # Extension icons
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
├── background/
│   └── service-worker.js              # Background service worker — message router & script injector
├── content/
│   ├── content.js                     # Content script bridge (Chrome messaging ↔ DOM events)
│   ├── overlay.js                     # Recording engine — captures interactions & highlights elements
│   └── overlay.css                    # Styles for recording overlay (highlight, indicator, tooltip)
├── popup/
│   ├── popup.html                     # Main UI structure (scenario list + recorder views)
│   ├── popup.js                       # Core app logic — UI state, recording lifecycle, step management
│   └── popup.css                      # Full styling with CSS custom properties (dark theme)
├── api/
│   └── api-client.js                  # HTTP client for backend sync (ApiClient class)
├── locator-engine/
│   └── locator-generator.js           # Smart locator generation (LocatorGenerator class)
├── scenario-builder/
│   └── schema.js                      # Data model, validation, test script generation (ScenarioSchema class)
└── storage/
    └── storage.js                     # chrome.storage.local wrapper (StorageManager class)
```

---

## 2. Architecture & Data Flow

```
[User Interaction on Web Page]
        │
        ▼
[overlay.js]  ──── captures click/input/change/submit/keydown events
        │           generates locators via LocatorGenerator
        │           highlights elements with overlay div
        │
        ▼ (custom DOM events: qa-element-captured, qa-step-recorded)
[content.js]  ──── bridges page-level DOM events to Chrome extension messaging
        │
        ▼ (chrome.runtime.sendMessage)
[service-worker.js] ──── central message router
        │                  manages content script injection lifecycle
        │                  tracks recording state per tab
        │
        ▼ (forwarded messages)
[popup.js]  ──── updates UI, manages scenario state, renders steps
        │
        ├──▶ [StorageManager]    persists scenarios to chrome.storage.local
        ├──▶ [ApiClient]         syncs scenarios with backend server
        └──▶ [ScenarioSchema]    validates & transforms data, generates test scripts
```

---

## 3. Manifest Configuration

- **Manifest Version:** 3
- **Permissions:** `activeTab`, `scripting`, `storage`, `tabs`, `windows`
- **Host Permissions:** `<all_urls>`
- **Service Worker:** `background/service-worker.js`
- **Content Scripts:** Dynamically injected (not declared in manifest)
- **Externally Connectable:** `localhost:8080`, `localhost:8088`, `3.7.136.248:8088`
- **Web Accessible Resources:** popup files, schema.js, storage.js, api-client.js, asset PNGs

---

## 4. Module Details

### 4.1 `popup/popup.js` (Core App Logic — ~46KB)

The largest and most complex file. Manages the entire popup UI lifecycle.

**Key Functions:**

| Function | Purpose |
|---|---|
| `initPopup()` | Entry point — sets up listeners, loads scenarios, sets initial view |
| `loadScenarios()` | Fetches all scenarios from StorageManager, renders list |
| `renderScenarioList(scenarios, filter)` | Renders scenario cards with name, steps, status, actions |
| `createNewScenario()` | Switches to recorder view with empty state |
| `openScenario(id)` | Loads existing scenario for editing |
| `startRecording()` | Tells background to inject scripts & start recording |
| `pauseRecording()` | Pauses active recording |
| `stopRecording()` | Stops recording, returns to idle |
| `saveScenario()` | Validates & saves scenario via StorageManager |
| `deleteScenario(id)` | Deletes scenario after confirmation |
| `addStep(stepData)` | Adds step to current scenario |
| `renderStep(step, index)` | Creates DOM for a step row |
| `handleElementCaptured(data)` | Populates inspector panel with captured element data |
| `showInspector(elementData)` | Displays element details |
| `exportScenario(id, format)` | Exports as JSON or test script |
| `syncScenarios()` | Syncs to backend via ApiClient |
| `handleMessage(message)` | Central message handler |

**State Variables:**
- `currentScenario` — active scenario object
- `isRecording` / `isPaused` — recording state flags
- `currentSteps` — array of recorded steps
- `capturedElement` — last captured element data

**Dependencies:** `StorageManager`, `ApiClient`, `ScenarioSchema`

---

### 4.2 `popup/popup.html` (UI Structure)

Two-view layout inside `<div id="qa-panel-root">`:

1. **Scenario List View** (`#scenario-list-view`):
   - Search/filter input (`#scenario-search`)
   - Scenario list container (`#scenario-list`)
   - "New Scenario" button (`#new-scenario-btn`)
   - "Sync Now" button (`#sync-now-btn`)

2. **Recorder View** (`#recorder-view`):
   - Scenario name input (`#scenario-name`)
   - Step list (`#step-list`)
   - Action bar: Record (`#record-btn`), Pause (`#pause-btn`), Stop (`#stop-btn`), Save (`#save-btn`), Add Step (`#add-step-btn`)
   - Element Inspector panel (`#element-inspector`) with fields: tag, ID, classes, text, XPath, CSS selector, custom locator

---

### 4.3 `popup/popup.css` (Styling — ~24KB)

Dark professional theme with CSS custom properties:

```css
--primary: #6C5CE7          /* Purple accent */
--primary-light: #A29BFE
--bg-dark: #1a1a2e          /* Dark navy background */
--bg-card: #16213e
--bg-input: #0f3460
--text-primary: #e0e0e0
--text-secondary: #a0a0b0
--success: green, --warning: amber, --danger: red
--radius: 8px
```

- Panel: `380px` wide, `100vh` height, fixed position
- Pulsing animation on `.btn-record` when active
- Slide-in `.element-inspector` panel
- Status badges for draft/recording/complete states
- All prefixed to avoid host page conflicts

---

### 4.4 `background/service-worker.js` (Message Router — ~7KB)

**Key Functions:**

| Function | Purpose |
|---|---|
| `handleMessage(message, sender, sendResponse)` | Main router — dispatches by `message.type` |
| `startRecording(tabId)` | Injects content.js, overlay.js, overlay.css, locator-generator.js into tab |
| `stopRecording(tabId)` | Sends STOP_RECORDING to content script |
| `pauseRecording(tabId)` | Sends PAUSE_RECORDING to content script |
| `forwardToPopup(message)` | Forwards content script messages to popup |
| `injectContentScripts(tabId)` | Script injection logic with error handling |

**Message Types Handled:**
- `START_RECORDING` → injects scripts, responds success/failure
- `STOP_RECORDING` → tells content script to stop
- `PAUSE_RECORDING` → tells content script to pause
- `ELEMENT_CAPTURED` / `STEP_RECORDED` → forwards to popup
- `GET_RECORDING_STATE` → returns recording state
- `OPEN_POPUP` → creates/focuses popup window

**State:** `recordingState` object `{isRecording, isPaused, tabId}`, `popupWindowId`

**Trigger:** `chrome.action.onClicked` opens popup panel

---

### 4.5 `content/content.js` (Bridge Script — ~1.6KB)

Lightweight bridge between Chrome extension messaging and page-level DOM events.

**Inbound (from background):**
- `START_RECORDING` → dispatches `qa-start-recording` DOM event
- `STOP_RECORDING` → dispatches `qa-stop-recording`
- `PAUSE_RECORDING` → dispatches `qa-pause-recording`

**Outbound (from overlay.js via DOM events):**
- `qa-element-captured` → `chrome.runtime.sendMessage({type: 'ELEMENT_CAPTURED', data})`
- `qa-step-recorded` → `chrome.runtime.sendMessage({type: 'STEP_RECORDED', data})`

---

### 4.6 `content/overlay.js` (Recording Engine — ~8.4KB)

Main recording logic injected into the target page.

**Key Functions:**

| Function | Purpose |
|---|---|
| `startRecording()` | Attaches click, input, change, submit, keydown listeners |
| `stopRecording()` | Removes listeners, cleans up overlay |
| `pauseRecording()` | Sets ignore flag without removing listeners |
| `handleClick(e)` | Captures clicks, generates locators |
| `handleInput(e)` | Captures text input (debounced 500ms) |
| `handleChange(e)` | Captures select/checkbox/radio changes |
| `handleSubmit(e)` | Captures form submissions |
| `handleKeydown(e)` | Captures Enter, Tab, Escape keys |
| `highlightElement(el)` | Shows colored overlay on hovered/clicked elements |
| `captureElementData(el)` | Extracts all element metadata + locators |
| `emitElementCaptured(data)` | Dispatches `qa-element-captured` event |
| `emitStepRecorded(stepData)` | Dispatches `qa-step-recorded` event |

---

### 4.7 `content/overlay.css` (Recording Overlay Styles — ~3.7KB)

- `.qa-highlight-overlay` — hover highlight (`rgba(108, 92, 231, 0.15)`)
- `.qa-recording-indicator` — red dot "Recording..." indicator (top-right)
- `.qa-element-tooltip` — element info tooltip near cursor
- `.qa-click-marker` — ripple animation at click locations
- All selectors prefixed with `.qa-` to avoid conflicts
- `z-index: 2147483647` (maximum) to stay above page content

---

### 4.8 `api/api-client.js` (HTTP Client — ~1.7KB)

**Class: `ApiClient`**

| Method | Purpose |
|---|---|
| `constructor(baseUrl)` | Defaults to `http://localhost:8088/api` |
| `syncScenarios(scenarios)` | POST `/scenarios/sync` |
| `getScenarios()` | GET `/scenarios` |
| `exportScenario(id, format)` | GET `/scenarios/${id}/export?format=${format}` |
| `healthCheck()` | GET `/health` |
| `_request(endpoint, options)` | Internal fetch wrapper with error handling |

**Backend URLs:** `localhost:8088`, `3.7.136.248:8088`

---

### 4.9 `locator-engine/locator-generator.js` (Locator Engine — ~7.3KB)

**Class: `LocatorGenerator`**

| Method | Purpose |
|---|---|
| `generate(element)` | Returns object with all locator strategies |
| `generateId(el)` | `#id` selector |
| `generateCssSelector(el)` | CSS selector via tag, classes, attributes, nth-child |
| `generateXPath(el)` | Absolute XPath |
| `generateRelativeXPath(el)` | Shorter relative XPath |
| `generateTextLocator(el)` | XPath by text content |
| `generateCustomLocator(el)` | `data-testid`, `data-qa`, `data-cy`, `data-test` |
| `generateAriaLocator(el)` | `aria-label`, `role`, `aria-labelledby` |
| `getBestLocator(locators)` | Ranks by reliability |
| `_isUniqueSelector(selector)` | Validates uniqueness |

**Locator Priority:** `data-testid`/`data-qa` → `#id` → `aria-label` → text XPath → CSS → absolute XPath

---

### 4.10 `scenario-builder/schema.js` (Data Model — ~13KB)

**Class: `ScenarioSchema`**

**Factory Methods:**
- `createScenario(name, description)` → new scenario with UUID, timestamps, empty steps, status=draft
- `createStep(action, target, value)` → new step with UUID, action, target data, value, timestamp

**Validation:**
- `validateScenario(scenario)` — checks required fields, types, step validity
- `validateStep(step)` — checks step structure

**Enums:**
- `ACTIONS`: `click`, `type`, `select`, `check`, `submit`, `navigate`, `scroll`, `hover`, `keypress`, `wait`, `assert`
- `STATUS`: `draft`, `recording`, `complete`, `synced`, `failed`

**Test Script Export:**
- `toTestScript(scenario, format)` — generates code for `playwright`, `cypress`, `selenium`
- Maps each action to the corresponding framework API calls

**Serialization:**
- `toJSON(scenario)` / `fromJSON(json)`

**Scenario Object Shape:**
```json
{
  "id": "uuid",
  "name": "string",
  "description": "string",
  "steps": ["Step"],
  "status": "draft|recording|complete|synced|failed",
  "createdAt": "ISO timestamp",
  "updatedAt": "ISO timestamp",
  "tags": [],
  "baseUrl": "string"
}
```

**Step Object Shape:**
```json
{
  "id": "uuid",
  "action": "click|type|select|check|submit|navigate|scroll|hover|keypress|wait|assert",
  "target": {
    "tag": "string",
    "id": "string",
    "classes": ["string"],
    "xpath": "string",
    "cssSelector": "string",
    "customLocator": "string",
    "text": "string",
    "attributes": {}
  },
  "value": "string",
  "timestamp": "ISO timestamp",
  "screenshot": null,
  "assertion": { "type": "string", "expected": "any", "actual": "any" }
}
```

---

### 4.11 `storage/storage.js` (Storage Layer — ~1.5KB)

**Class: `StorageManager`**

| Method | Purpose |
|---|---|
| `getAll()` | Returns all scenarios from `chrome.storage.local` |
| `get(id)` | Returns single scenario by ID |
| `save(scenario)` | Upserts scenario (updates `updatedAt`) |
| `delete(id)` | Removes scenario by ID |
| `clear()` | Clears all scenarios |
| `export()` | Returns all as JSON string |
| `import(jsonString)` | Replaces all from JSON |

**Storage Key:** `qa_scenarios` in `chrome.storage.local`

---

## 5. Messaging Protocol

All inter-component communication uses Chrome's messaging API with a `type` field.

### Messages from Popup → Background:
| Type | Payload | Purpose |
|---|---|---|
| `START_RECORDING` | `{tabId}` | Start recording on a tab |
| `STOP_RECORDING` | `{tabId}` | Stop recording |
| `PAUSE_RECORDING` | `{tabId}` | Pause recording |
| `GET_RECORDING_STATE` | — | Query current state |
| `OPEN_POPUP` | — | Open/focus popup window |

### Messages from Background → Content Script:
| Type | Purpose |
|---|---|
| `START_RECORDING` | Begin capturing interactions |
| `STOP_RECORDING` | Stop capturing |
| `PAUSE_RECORDING` | Pause capturing |

### Messages from Content Script → Background → Popup:
| Type | Payload | Purpose |
|---|---|---|
| `ELEMENT_CAPTURED` | Element data | User hovered/clicked an element |
| `STEP_RECORDED` | Step data | A complete interaction step was captured |
| `CONTENT_SCRIPT_READY` | — | Content script injection confirmed |

### DOM Custom Events (page context):
| Event | Direction | Purpose |
|---|---|---|
| `qa-start-recording` | content.js → overlay.js | Start recording |
| `qa-stop-recording` | content.js → overlay.js | Stop recording |
| `qa-pause-recording` | content.js → overlay.js | Pause recording |
| `qa-element-captured` | overlay.js → content.js | Element data captured |
| `qa-step-recorded` | overlay.js → content.js | Step recorded |

---

## 6. UI Design System

**Theme:** Dark professional (navy/purple)

| Token | Value | Usage |
|---|---|---|
| `--primary` | `#6C5CE7` | Buttons, accents, active states |
| `--primary-light` | `#A29BFE` | Hover states, secondary accents |
| `--bg-dark` | `#1a1a2e` | Main background |
| `--bg-card` | `#16213e` | Card backgrounds |
| `--bg-input` | `#0f3460` | Input field backgrounds |
| `--text-primary` | `#e0e0e0` | Primary text |
| `--text-secondary` | `#a0a0b0` | Secondary/muted text |
| `--success` | green | Success states |
| `--warning` | amber | Warning states |
| `--danger` | red | Error/delete states |

**Layout:** Fixed panel, 380px wide, 100vh tall, flexbox column

---

## 7. Key DOM Element IDs

| ID | File | Purpose |
|---|---|---|
| `#qa-panel-root` | popup.html | Root container |
| `#scenario-list-view` | popup.html | Scenario list view |
| `#scenario-search` | popup.html | Search input |
| `#scenario-list` | popup.html | Scenario cards container |
| `#new-scenario-btn` | popup.html | Create new scenario |
| `#sync-now-btn` | popup.html | Sync with backend |
| `#recorder-view` | popup.html | Recorder view |
| `#scenario-name` | popup.html | Scenario name input |
| `#step-list` | popup.html | Steps container |
| `#record-btn` | popup.html | Start/resume recording |
| `#pause-btn` | popup.html | Pause recording |
| `#stop-btn` | popup.html | Stop recording |
| `#save-btn` | popup.html | Save scenario |
| `#add-step-btn` | popup.html | Manually add a step |
| `#element-inspector` | popup.html | Element details panel |
| `#inspector-tag` | popup.html | Element tag display |
| `#inspector-id` | popup.html | Element ID display |
| `#inspector-classes` | popup.html | Element classes display |
| `#inspector-text` | popup.html | Element text display |
| `#inspector-xpath` | popup.html | XPath display |
| `#inspector-css` | popup.html | CSS selector display |
| `#inspector-custom` | popup.html | Custom locator display |

---

## 8. Development Notes

- **No build system** — plain JavaScript, no bundler/transpiler
- **No framework** — vanilla JS with direct DOM manipulation
- **Module loading** — `popup.js` loaded as ES module; content scripts injected programmatically
- **Backend** — expected at `localhost:8088` or `3.7.136.248:8088` (API endpoints under `/api/`)
- **Storage** — `chrome.storage.local` with key `qa_scenarios`
- **Test export formats** — Playwright, Cypress, Selenium
- **Locator strategy** — prioritizes `data-testid` > `id` > `aria` > `text` > `css` > `xpath`
