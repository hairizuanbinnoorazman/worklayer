# MCP Server + CDP Integration - Implementation Learnings

## Overview

We built a custom MCP server that lets Claude Code (running in a terminal panel) control web panels via Chrome DevTools Protocol. This replaces the need for Playwright/Puppeteer by using Electron's built-in `webContents.debugger` API.

## Architecture

```
Claude Code (terminal panel)
    |  stdio (JSON-RPC)
    v
MCP Server (mcp-server/index.js)
    |  HTTP requests to localhost
    v
Worklayer Main Process (main.js HTTP endpoints)
    |  webContents.debugger.sendCommand()
    v
Webview CDP (Chrome DevTools Protocol)
```

## Key Files

| File | Role |
|------|------|
| `main.js` | HTTP endpoints (`/cdp/panels`, `/cdp/command`, `/cdp/detach`), webview registry, debugger lifecycle |
| `preload.js` | IPC bridge for `cdp:register-webview`, `cdp:unregister-webview`, `cdp:update-webview` |
| `renderer/web-panel.js` | Registers webviews on `dom-ready`, sends URL/title updates |
| `mcp-server/index.js` | MCP server entry point, 17 tools registered via `@modelcontextprotocol/sdk` |
| `mcp-server/cdp-client.js` | HTTP client to Worklayer's main process |
| `mcp-server/snapshot.js` | Accessibility tree formatter with UID assignment |
| `mcp-server/element.js` | UID-to-coordinates resolution for click/hover/fill |
| `.mcp.json` | Claude Code auto-discovery configuration |

## Design Decisions

### Why HTTP instead of IPC/WebSocket for MCP-to-main communication

The MCP server runs as a standalone Node.js process (spawned by Claude Code), not inside Electron. It has no access to Electron's IPC. HTTP to localhost was chosen because:
- Worklayer already had a local HTTP server (`browserInterceptServer`) for the `$BROWSER` intercept
- Adding routes to the existing server means zero new dependencies or ports
- Token-based auth was already in place (`browserInterceptToken`)

### Why `webContents.debugger` instead of `--remote-debugging-port`

Electron's `webContents.debugger` API gives page-level CDP access to a specific webview without exposing a browser-wide debugging port. Key advantages:
- No need to discover/filter CDP targets — we already have the `webContentsId`
- Auto-attach on first command with `wc.debugger.attach('1.3')`
- Domain enablement (`Page.enable`, `DOM.enable`, etc.) is done once per attach
- Cleanup is straightforward — detach when webview is destroyed

### Why accessibility tree snapshots instead of DOM selectors

Following the Playwright MCP pattern: `Accessibility.getFullAXTree` returns a structured tree that maps well to how LLMs reason about page structure. Each node gets a sequential UID that maps to a `backendDOMNodeId` for click/fill resolution. This avoids the fragility of CSS/XPath selectors.

### Mutex for tool serialization

CDP commands can interfere if run concurrently (e.g., a snapshot mid-navigation). A simple promise-chain mutex ensures only one tool runs at a time. The implementation is minimal:

```js
let mutexPromise = Promise.resolve();
function withMutex(fn) {
  const prev = mutexPromise;
  let resolve;
  mutexPromise = new Promise((r) => { resolve = r; });
  return prev.then(fn).finally(resolve);
}
```

## Electron CDP Specifics

### Debugger attach/detach lifecycle

- `wc.debugger.attach('1.3')` — protocol version must be a string `'1.3'`
- Must enable CDP domains before using them: `Page.enable`, `DOM.enable`, `Accessibility.enable`, `Network.enable`
- The debugger stays attached until explicitly detached or the webContents is destroyed
- Track attached state in a Map to avoid double-attach errors

### webContentsId discovery

Webviews don't expose their `webContentsId` until `dom-ready`. The renderer calls `webview.getWebContentsId()` during `dom-ready` and sends it to main via IPC. Main stores it in `webviewPanelMap` (Map of `webContentsId -> { panelId, url, title }`).

### Cleanup on webview destruction

Both `attachedDebuggers` and `webviewPanelMap` entries must be cleaned up when a webview is destroyed. This is done in two places:
1. `contents.once('destroyed', ...)` in the `web-contents-created` handler (main process side)
2. `cdp:unregister-webview` IPC handler (renderer-initiated cleanup)

## CDP Commands Reference

