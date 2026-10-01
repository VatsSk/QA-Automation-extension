# Smart QA Test Case Creator - Presentation Context Document

This document provides structured context about the "Smart QA Test Case Creator" Chrome Extension. It is designed to be fed to an AI agent to generate a PowerPoint (PPT) presentation.

## Slide 1: Title Slide
*   **Title:** Smart QA Test Case Creator
*   **Subtitle:** Automated, intelligent test scenario recording directly from your browser.
*   **Target Audience:** QA Engineers, Automation Developers, Product Managers.

## Slide 2: The Problem
*   Writing automated end-to-end (E2E) tests is time-consuming and repetitive.
*   Manually inspecting elements to find reliable locators (CSS, XPath, IDs) slows down QA velocity.
*   Translating manual test steps into executable scripts (Playwright, Cypress, Selenium) requires specialized coding skills and context switching.

## Slide 3: The Solution (Overview)
*   **What it is:** A Manifest V3 Chrome Extension that acts as a persistent QA test run recorder.
*   **Core Capability:** Records user interactions on web pages in real-time, captures smart DOM element locators, and builds modular test scenarios.
*   **The Magic:** Instantly exports recorded flows into executable test scripts for modern frameworks (Playwright, Cypress, Selenium).

## Slide 4: Key Features
1.  **Interaction Recording:** Automatically captures clicks, text input, form submissions, drop-down selections, and key presses.
2.  **Smart Element Capture:** Generates robust, multi-strategy locators on the fly.
3.  **Scenario Management:** Save, edit, and organize test steps within a sleek, built-in UI.
4.  **One-Click Export & Sync:** Download code directly or sync scenarios with a backend API.

## Slide 5: The Smart Locator Engine
*   **Intelligent Ranking:** Does not just blindly grab the first selector; it analyzes the DOM to find the most robust locator to prevent test flakiness.
*   **Priority Strategy:** 
    1. `data-testid` / `data-qa` (Most robust)
    2. `#id`
    3. ARIA accessibility attributes (`aria-label`, `role`)
    4. Text-based XPath
    5. CSS Selectors
    6. Absolute XPath (Fallback)

## Slide 6: High-Level Architecture
*   **Popup / UI (`popup.js`):** The control center for managing scenarios and recording states.
*   **Background Service Worker (`service-worker.js`):** The message router tracking recording states across tabs and injecting scripts.
*   **Content Bridge & Overlay (`content.js`, `overlay.js`):** The engine injected into the target page. Attaches event listeners, highlights elements, and captures precise DOM data.
*   **No Heavy Frameworks:** Built with pure Vanilla JavaScript and direct DOM manipulation for maximum performance and minimal overhead.

## Slide 7: Technical Data Flow
1.  **User Action:** User interacts with the web page (e.g., clicks a button).
2.  **Engine Capture:** `overlay.js` intercepts the event, highlights the element, and invokes the Locator Engine.
3.  **Message Routing:** Custom DOM events are bridged by `content.js` to Chrome's messaging API, sending data to the Service Worker.
4.  **State Update:** The `popup.js` UI receives the step, updates the scenario schema, and saves to `chrome.storage.local`.

## Slide 8: UI & Design System
*   **Aesthetic:** Modern, dark professional theme (Navy/Purple palette).
*   **Two-Pane System:** 
    *   *Scenario List View:* For browsing, searching, and managing saved tests.
    *   *Recorder View:* A live dashboard showing recorded steps, controls (Record/Pause/Stop), and a real-time Element Inspector panel.
*   **Visual Feedback:** In-page highlight overlays, click ripple markers, and a "Recording" indicator ensure the user always knows what is being captured.

## Slide 9: Exporting & Ecosystem Integration
*   The system uses a robust Data Schema to normalize steps.
*   Translates generic actions (`click`, `type`, `select`) into framework-specific syntax.
*   **Supported Exports:**
    *   **Playwright:** (e.g., `await page.locator(...).click()`)
    *   **Cypress:** (e.g., `cy.get(...).click()`)
    *   **Selenium:** (e.g., `driver.findElement(...).click()`)
*   **Cloud Sync:** Built-in HTTP client (`api-client.js`) syncs scenarios to centralized team servers.
