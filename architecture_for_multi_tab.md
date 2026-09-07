# QA Automation Extension - Architecture Overview

## Introduction
This document outlines the architecture of the "Smart QA Test Case Creator" Chrome Extension (Manifest V3). 
Currently, the extension only supports recording interactions on a **single tab** at a time. The ultimate goal is to research and implement **multi-tab access**, allowing the extension to record cross-tab scenarios or handle parallel tab recordings.

## 1. Project Structure
```text
extension/
├── manifest.json                      
├── background/
│   └── service-worker.js              # Background service worker — message router & script injector
├── content/
│   ├── content.js                     # Content script bridge (Chrome messaging ↔ DOM events)
│   ├── overlay.js                     # Recording engine — captures interactions & highlights elements
│   └── overlay.css                    
├── popup/
│   ├── popup.html                     
│   ├── popup.js                       # Core app logic — UI state, recording lifecycle, step management
│   └── popup.css                      
├── api/
│   └── api-client.js                  
├── locator-engine/
│   └── locator-generator.js           
├── scenario-builder/
│   └── schema.js                      
└── storage/
    └── storage.js                     
```

## 2. Architecture & Data Flow
```text
[User Interaction on Web Page]
        │
        ▼
[overlay.js]  ──── captures click/input/change/submit/keydown events
        │           generates locators via LocatorGenerator
        │
        ▼ (custom DOM events: qa-element-captured, qa-step-recorded)
[content.js]  ──── bridges page-level DOM events to Chrome extension messaging
        │
        ▼ (chrome.runtime.sendMessage)
[service-worker.js] ──── central message router
        │                  manages content script injection lifecycle
        │                  tracks recording state per tab (CURRENT BOTTLENECK)
        │
        ▼ (forwarded messages)
[popup.js]  ──── updates UI, manages scenario state, renders steps
```

## 3. Core Components & State Management (The Single-Tab Bottleneck)

### Background Service Worker (`background/service-worker.js`)
- Acts as the central message router.
- Injects content scripts dynamically.
- **Current Limitation:** It tracks recording state using a single state object: `recordingState = {isRecording, isPaused, tabId}`. If a new tab starts recording, it overwrites or conflicts with the existing state.

### Popup UI (`popup/popup.js`)
- Manages the UI state, active steps, and scenario lifecycle.
- **Current Limitation:** `isRecording`, `isPaused`, and `currentScenario` are global variables within the popup context. It does not map active scenarios to specific tabs.

### Content Scripts (`content/content.js` & `content/overlay.js`)
- Dynamically injected into the active tab when recording starts.
- Forwards user actions to the background worker.

## 4. Messaging Protocol
All inter-component communication uses Chrome's messaging API with a `type` field.
- **Popup -> Background:** `START_RECORDING {tabId}`, `STOP_RECORDING {tabId}`, `GET_RECORDING_STATE`
- **Background -> Content Script:** `START_RECORDING`, `STOP_RECORDING`
- **Content Script -> Background -> Popup:** `ELEMENT_CAPTURED`, `STEP_RECORDED`

## 5. Objectives for Claude (Multi-Tab Research)
Please analyze this architecture and propose a comprehensive design to support multi-tab recording. Specific questions to address:
1. **Background State Refactoring:** How should the background worker state be restructured (e.g., `Map<tabId, recordingState>`) to handle multiple tabs seamlessly?
2. **Popup UI Management:** How should `popup.js` manage multiple active recordings? Should the UI bind the active view to the currently focused Chrome tab, or display a list of active recording sessions?
3. **Message Routing:** How do we ensure `STEP_RECORDED` messages from multiple background tabs correctly append to the correct scenario in the popup or storage without race conditions?
4. **Cross-Tab Scenarios:** If a user clicks a link that opens a *new* tab, how can the extension automatically inject content scripts into the newly spawned tab and continue the *same* scenario?
