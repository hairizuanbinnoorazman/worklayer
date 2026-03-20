#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CdpClient } from './cdp-client.js';
import { takeSnapshot } from './snapshot.js';
import { resolveUidToCoords, focusUid } from './element.js';

const port = process.env.WORKLAYER_MCP_PORT;
const token = process.env.WORKLAYER_MCP_TOKEN;

if (!port || !token) {
  console.error('WORKLAYER_MCP_PORT and WORKLAYER_MCP_TOKEN must be set');
  process.exit(1);
}

const cdp = new CdpClient(Number(port), token);
let currentWebContentsId = null;

// Simple mutex to serialize tool execution
let mutexPromise = Promise.resolve();
function withMutex(fn) {
  const prev = mutexPromise;
  let resolve;
  mutexPromise = new Promise((r) => { resolve = r; });
  return prev.then(fn).finally(resolve);
}

function requirePanel() {
  if (currentWebContentsId === null) {
    throw new Error('No panel selected. Use select_panel first.');
  }
  return currentWebContentsId;
}

const server = new McpServer({
  name: 'worklayer-browser',
  version: '1.0.0',
});

// --- Navigation tools ---

server.tool('list_panels', 'List all web panels with panelId, url, and title', {}, async () => {
  return withMutex(async () => {
    const panels = await cdp.listPanels();
    const text = panels.length === 0
      ? 'No web panels open.'
      : panels.map(p => `Panel "${p.panelId}" (wcId=${p.webContentsId})\n  URL: ${p.url}\n  Title: ${p.title}`).join('\n\n');
    return { content: [{ type: 'text', text }] };
  });
});

server.tool('select_panel', 'Set target panel for subsequent tools', {
  panelId: z.string().describe('Panel ID from list_panels'),
}, async ({ panelId }) => {
  return withMutex(async () => {
    const panels = await cdp.listPanels();
    const panel = panels.find(p => p.panelId === panelId);
    if (!panel) throw new Error(`Panel "${panelId}" not found. Use list_panels to see available panels.`);
    currentWebContentsId = panel.webContentsId;
    return { content: [{ type: 'text', text: `Selected panel "${panelId}" (wcId=${currentWebContentsId})\nURL: ${panel.url}\nTitle: ${panel.title}` }] };
  });
});

server.tool('navigate', 'Navigate the selected panel to a URL', {
  url: z.string().describe('URL to navigate to'),
}, async ({ url }) => {
  return withMutex(async () => {
    const wcId = requirePanel();
    const resp = await cdp.sendCommand(wcId, 'Page.navigate', { url });
    if (resp.error) throw new Error(resp.error);
    return { content: [{ type: 'text', text: `Navigating to ${url}` }] };
  });
});

server.tool('go_back', 'Navigate back in browser history', {}, async () => {
  return withMutex(async () => {
    const wcId = requirePanel();
    const hist = await cdp.sendCommand(wcId, 'Page.getNavigationHistory', {});
    if (hist.error) throw new Error(hist.error);
    const { currentIndex, entries } = hist.result;
    if (currentIndex <= 0) return { content: [{ type: 'text', text: 'Already at beginning of history.' }] };
    await cdp.sendCommand(wcId, 'Page.navigateToHistoryEntry', { entryId: entries[currentIndex - 1].id });
    return { content: [{ type: 'text', text: `Navigated back to ${entries[currentIndex - 1].url}` }] };
  });
});

server.tool('go_forward', 'Navigate forward in browser history', {}, async () => {
  return withMutex(async () => {
    const wcId = requirePanel();
    const hist = await cdp.sendCommand(wcId, 'Page.getNavigationHistory', {});
    if (hist.error) throw new Error(hist.error);
    const { currentIndex, entries } = hist.result;
    if (currentIndex >= entries.length - 1) return { content: [{ type: 'text', text: 'Already at end of history.' }] };
    await cdp.sendCommand(wcId, 'Page.navigateToHistoryEntry', { entryId: entries[currentIndex + 1].id });
    return { content: [{ type: 'text', text: `Navigated forward to ${entries[currentIndex + 1].url}` }] };
  });
});

server.tool('reload', 'Reload the current page', {
  ignoreCache: z.boolean().optional().describe('Bypass cache on reload'),
}, async ({ ignoreCache }) => {
  return withMutex(async () => {
    const wcId = requirePanel();
    await cdp.sendCommand(wcId, 'Page.reload', { ignoreCache: !!ignoreCache });
    return { content: [{ type: 'text', text: 'Page reloaded.' }] };
  });
});

// --- Snapshot tools ---

server.tool('take_snapshot', 'Get accessibility tree with UIDs for element targeting', {}, async () => {
  return withMutex(async () => {
    const wcId = requirePanel();
    const tree = await takeSnapshot(cdp, wcId);
    return { content: [{ type: 'text', text: tree }] };
  });
});

