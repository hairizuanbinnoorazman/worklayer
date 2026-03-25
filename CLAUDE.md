# Worklayer Project Instructions

## Critical: WebView Initial Load in web-panel.js

**DO NOT change the initial webview load in `renderer/panels/web-panel.js` from `webview.src` to `webview.loadURL()`.**

This has been broken and fixed 4 times (commits `69c859d` → `1e4f8b0` → `ba0155a` → current fix). The root cause:

- `renderWebPanel()` creates the webview and appends it to a `content` div, but that div's parent chain (`panel el` → `wrapper`) is not appended to the live DOM until later in `panel-strip.js` (`strip.appendChild(wrapper)`).
- `webview.loadURL()` requires the webview to be attached to the live DOM **and** `dom-ready` to have fired. Calling it before that throws: `"The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called."`
- `webview.src = url` works before DOM attachment — Electron queues the load until the webview is ready.

### Rules

1. **Initial load** (in `renderWebPanel`): MUST use `webview.src = url`. Never use `loadURL()` or `loadURLWithRetry()` here.
2. **User-initiated navigation** (in `navigate()` and crash retry): `loadURL()` / `loadURLWithRetry()` is fine — by that point the webview is attached and `dom-ready` has fired.
3. **Error handling for initial load**: Rely on the `did-fail-load` event listener, which already catches failures and calls `showErrorPage()`.
