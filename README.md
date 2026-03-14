# Worklayer

An Electron app for managing multiple web and terminal panels, grouped into workspaces.

Inspired by [Niri](https://wiki.archlinux.org/title/Niri)'s scrollable tiling window management concept.

## Features

- **Workspaces** — organize panels into named groups by unit of work
- **Web panels** — embedded browser with back/forward/refresh navigation
- **Terminal panels** — persistent shell sessions powered by xterm.js and node-pty
- **Drag-to-resize** — adjust panel widths with drag handles
- **Auto-saved state** — workspace layout and panel state persist across restarts

## Project Structure

```
worklayer/
├── main.js               Electron main process
├── preload.js            IPC bridge (contextBridge)
├── package.json
└── renderer/
    ├── index.html        App shell
    ├── styles.css        Dark theme styles
    ├── app.js            State management and core operations
    ├── sidebar.js        Workspace sidebar component
    ├── panel-strip.js    Horizontal panel area component
    ├── web-panel.js      Web panel (webview) component
    └── term-panel.js     Terminal panel (xterm.js) component
```

## Dependencies

| Package | Purpose |
|---|---|
| `electron` ^28 | App runtime |
| `node-pty` ^1.0 | Native pseudoterminal (requires rebuild for Electron) |
| `@xterm/xterm` ^6 | Terminal UI in the renderer |
| `@xterm/addon-fit` ^0.11 | Resizes xterm to fill its container |
| `@electron/rebuild` ^4 | Rebuilds native modules for the installed Electron version |

## Setup

```bash
npm install --ignore-scripts
node node_modules/electron/install.js        # download Electron binary
npm run rebuild-pty                          # rebuild node-pty for Electron
npm start
```
