# Web Panel Search - Implementation Learnings

## Problem

After the initial search in the web panel works correctly, adding more characters doesn't trigger an automatic search. The root cause involves Electron's `findInPage()` stealing focus from the search input to the webview.

## Key Files

- `renderer/panel-search.js` - Search bar UI, debounce logic, focus management
- `renderer/web-panel.js` - Webview setup, injected scripts, console-message back-channel

## Architecture Context

- Electron 28 (Chromium 120), using `<webview>` tags
- Key events inside a webview DON'T bubble to the parent document
- Existing pattern: inject JS into webview + use `console.log` / `console-message` as back-channel (used for Cmd+F interception)
- `findInPage()` is a known focus stealer (Electron issue #22880, closed 2020, never truly fixed for webview tags)

## Attempted Solutions

### 1. FAILED - Remove `scheduleSearch()` from `reclaimFocus()`

**Rationale:** `reclaimFocus()` was calling `scheduleSearch()` whenever `input.value !== currentQuery`, which reset the 200ms debounce timer repeatedly (via reclaimFocus timers at 0/50/150/300ms + found-in-page events), preventing the search from ever firing for new characters.

**Change:** Removed the `scheduleSearch()` call from `reclaimFocus()`, leaving it to only call `input.focus()`. The `input` event listener (line ~89) should handle triggering searches when the user types.

**Result:** FAILED - Subsequent searches don't trigger at all. The `input` event listener never fires because `findInPage` steals focus to the webview, so keystrokes go to the webview instead of the search input.

### 2. FAILED - Always reclaim focus when bar is visible (aggressive blur handler)

**Rationale:** The blur handler only reclaimed focus during the `findActive` window (500ms after a find). Late focus steals after that window would go unhandled.

**Change:** Changed blur handler guard from `if (findActive)` to `if (!bar.hidden)` so focus is always reclaimed when the search bar is visible.

**Result:** FAILED - Creates a focus-fight loop. `findInPage` steals focus, blur handler reclaims it, `findInPage` steals again, etc. Search gets stuck on the first character.

### 3. FAILED - `before-input-event` on webview tag to intercept keystrokes

**Rationale:** The webview's `before-input-event` should fire before the webview processes a keystroke, allowing us to `preventDefault()` and redirect the keystroke to the search input.

**Change:** Added `interceptKeys()` method to web searchImpl that listens for `before-input-event` on the webview. For printable characters and Backspace, it calls `e.preventDefault()`, manually updates `input.value` at the cursor position, and dispatches a synthetic `input` event to trigger `scheduleSearch()`.

**Result:** FAILED - `before-input-event` on the `<webview>` DOM element likely doesn't support `preventDefault()` the way `webContents.on('before-input-event')` does. The webview tag dispatches these as informational DOM events; calling `preventDefault()` on them doesn't actually prevent the webview from processing the key.

### 4. FAILED - Injected keydown listener + console-message back-channel

**Rationale:** Use the proven pattern already in the codebase (Cmd+F interception). Inject a keydown listener inside the webview that captures keystrokes when a flag (`window.__panelSearchActive`) is true, sends them back via `console.log('__PANEL_SEARCH_KEY__' + JSON.stringify(...))`, and the renderer's `console-message` handler redirects them to the search input.

**Changes:**
- `web-panel.js`: Extended injected script to capture keystrokes when `__panelSearchActive` is true. Added `__PANEL_SEARCH_KEY__` handler in console-message listener that inserts characters into the search input and dispatches synthetic `input` events.
- `panel-search.js`: Added `activateKeyCapture()` / `deactivateKeyCapture()` methods to web searchImpl (calls `executeJavaScript` to toggle `__panelSearchActive`). Hooked into `showPanelSearch` / `hidePanelSearch`.

**Result:** FAILED - Reason not yet determined. Possible issues:
- The injected keydown listener may not fire when `findInPage` has focus (findInPage may operate at a level below the page's DOM event system)
- The `executeJavaScript` call to set `__panelSearchActive = true` is async and may not complete before the first `findInPage` steals focus
- `console-message` IPC round-trip delay may cause timing issues
- The keydown listener uses capture phase (`true`) but findInPage's internal focus mechanism may not dispatch standard DOM keydown events

## Key Insights

1. `findInPage()` steals focus at the Chromium/browser level, not the page level
2. DOM-level interception (keydown listeners, before-input-event) may not capture keystrokes when findInPage has internal focus
3. The focus fight between `input.focus()` and `findInPage` is a lose-lose: too aggressive causes loops, too passive loses keystrokes
4. The Electron issue #22880 suggested two real solutions:
   - Use `BrowserView` instead of `<webview>` (architectural change)
   - Replace `findInPage` entirely with a DOM-based search using CSS Custom Highlight API + TreeWalker (no focus stealing)

### 5. FAILED - CSS Custom Highlight API + TreeWalker (replace findInPage entirely)

**Rationale:** Since `findInPage` is the source of the focus-stealing problem, replace it entirely with a DOM-based search using the CSS Custom Highlight API (`CSS.highlights`) and `TreeWalker`. Inject search logic into the webview via `executeJavaScript`, communicate results back via `console-message`.

**Changes:**
- Removed all `findInPage` / `stopFindInPage` calls
- Injected a `__panelSearch` object into webview with `find(query, direction)` and `clear()` methods
- Used `TreeWalker(SHOW_TEXT)` to find text ranges, `Highlight` API to highlight them
- Kept `__panelSearchActive` keystroke capture for redirecting keys back to search input

**Result:** FAILED - Multiple issues:
- Next/previous navigation was broken (ranges collected per-call didn't persist correctly across navigations)
- No scroll-to-match worked reliably across different page layouts
- The `__panelSearchActive` keystroke capture in the webview DOM blocked ALL page interaction (clicks, scrolling) while search was open
- CSS Custom Highlight API has inconsistent support across page content (iframes, shadow DOM)
- Overall UX was significantly worse than `findInPage`

### 6. SUCCESS - Main process `before-input-event` keystroke interception

**Rationale:** `findInPage()` is actually great for highlighting and navigation — the only problem is it steals keystrokes during typing. The main process `webContents.on('before-input-event')` properly supports `event.preventDefault()` (unlike the DOM-level event on the webview tag). We can intercept keystrokes BEFORE `findInPage` consumes them and forward them to the search input via IPC.

**Changes:**
- `main.js`: Added `capturingWebContents` Set, `search:startCapture` / `search:stopCapture` IPC handlers, `before-input-event` listener on webview contents that intercepts printable chars, Backspace, Enter, Escape and forwards via `search:keystroke` IPC
- `preload.js`: Exposed `searchStartCapture`, `searchStopCapture`, `onSearchKeystroke` methods
- `renderer/panel-search.js`: Rewrote web search impl to use `findInPage` / `stopFindInPage`, added `startCapture` / `stopCapture` that toggle main-process keystroke interception, global `onSearchKeystroke` listener that redirects keys to the active search input
- `renderer/web-panel.js`: Simplified to only inject Cmd+F interceptor (no `__panelSearchActive` flag), added `found-in-page` event handler for match count, stores `webview._webContentsId` on dom-ready

**Result:** SUCCESS - `findInPage` handles highlighting/navigation, main process intercepts keystrokes before they reach it, IPC forwards them to the search input. Page interaction works normally when search is not capturing.

### 7. BUG - findInPage never updates highlights or match count for new queries

**Symptom:** After take 6, keystrokes correctly build the query in the search input, but visual highlights never update and `found-in-page` events never fire for new search queries. Only Enter-based navigation fires events, but with stale match counts from an earlier query.

**Diagnostic evidence (from `/tmp/worklayer-debug.log`):**

The IPC-based approach (`renderer → ipcMain.handle → webContents.findInPage()`) showed:
- `findInPage("chatb", {findNext:false})` → requestId 1, **no found-in-page event**
- `findInPage("chatbot", {findNext:false})` → requestId 2, **no found-in-page event**
- Enter presses → `findInPage(query, {findNext:true})` → requestIds 3-10, all fire events but with **stale match count (18)** from an earlier query

Switching to direct `webview.findInPage()` DOM calls (bypassing IPC) showed the **exact same pattern** — `findNext:false` never fires events, `findNext:true` fires events but with stale queries.

**Root cause:** `findInPage` with `findNext:false` (new search) is broken for webview guest webContents in Electron 28.3.3. It allocates a requestId and returns it, but never fires a `found-in-page` event and never updates the internal search query. This happens regardless of whether the call is made from:
- The main process via `webContents.findInPage()` (IPC path)
- The renderer via `webview.findInPage()` (direct DOM path)

Both paths hit the same underlying Chromium bug for webview guests.

### 8. SUCCESS - stopFindInPage + findNext:true workaround

**Rationale:** From earlier diagnostic sessions, `findInPage` with `findNext:true` DOES fire `found-in-page` events and CAN accept new query text — but only after `stopFindInPage` clears the previous session. The combination of `stopFindInPage('clearSelection')` followed immediately by `findInPage(query, {findNext:true})` forces Electron to start a fresh search with the new query while using the code path that actually fires events.

**Changes:**
- `renderer/panel-search.js` → `getSearchImpl`: Replaced IPC-based `findInPage`/`stopFindInPage` calls with direct `webview.findInPage()` / `webview.stopFindInPage()` calls. For new queries, calls `stopFindInPage('clearSelection')` first then `findInPage(query, {findNext:true})`. For same-query navigation, just calls `findInPage(query, {findNext:true})`.
- `renderer/panel-search.js` → `doFind`: Removed `setTimeout` backup focus restore hack that was a workaround for IPC timing.
- `startCapture`/`stopCapture` remain IPC-based (these control main-process keystroke interception, unrelated to findInPage).

**Key code pattern:**
```js
findNext(query) {
  const isNew = query !== lastQuery;
  lastQuery = query;
  if (isNew) {
    webview.stopFindInPage('clearSelection');
  }
  webview.findInPage(query, { forward: true, findNext: true });
}
```

**Why it works:**
1. `stopFindInPage('clearSelection')` tears down the current find session entirely
2. `findInPage(query, {findNext:true})` — despite `findNext:true` semantically meaning "continue", when there's no active session (just cleared), Electron treats it as a new search
3. This code path correctly fires `found-in-page` events with accurate match counts, unlike `findNext:false` which silently fails
4. Direct `webview.findInPage()` calls avoid the IPC round-trip, simplifying the architecture

**Result:** SUCCESS - Visual highlights update with each keystroke, match counts decrease as the query gets more specific, Enter/Shift+Enter navigate between matches, and Escape closes search.
