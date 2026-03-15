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

## Not Yet Attempted

- **CSS Custom Highlight API + TreeWalker**: Replace `findInPage` with injected DOM-based search inside the webview. Uses `Range` objects + `CSS.highlights` to highlight matches without stealing focus. Requires injecting search logic into the webview via `executeJavaScript` and communicating results back. Chrome 105+ / Electron 28 should support it.
- **BrowserView approach**: Render search UI in a separate BrowserView overlay. Major architectural change.
- **Main process `webContents.on('before-input-event')`**: Unlike the webview tag's DOM event, the main process version properly supports `preventDefault()`. Would require IPC between renderer and main process.
