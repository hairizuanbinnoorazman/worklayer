# Design Document: Playwright MCP Web Panel Integration

## Problem

When Claude Code uses the Playwright MCP, it opens a separate Chromium browser window outside of Worklayer. The goal is to display the Playwright-controlled browser inside a Worklayer web panel instead.

---

## Approach 1: URL Mirroring

**Complexity: Medium**

### Concept

Intercept Playwright MCP's `browser_navigate` calls via a stdio proxy wrapper. When Playwright navigates to a URL, mirror that URL into a Worklayer web panel. Playwright itself runs headless (no visible window).

### Architecture

```
Claude Code  <-->  MCP Proxy (stdio)  <-->  Playwright MCP (headless)
                        |
                        v
                  HTTP POST /navigate
                        |
                        v
                  Worklayer main process
                        |
                        v (IPC: terminal:browser-open)
                  Renderer creates/navigates web panel
```

### Components

1. **MCP stdio proxy**: A Node.js script that sits between Claude Code and the real Playwright MCP server. It parses Content-Length framed JSON-RPC messages on stdin/stdout, intercepts `browser_navigate` tool calls, extracts the URL, and forwards a request to Worklayer's HTTP API.
2. **`/navigate` HTTP endpoint**: New endpoint in `main.js` that accepts a URL and either creates a new web panel or navigates an existing "playwright" panel to it. Uses the existing `terminal:browser-open` IPC flow.
3. **Project `.mcp.json`**: Override the default Playwright MCP command to point at the proxy wrapper instead of the real MCP binary.

### Key Limitation: Dual Sessions

This is the fundamental problem with this approach. There are **two separate browser sessions**:

| | Worklayer Panel | Playwright Headless |
|---|---|---|
| **Session** | `persist:webpanels` (shared with all panels) | Fresh Chromium profile |
| **Cookies** | Shared across all panels | Isolated |
| **Login state** | Preserved | None |
| **DOM** | User-visible webview | Playwright-controlled |

The panel shows the same URL but in a completely different browser context. If Playwright logs into a site, fills a form, or manipulates the DOM, **none of that is visible in the panel**. The panel just loads the URL fresh in its own session. This makes the approach useful only for showing "where Playwright is navigating" — not "what Playwright is doing."

### Pros

- Relatively simple to implement
- No changes to Playwright MCP itself
- User sees the URL Playwright is working with
- Reuses existing `terminal:browser-open` infrastructure

### Cons

- Two disconnected sessions — no shared state
- Panel shows a different view than what Playwright actually sees
- Interactive content (SPAs, authenticated pages) will look completely different
- Form fills, clicks, and DOM mutations are invisible in the panel

---

## Approach 2: Full CDP Control

**Complexity: High**

### Concept

Replace the Playwright MCP with a custom MCP server that controls a Worklayer webview directly via the Chrome DevTools Protocol. The MCP server connects to the webview's CDP target and issues commands (navigate, click, type, screenshot) against it. What the MCP does IS what the panel shows — same session, same cookies, same page.

### Architecture

```
Claude Code  <-->  Custom MCP Server (CDP client)
                        |
                        v (CDP WebSocket)
                  Worklayer webview (inside panel)
                        |
                  partition: persist:webpanels
                  (shared cookies/login with other panels)
```

### How It Would Work

1. Worklayer creates a dedicated "Playwright" web panel (a `<webview>` tag).
2. The custom MCP server discovers this webview's CDP target via the `/panels` endpoint (which already returns `cdpTargetId` and `cdpWSUrl` per panel).
3. The MCP server connects to the **page-level** CDP WebSocket and issues commands: `Page.navigate`, `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Page.captureScreenshot`, `Runtime.evaluate`, etc.
4. All actions happen directly on the visible webview — the user sees everything in real time.

### Key Challenge: Browser-Level vs Page-Level CDP

Electron's `--remote-debugging-port` exposes a **browser-level** CDP endpoint. Playwright's `--cdp-endpoint` flag connects at this level and then creates its own browser context and pages.