server.tool('take_screenshot', 'Capture page as image', {
  format: z.enum(['png', 'jpeg']).optional().describe('Image format'),
  quality: z.number().min(0).max(100).optional().describe('JPEG quality (0-100)'),
  fullPage: z.boolean().optional().describe('Capture full scrollable page'),
}, async ({ format, quality, fullPage }) => {
  return withMutex(async () => {
    const wcId = requirePanel();
    const params = { format: format || 'png' };
    if (format === 'jpeg' && quality !== undefined) params.quality = quality;
    if (fullPage) {
      // Get full page dimensions
      const metrics = await cdp.sendCommand(wcId, 'Page.getLayoutMetrics', {});
      if (!metrics.error && metrics.result) {
        const { width, height } = metrics.result.contentSize || metrics.result.cssContentSize || {};
        if (width && height) {
          params.clip = { x: 0, y: 0, width, height, scale: 1 };
        }
      }
    }
    const resp = await cdp.sendCommand(wcId, 'Page.captureScreenshot', params);
    if (resp.error) throw new Error(resp.error);
    return { content: [{ type: 'image', data: resp.result.data, mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png' }] };
  });
});

// --- Input tools ---

server.tool('click', 'Click element by UID from snapshot', {
  uid: z.string().describe('Element UID from take_snapshot'),
  dblClick: z.boolean().optional().describe('Double click'),
}, async ({ uid, dblClick }) => {
  return withMutex(async () => {
    const wcId = requirePanel();
    const { x, y } = await resolveUidToCoords(cdp, wcId, uid);
    // Move -> mousePressed -> mouseReleased
    await cdp.sendCommand(wcId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp.sendCommand(wcId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: dblClick ? 2 : 1,
    });
    await cdp.sendCommand(wcId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: dblClick ? 2 : 1,
    });
    return { content: [{ type: 'text', text: `Clicked element [${uid}] at (${Math.round(x)}, ${Math.round(y)})` }] };
  });
});

server.tool('type_text', 'Type text into the currently focused element', {
  text: z.string().describe('Text to type'),
  submitKey: z.string().optional().describe('Key to press after typing (e.g. "Enter")'),
}, async ({ text, submitKey }) => {
  return withMutex(async () => {
    const wcId = requirePanel();
    await cdp.sendCommand(wcId, 'Input.insertText', { text });
    if (submitKey) {
      await cdp.sendCommand(wcId, 'Input.dispatchKeyEvent', {
        type: 'keyDown', key: submitKey, code: `Key${submitKey}`,
        windowsVirtualKeyCode: submitKey === 'Enter' ? 13 : 0,
      });
      await cdp.sendCommand(wcId, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: submitKey, code: `Key${submitKey}`,
        windowsVirtualKeyCode: submitKey === 'Enter' ? 13 : 0,
      });
    }
    return { content: [{ type: 'text', text: `Typed "${text}"${submitKey ? ` + ${submitKey}` : ''}` }] };
  });
});

server.tool('fill', 'Focus element by UID, clear it, and fill with value', {
  uid: z.string().describe('Element UID from take_snapshot'),
  value: z.string().describe('Value to fill'),
}, async ({ uid, value }) => {
  return withMutex(async () => {
    const wcId = requirePanel();
    await focusUid(cdp, wcId, uid);
    // Select all then delete to clear
    await cdp.sendCommand(wcId, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'a', code: 'KeyA', modifiers: process.platform === 'darwin' ? 4 : 2, // meta or ctrl
    });
    await cdp.sendCommand(wcId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA', modifiers: process.platform === 'darwin' ? 4 : 2,
    });
    await cdp.sendCommand(wcId, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,
    });
    await cdp.sendCommand(wcId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,
    });
    // Insert new text
    await cdp.sendCommand(wcId, 'Input.insertText', { text: value });
    return { content: [{ type: 'text', text: `Filled element [${uid}] with "${value}"` }] };
  });
});

server.tool('press_key', 'Press a key or key combination (e.g. "Enter", "Control+A")', {
  key: z.string().describe('Key or combination like "Enter", "Control+A", "Escape"'),
}, async ({ key }) => {
  return withMutex(async () => {
    const wcId = requirePanel();
    const parts = key.split('+');
    const mainKey = parts.pop();
    let modifiers = 0;
    for (const mod of parts) {
      const m = mod.toLowerCase();
      if (m === 'alt') modifiers |= 1;
      else if (m === 'control' || m === 'ctrl') modifiers |= 2;
      else if (m === 'meta' || m === 'command' || m === 'cmd') modifiers |= 4;
      else if (m === 'shift') modifiers |= 8;
    }
    const vkMap = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 };
    const vk = vkMap[mainKey] || (mainKey.length === 1 ? mainKey.toUpperCase().charCodeAt(0) : 0);
    await cdp.sendCommand(wcId, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: mainKey, code: mainKey.length === 1 ? `Key${mainKey.toUpperCase()}` : mainKey,
      modifiers, windowsVirtualKeyCode: vk,
      text: mainKey.length === 1 && modifiers === 0 ? mainKey : undefined,
    });
    await cdp.sendCommand(wcId, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: mainKey, code: mainKey.length === 1 ? `Key${mainKey.toUpperCase()}` : mainKey,
      modifiers, windowsVirtualKeyCode: vk,
    });
    return { content: [{ type: 'text', text: `Pressed ${key}` }] };
  });
});

