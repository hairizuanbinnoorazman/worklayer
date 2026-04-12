# Worklayer

An Electron app for managing multiple web and terminal panels, grouped into workspaces.

Inspired by [Niri](https://wiki.archlinux.org/title/Niri)'s scrollable tiling window management concept.

## Features

- **Workspaces** — organize panels into named groups by unit of work
- **Web panels** — embedded browser with back/forward/refresh navigation
- **Terminal panels** — persistent shell sessions powered by xterm.js and node-pty
- **File panels** — file browser + Monaco code editor with syntax highlighting
- **Templates** — save and reuse workspace configurations
- **Profiles** — segment workspaces into isolated profiles, each with its own templates and URL history; profile selector in sidebar with add/rename/delete
- **Panel reordering** — drag panels to reorder within a workspace
- **Drag-to-resize** — adjust panel widths with drag handles
- **Improved resize UX** — wider drag handles, rAF-throttled updates, double-click to expand 2x, auto-scroll when dragging near edges
- **Per-panel settings** — gear icon on each panel opens type-specific settings (working directory, startup command, URL, root directory)
- **Open links as panels** — target="_blank", window.open(), and Cmd+Click in web panels open as new panels instead of external browser
- **Terminal browser interception** — OAuth flows and CLI-opened URLs (e.g. `gh auth login`) open as adjacent web panels instead of system browser
- **Panel search** — Ctrl+F / Cmd+F find-in-page for web panels
- **Terminal search** — search within terminal output via xterm addon-search
- **LSP integration** — Language Server Protocol support in the file editor (completions, diagnostics, hover) with per-workspace server configuration
- **HTTP auth modal** — native dialog for HTTP Basic/Proxy authentication in web panels
- **URL frequency tracking** — URL bar suggestions sorted by visit count with weekly decay
- **Resizable sidebar** — drag the sidebar edge to resize (150-500px), persists across sessions
- **Status bar** — real-time panel counts and limits display
- **DOM caching** — smart caching prevents terminal re-initialization when switching workspaces
- **Auto-saved state** — workspace layout and panel state persist across restarts
- **MCP server** — built-in Model Context Protocol server for programmatic browser control via Chrome DevTools Protocol (click, type, screenshot, navigate, etc.)

## Project Structure

```
worklayer/
├── main.js                        Electron main process
├── preload.js                     IPC bridge (contextBridge)
├── lsp-manager.js                 LSP server lifecycle management
├── package.json
├── renderer/
│   ├── index.html                 App shell
│   ├── styles.css                 Dark theme styles
│   ├── core/
│   │   ├── app.js                 State management and core operations
│   │   └── group-cache.js         DOM caching mechanism
│   ├── layout/
│   │   ├── sidebar.js             Workspace sidebar component
│   │   └── group-drag.js          Workspace drag-to-reorder
│   ├── panels/
│   │   ├── panel-strip.js         Horizontal panel area component
│   │   ├── web-panel.js           Web panel (webview) component
│   │   ├── term-panel.js          Terminal panel (xterm.js) component
│   │   ├── file-panel.js          File browser + Monaco editor component
│   │   ├── panel-search.js        Web panel find-in-page search
│   │   ├── panel-drag.js          Drag-to-resize and reorder handles
│   │   ├── status-bar.js          Panel count status indicator
│   │   └── browser-intercept.js   Terminal browser open interception
│   ├── modals/
│   │   ├── workspace-modal.js     Modal for creating/configuring workspaces
│   │   ├── panel-settings-modal.js  Per-panel settings modal
│   │   ├── panel-limit-modal.js   Panel limit configuration modal
│   │   ├── profile-settings-modal.js  Profile settings modal
│   │   ├── lsp-settings-modal.js  Per-workspace LSP config modal
│   │   └── auth-modal.js          HTTP auth dialog
│   └── lsp/
│       └── lsp-bridge.js          LSP client bridge for Monaco
├── mcp-server/
│   ├── package.json               MCP server dependencies
│   ├── index.js                   MCP server entry point
│   ├── cdp-client.js              Chrome DevTools Protocol client
│   ├── element.js                 Element interaction helpers
│   └── snapshot.js                Page snapshot utilities
└── docs/                          Implementation notes and learnings
```

## Dependencies

| Package | Purpose |
|---|---|
| `electron` ^28 | App runtime |
| `node-pty` ^1.0 | Native pseudoterminal (requires rebuild for Electron) |
| `@xterm/xterm` ^6 | Terminal UI in the renderer |
| `@xterm/addon-fit` ^0.11 | Resizes xterm to fill its container |
| `@xterm/addon-search` ^0.16 | Search within terminal output |
| `@xterm/addon-web-links` ^0.12 | Clickable links in terminal output |
| `monaco-editor` ^0.55 | Code editor and syntax highlighting |
| `@electron/rebuild` ^4 | Rebuilds native modules for the installed Electron version |
| `electron-builder` ^26 | Packages the app as a macOS DMG |
| `@modelcontextprotocol/sdk` ^1.27 | MCP server (in mcp-server/) |

## Setup

```bash
npm install --ignore-scripts
node node_modules/electron/install.js        # download Electron binary
npm run rebuild-pty                          # rebuild node-pty for Electron
npm start
```

### Building the macOS App

```bash
npm run build           # build a signed DMG (arm64)
npm run build:dir       # build to dist/ directory without packaging
```

The DMG is written to `dist/` and targets Apple Silicon (arm64).

### MCP Server

The built-in MCP server allows external tools to control web panels programmatically via CDP. To start the server alongside the app, set the following environment variables:

| Variable | Description |
|---|---|
| `WORKLAYER_MCP_PORT` | Port the MCP server listens on |
| `WORKLAYER_MCP_TOKEN` | Bearer token for authenticating requests |