The problem: we don't want Playwright creating new pages — we want it to control an **existing** webview. This means we can't just pass `--cdp-endpoint` to stock Playwright MCP. We need either:

**(a) Custom MCP server using raw CDP**
- Build an MCP server from scratch that implements the Playwright MCP tool interface (`browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot`, etc.)
- Internally uses CDP WebSocket to the specific webview target
- Most control, most work

**(b) Playwright connecting to a specific target**
- Use Playwright's `browserType.connectOverCDP()` to connect to the browser-level endpoint
- Then find and attach to the specific webview target by its URL or target ID
- Requires patching or wrapping Playwright MCP to use an existing page instead of creating a new one

### Pros

- Single session — shared cookies and login state with other panels
- What MCP does is exactly what the user sees
- Real-time visual feedback of all Playwright actions
- Most correct and powerful approach

### Cons

- High implementation complexity
- Requires building or heavily modifying an MCP server
- CDP page-level API is lower-level than Playwright's API (no auto-waiting, no selectors)
- Webview process lifecycle must be carefully managed
- Risk of conflicts if user also interacts with the panel while MCP is controlling it

---

## Approach 3: Headless + Screenshot Stream

**Complexity: Medium**

### Concept

Playwright runs fully headless. After each MCP action, take a screenshot and display it in a Worklayer web panel as a static image. The panel acts as a "viewport" showing exactly what Playwright sees, but as a non-interactive image.

### Architecture

```
Claude Code  <-->  MCP Proxy (stdio)  <-->  Playwright MCP (headless)
                        |
                   After each action:
                   intercept response,
                   call browser_screenshot,
                   send image to panel
                        |
                        v
                  Worklayer panel showing <img> tag
                  (updated after each action)
```

### Components

1. **MCP stdio proxy**: Same framing approach as Approach 1. After each tool call response, automatically issue a `browser_screenshot` call and forward the base64 image to Worklayer.
2. **Screenshot panel**: A simple web panel that listens for image updates (via WebSocket or polling) and renders the latest screenshot.
3. **HTTP endpoint**: `/playwright-screenshot` endpoint to receive and serve the latest screenshot.

### Pros

- Shows exactly what Playwright sees (pixel-perfect)
- No session mismatch — the screenshot IS the Playwright session
- Moderate complexity — reuses existing Playwright MCP without modification
- Works for any page (authenticated, SPA, dynamic content)

### Cons

- Static image — not interactive (user cannot click or scroll in the panel)
- Slight delay — screenshot taken after action completes
- Additional overhead — extra `browser_screenshot` call after every action
- Image quality / bandwidth considerations for frequent updates

---

## Comparison Summary

| Criteria | URL Mirroring | Full CDP Control | Screenshot Stream |
|---|---|---|---|
| Complexity | Medium | High | Medium |
| Session parity | No (dual sessions) | Yes (same webview) | N/A (image only) |
| Visual accuracy | Low (different session) | Perfect (same page) | Perfect (screenshot) |
| Interactivity | Full (but wrong session) | Full (and correct) | None (static image) |
| Implementation effort | ~2-3 files | Custom MCP server | ~3-4 files |
| Reuses stock Playwright MCP | Yes (via proxy) | No | Yes (via proxy) |
| Real-time feedback | URL changes only | All actions visible | Post-action snapshots |

## Recommendation

**Approach 2 (Full CDP Control)** is the most correct solution but requires significant effort. It is the only approach where the panel and MCP share the same browser session and page.

**Approach 1 (URL Mirroring)** is the easiest to build but provides limited value — the panel shows the right URL but in a disconnected session, making it misleading for authenticated or stateful pages.

**Approach 3 (Screenshot Stream)** offers a practical middle ground — accurate visual representation of what Playwright sees, with moderate complexity, at the cost of interactivity.

A phased approach could work: start with Approach 3 for immediate visual feedback, then invest in Approach 2 for full integration when the use case demands it.