| Operation | CDP Method | Notes |
|-----------|-----------|-------|
| Navigate | `Page.navigate({ url })` | Returns frameId, loaderId |
| Back/Forward | `Page.getNavigationHistory` + `Page.navigateToHistoryEntry` | Need entry `id`, not index |
| Screenshot | `Page.captureScreenshot({ format, quality })` | Returns base64 `data` |
| Full-page screenshot | `Page.getLayoutMetrics` then `captureScreenshot` with `clip` | Use `contentSize` for dimensions |
| Accessibility snapshot | `Accessibility.getFullAXTree({})` | Returns flat array of nodes with `childIds` |
| Resolve node | `DOM.resolveNode({ backendNodeId })` | Returns `objectId` for further queries |
| Box model | `DOM.getBoxModel({ objectId })` | Content quad: 4 points (x1,y1,...,x4,y4) |
| Focus | `DOM.focus({ backendNodeId })` | Works with backendNodeId directly |
| Click | `Input.dispatchMouseEvent` | Sequence: `mouseMoved` -> `mousePressed` -> `mouseReleased` |
| Type text | `Input.insertText({ text })` | Inserts at cursor, no key events |
| Key press | `Input.dispatchKeyEvent` | Need both `keyDown` and `keyUp`; modifiers are a bitmask |
| Clear input | Select-all + Backspace | Cmd+A (modifier 4 on mac, 2 on others) then Backspace |
| Viewport | `Emulation.setDeviceMetricsOverride` | `mobile` param triggers mobile UA behavior |
| Network throttle | `Network.emulateNetworkConditions` | Throughput in bytes/sec |

### CDP modifier bitmask

```
Alt   = 1
Ctrl  = 2
Meta  = 4  (Cmd on macOS)
Shift = 8
```

## MCP SDK Patterns

### Tool registration with Zod schemas

The `@modelcontextprotocol/sdk` uses Zod for parameter validation. Tools are registered with:

```js
server.tool('tool_name', 'description', {
  param: z.string().describe('...'),
  optional: z.boolean().optional(),
}, async (params) => {
  return { content: [{ type: 'text', text: '...' }] };
});
```

### Image responses

Screenshots are returned as MCP image content:

```js
{ content: [{ type: 'image', data: base64String, mimeType: 'image/png' }] }
```

### Environment variable passing

The MCP server gets its connection details via env vars set when terminals are spawned:
- `WORKLAYER_MCP_PORT` — port of the local HTTP server
- `WORKLAYER_MCP_TOKEN` — auth token

These are set in `main.js` during `terminal:create` and inherited by any process spawned in the terminal (including `node mcp-server/index.js`).

### `.mcp.json` auto-discovery

Claude Code reads `.mcp.json` from the project root to auto-discover MCP servers:

```json
{
  "mcpServers": {
    "worklayer-browser": {
      "command": "node",
      "args": ["mcp-server/index.js"]
    }
  }
}
```

The `env` field in `.mcp.json` is optional — since `WORKLAYER_MCP_PORT` and `WORKLAYER_MCP_TOKEN` are already in the terminal's environment, they're automatically available.

## Accessibility Tree Snapshot Format

The snapshot assigns sequential UIDs to each AX node and outputs a tree:

```
[1] WebArea "Page Title"
  [2] navigation "Main Nav"
    [3] link "Home"
  [4] textbox "Search" value=""
  [5] button "Submit"
```

Properties like `checked`, `disabled`, `expanded`, `selected`, `focused` are appended when present. Ignored/none-role nodes are skipped but their children are still walked.

The UID map (`uid -> backendDOMNodeId`) is held in module state and reset on each new snapshot. This means a snapshot must be taken before any click/fill/hover operation.

## Gotchas

1. **`webContents.fromId()` can return null** — always check before using; the webview may have been destroyed between panel listing and command execution.

2. **Async HTTP handler** — `http.createServer` accepts an async callback fine, but errors in async handlers won't be caught by the server automatically. The `try/catch` in the handler is essential.

3. **`readJsonBody` must be called before any `res.writeHead`** — if the body read fails (malformed JSON), the error handler catches it.

4. **Navigation history uses entry `id`, not index** — `Page.navigateToHistoryEntry` takes `entryId` from the history entry object, not the array index.

5. **Box model quad format** — `DOM.getBoxModel` returns content/padding/border/margin quads as flat arrays `[x1,y1, x2,y2, x3,y3, x4,y4]`, not as point objects. Center is the average of all four corners.

6. **`Input.insertText` vs `Input.dispatchKeyEvent`** — `insertText` is simpler for bulk text but doesn't fire keydown/keyup events. For form fields that need JS event handlers to trigger, individual key events may be needed. The `fill` tool uses `insertText` after clearing via key events, which covers most cases.
