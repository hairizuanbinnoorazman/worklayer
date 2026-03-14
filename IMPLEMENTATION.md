# PPP - Panel Workspace Viewer

An Electron application for managing multiple web and terminal panels, grouped into workspaces by unit of work.

## Architecture

```
ppp/
├── main.js               Electron main process
├── preload.js            contextBridge IPC bridge
├── package.json
└── renderer/
    ├── index.html        App shell, loads scripts in order
    ├── styles.css        Dark theme styles
    ├── app.js            State management and core operations
    ├── sidebar.js        Workspace sidebar component
    ├── panel-strip.js    Horizontal panel area component
    ├── web-panel.js      Web panel (webview) component
    └── term-panel.js     Terminal panel (xterm.js) component
```

## Main Process (`main.js`)

Handles:
- Creating the BrowserWindow with `webviewTag: true` and `contextIsolation: true`
- State persistence: reads/writes `ppp-state.json` in the OS userData directory
- Terminal lifecycle via `node-pty`: spawn, write, resize, kill
- IPC channels:
  - `state:load` / `state:save`
  - `terminal:create` / `terminal:write` / `terminal:resize` / `terminal:kill`
  - `terminal:data:{id}` (push event, pty → renderer)
  - `terminal:exit:{id}` (push event)

## Preload (`preload.js`)

Exposes `window.electronAPI` via `contextBridge`:
- `loadState()` / `saveState(state)`
- `createTerminal(opts)` / `writeTerminal(id, data)` / `resizeTerminal(id, cols, rows)` / `killTerminal(id)`
- `onTerminalData(id, callback)` — returns an unsubscribe function
- `onTerminalExit(id, callback)`

## State Shape

```js
{
  activeGroupId: "id-...",
  groups: [
    {
      id: "id-...",
      label: "Work 1",
      panels: [
        { id: "id-...", type: "web",      url: "https://...", width: 750 },
        { id: "id-...", type: "terminal",                     width: 620 }
      ]
    }
  ]
}
```

State is auto-saved (debounced 400ms) on every mutation. Terminal instances are ephemeral and not included in saved state.

## Renderer (`app.js`)

Global state object and all mutating operations:

| Function | Description |
|---|---|
| `addGroup()` | Create a new workspace and switch to it |
| `deleteGroup(id)` | Delete workspace, kill its terminals, switch to another |
| `renameGroup(id, label)` | Rename a workspace |
| `selectGroup(id)` | Switch active workspace |
| `addPanel(type)` | Add a web or terminal panel to the active workspace |
| `removePanel(id)` | Remove a panel, killing its terminal if applicable |
| `updatePanelUrl(id, url)` | Persist the current URL of a web panel |
| `updatePanelWidth(id, width)` | Persist panel width after resize |

`activeTerminals` is a `Map<panelId, { terminal, fitAddon, cleanup, termId }>` that persists terminal instances across workspace switches.

## Sidebar (`sidebar.js`)

- Lists all workspaces with a panel count badge
- Click to switch active workspace
- Double-click label to rename inline (input replaces the label, confirmed on Enter/blur)
- `×` button to delete (prompts confirmation if panels exist)
- "+ New Workspace" button at bottom

## Panel Strip (`panel-strip.js`)

- Horizontally scrollable flex container
- Renders panels for the active workspace only
- Each panel is followed by a drag handle (`resize-handle`)
- Drag handle: `mousedown` captures start position, `mousemove` updates panel `style.width` and calls `fitAddon.fit()` for terminals, `mouseup` persists the new width
- "+ Web" / "+ Terminal" add buttons on the right
- Shows an empty state with action buttons when the workspace has no panels

## Web Panel (`web-panel.js`)

- URL bar with back, forward, refresh buttons and a text input
- `<webview>` tag fills the remaining panel area
- Navigation: input accepts bare domains (auto-prefixes `https://`) and plain text (falls back to Google search)
- Listens to `did-navigate` and `did-navigate-in-page` to keep the URL bar in sync
- Updates the panel header label with the page title via `page-title-updated`

## Terminal Panel (`term-panel.js`)

- On first render: creates an `xterm.Terminal` + `FitAddon`, opens it in the container, spawns a pty via IPC, wires up bidirectional data flow and resize sync
- On re-render (workspace switch back): calls `terminal.open(newContainer)` to remount the existing instance — the shell process keeps running in the background
- Terminal theme: dark (`#0d0d0d` background), 5000-line scrollback
- Shell: reads `$SHELL` env var, falls back to `/bin/bash`

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