server.tool('hover', 'Hover over element by UID', {
  uid: z.string().describe('Element UID from take_snapshot'),
}, async ({ uid }) => {
  return withMutex(async () => {
    const wcId = requirePanel();
    const { x, y } = await resolveUidToCoords(cdp, wcId, uid);
    await cdp.sendCommand(wcId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    return { content: [{ type: 'text', text: `Hovered over element [${uid}] at (${Math.round(x)}, ${Math.round(y)})` }] };
  });
});

// --- Emulation tools ---

server.tool('set_viewport', 'Set viewport dimensions and device emulation', {
  width: z.number().describe('Viewport width in pixels'),
  height: z.number().describe('Viewport height in pixels'),
  deviceScaleFactor: z.number().optional().describe('Device scale factor (default 1)'),
  mobile: z.boolean().optional().describe('Emulate mobile device'),
}, async ({ width, height, deviceScaleFactor, mobile }) => {
  return withMutex(async () => {
    const wcId = requirePanel();
    await cdp.sendCommand(wcId, 'Emulation.setDeviceMetricsOverride', {
      width, height,
      deviceScaleFactor: deviceScaleFactor || 1,
      mobile: !!mobile,
    });
    return { content: [{ type: 'text', text: `Viewport set to ${width}x${height}${mobile ? ' (mobile)' : ''}` }] };
  });
});

server.tool('set_user_agent', 'Override user agent string (empty to reset)', {
  userAgent: z.string().describe('User agent string'),
}, async ({ userAgent }) => {
  return withMutex(async () => {
    const wcId = requirePanel();
    await cdp.sendCommand(wcId, 'Emulation.setUserAgentOverride', { userAgent });
    return { content: [{ type: 'text', text: userAgent ? `User agent set to: ${userAgent}` : 'User agent reset to default.' }] };
  });
});

server.tool('set_geolocation', 'Override geolocation', {
  latitude: z.number().describe('Latitude'),
  longitude: z.number().describe('Longitude'),
  accuracy: z.number().optional().describe('Accuracy in meters'),
}, async ({ latitude, longitude, accuracy }) => {
  return withMutex(async () => {
    const wcId = requirePanel();
    await cdp.sendCommand(wcId, 'Emulation.setGeolocationOverride', {
      latitude, longitude, accuracy: accuracy || 1,
    });
    return { content: [{ type: 'text', text: `Geolocation set to (${latitude}, ${longitude})` }] };
  });
});

const networkPresets = {
  'Offline':  { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  'Slow 3G':  { offline: false, latency: 2000, downloadThroughput: 50000, uploadThroughput: 50000 },
  'Fast 3G':  { offline: false, latency: 563, downloadThroughput: 180000, uploadThroughput: 84375 },
  'Slow 4G':  { offline: false, latency: 170, downloadThroughput: 500000, uploadThroughput: 250000 },
  'Fast 4G':  { offline: false, latency: 28, downloadThroughput: 4000000, uploadThroughput: 3000000 },
};

server.tool('set_network_conditions', 'Emulate network conditions', {
  preset: z.enum(['Offline', 'Slow 3G', 'Fast 3G', 'Slow 4G', 'Fast 4G']).optional().describe('Network preset'),
  offline: z.boolean().optional(),
  latency: z.number().optional().describe('Latency in ms'),
  download: z.number().optional().describe('Download throughput in bytes/s'),
  upload: z.number().optional().describe('Upload throughput in bytes/s'),
}, async ({ preset, offline, latency, download, upload }) => {
  return withMutex(async () => {
    const wcId = requirePanel();
    let params;
    if (preset && networkPresets[preset]) {
      params = networkPresets[preset];
    } else {
      params = {
        offline: offline || false,
        latency: latency || 0,
        downloadThroughput: download || -1,
        uploadThroughput: upload || -1,
      };
    }
    await cdp.sendCommand(wcId, 'Network.emulateNetworkConditions', params);
    return { content: [{ type: 'text', text: preset ? `Network: ${preset}` : `Network conditions updated.` }] };
  });
});

// --- Start server ---

const transport = new StdioServerTransport();
await server.connect(transport);
