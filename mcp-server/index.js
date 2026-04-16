#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CdpClient } from './cdp-client.js';
import { takeSnapshot } from './snapshot.js';
import { resolveUidToCoords, focusUid, resolveUidToObjectId } from './element.js';

const port = process.env.WORKLAYER_MCP_PORT;
const token = process.env.WORKLAYER_MCP_TOKEN;

if (!port || !token) {
  console.error('WORKLAYER_MCP_PORT and WORKLAYER_MCP_TOKEN must be set');
  process.exit(1);
}

const cdp = new CdpClient(Number(port), token);
let currentWebContentsId = null;

const termId = process.env.WORKLAYER_TERM_ID || null;
const profileId = process.env.WORKLAYER_PROFILE_ID || null;
const groupId = process.env.WORKLAYER_GROUP_ID || null;

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

server.tool('open_panel', 'Create a new web panel with the given URL', {
  url: z.string().describe('URL to open in the new panel'),
}, async ({ url }) => {
  return withMutex(async () => {
    const result = await cdp.openPanel(url, termId, profileId, groupId);
    if (result.error) throw new Error(result.error);
    // Poll for webview to register (dom-ready is async)
    let panel = null;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 500));
      const panels = await cdp.listPanels();
      panel = panels.find(p => p.panelId === result.panelId);
      if (panel) break;
    }
    if (panel) {
      currentWebContentsId = panel.webContentsId;
      return { content: [{ type: 'text', text: `Created and selected panel "${result.panelId}"\nURL: ${url}` }] };
    }
    return { content: [{ type: 'text', text: `Created panel "${result.panelId}" — webview still loading. Use list_panels + select_panel to target it.` }] };
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

server.tool('save_screenshot', 'Capture page screenshot and save to file', {
  filePath: z.string().describe('Absolute file path to save the screenshot'),
  format: z.enum(['png', 'jpeg']).optional().describe('Image format'),
  quality: z.number().min(0).max(100).optional().describe('JPEG quality (0-100)'),
  fullPage: z.boolean().optional().describe('Capture full scrollable page'),
}, async ({ filePath, format, quality, fullPage }) => {
  return withMutex(async () => {
    const wcId = requirePanel();
    const params = { format: format || 'png' };
    if (format === 'jpeg' && quality !== undefined) params.quality = quality;
    if (fullPage) {
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
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(resp.result.data, 'base64'));
    return { content: [{ type: 'text', text: `Screenshot saved to ${filePath}` }] };
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
    // Use Runtime.evaluate to insert text via JS (CDP Input.insertText doesn't work in Electron webview debugger)
    await cdp.sendCommand(wcId, 'Runtime.evaluate', {
      expression: `(() => {
        const text = ${JSON.stringify(text)};
        const el = document.activeElement;
        if (!el) return 'no-active-element';
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          const nativeSetter = Object.getOwnPropertyDescriptor(
            el.tagName === 'TEXTAREA'
              ? window.HTMLTextAreaElement.prototype
              : window.HTMLInputElement.prototype,
            'value'
          ).set;
          const start = el.selectionStart || 0;
          const end = el.selectionEnd || 0;
          const current = el.value;
          const newValue = current.substring(0, start) + text + current.substring(end);
          nativeSetter.call(el, newValue);
          el.selectionStart = el.selectionEnd = start + text.length;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return 'typed-native';
        }
        if (el.isContentEditable) {
          document.execCommand('insertText', false, text);
          return 'typed-contenteditable';
        }
        return 'unsupported-element';
      })()`,
      returnByValue: true,
    });

    if (submitKey) {
      await cdp.sendCommand(wcId, 'Runtime.evaluate', {
        expression: `(() => {
          const key = ${JSON.stringify(submitKey)};
          const vkMap = { Enter: 13, Tab: 9, Escape: 27 };
          const el = document.activeElement || document.body;
          const opts = { key, code: key, keyCode: vkMap[key] || 0, which: vkMap[key] || 0, bubbles: true, cancelable: true };
          const downEvent = new KeyboardEvent('keydown', opts);
          const prevented = !el.dispatchEvent(downEvent);
          if (!prevented && key === 'Enter') {
            const form = el.closest('form');
            if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); }
          }
          el.dispatchEvent(new KeyboardEvent('keyup', opts));
          return 'key-dispatched';
        })()`,
        returnByValue: true,
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
    const { objectId } = await resolveUidToObjectId(cdp, wcId, uid);
    // Use Runtime.callFunctionOn to clear and fill (CDP Input commands don't work in Electron webview debugger)
    const fillResp = await cdp.sendCommand(wcId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: `function(newValue) {
        if (this.tagName === 'SELECT') {
          this.value = newValue;
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return 'filled-select';
        }
        if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA') {
          const nativeSetter = Object.getOwnPropertyDescriptor(
            this.tagName === 'TEXTAREA'
              ? window.HTMLTextAreaElement.prototype
              : window.HTMLInputElement.prototype,
            'value'
          ).set;
          nativeSetter.call(this, '');
          this.dispatchEvent(new Event('input', { bubbles: true }));
          nativeSetter.call(this, newValue);
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return 'filled-native';
        }
        if (this.isContentEditable) {
          this.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
          document.execCommand('insertText', false, newValue);
          return 'filled-contenteditable';
        }
        return 'unknown-element-type';
      }`,
      arguments: [{ value: value }],
      returnByValue: true,
    });
    if (fillResp.error) throw new Error(fillResp.error);
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

// --- Debugging tools ---

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

server.tool('network_requests', 'List captured network requests for debugging (XHR, fetch, document loads, failures, etc.)', {
  filter: z.string().optional().describe('Regex to filter URLs (e.g. "/api/" or "\\.json$")'),
  static: z.boolean().optional().describe('Include successful static resources like images, fonts, CSS, JS (default: false)'),
  requestHeaders: z.boolean().optional().describe('Include request headers in output'),
  requestBody: z.boolean().optional().describe('Include request body/postData in output'),
}, async ({ filter, static: includeStatic, requestHeaders: showReqHeaders, requestBody: showReqBody }) => {
  return withMutex(async () => {
    const wcId = requirePanel();
    const resp = await cdp.getNetworkRequests(wcId);
    let requests = resp.requests || [];

    // Filter out successful static resources by default
    const staticTypes = new Set(['Image', 'Font', 'Stylesheet', 'Script']);
    if (!includeStatic) {
      requests = requests.filter(r => {
        if (staticTypes.has(r.resourceType) && r.status && r.status >= 200 && r.status < 400) return false;
        return true;
      });
    }

    // Apply URL regex filter
    if (filter) {
      const regex = new RegExp(filter);
      requests = requests.filter(r => regex.test(r.url));
    }

    if (requests.length === 0) {
      return { content: [{ type: 'text', text: 'No network requests captured.' }] };
    }

    const lines = requests.map(r => {
      const parts = [];
      if (r.failed) parts.push('FAILED');
      else if (r.status) parts.push(String(r.status));
      else parts.push('PENDING');
      parts.push(`${r.method} ${r.url}`);
      parts.push(`[${r.resourceType}]`);
      if (r.encodedDataLength != null) parts.push(formatBytes(r.encodedDataLength));
      if (r.failed && r.errorText) parts.push(`Error: ${r.errorText}${r.canceled ? ' (canceled)' : ''}`);

      let line = parts.join('  ');
      if (showReqHeaders && r.requestHeaders) {
        line += '\n  Request Headers: ' + JSON.stringify(r.requestHeaders);
      }
      if (showReqBody && r.postData) {
        const body = r.postData.length > 500 ? r.postData.slice(0, 500) + '...' : r.postData;
        line += '\n  Request Body: ' + body;
      }
      return line;
    });

    return { content: [{ type: 'text', text: `${requests.length} request(s) captured:\n\n${lines.join('\n')}` }] };
  });
});

server.tool('network_clear', 'Clear the captured network requests buffer', {}, async () => {
  return withMutex(async () => {
    const wcId = requirePanel();
    await cdp.clearNetworkRequests(wcId);
    return { content: [{ type: 'text', text: 'Network request buffer cleared.' }] };
  });
});

const consoleLevels = ['error', 'warning', 'info', 'debug'];

server.tool('console_messages', 'Get console output from the page (log, warn, error, etc.)', {
  level: z.enum(['error', 'warning', 'info', 'debug']).optional().describe('Minimum level to include (default: info). Each level includes more severe levels.'),
  clear: z.boolean().optional().describe('Clear the buffer after reading'),
}, async ({ level, clear }) => {
  return withMutex(async () => {
    const wcId = requirePanel();
    const resp = await cdp.getConsoleMessages(wcId);
    let messages = resp.messages || [];

    // Map console API types to severity levels
    const typeToLevel = {
      error: 'error',
      warning: 'warning', warn: 'warning',
      info: 'info', log: 'info',
      debug: 'debug', trace: 'debug', dir: 'debug', table: 'debug',
    };

    const minLevel = level || 'info';
    const minIdx = consoleLevels.indexOf(minLevel);
    messages = messages.filter(m => {
      const msgLevel = typeToLevel[m.level] || 'info';
      return consoleLevels.indexOf(msgLevel) <= minIdx;
    });

    if (clear) await cdp.clearConsoleMessages(wcId);

    if (messages.length === 0) {
      return { content: [{ type: 'text', text: 'No console messages captured.' }] };
    }

    const lines = messages.map(m => {
      const levelTag = (typeToLevel[m.level] || m.level).toUpperCase();
      let line = `[${levelTag}] ${m.text}`;
      if (m.url) line += `  (${m.url}${m.lineNumber != null ? ':' + m.lineNumber : ''})`;
      return line;
    });

    return { content: [{ type: 'text', text: `${messages.length} message(s):\n\n${lines.join('\n')}` }] };
  });
});

server.tool('console_clear', 'Clear the captured console messages buffer', {}, async () => {
  return withMutex(async () => {
    const wcId = requirePanel();
    await cdp.clearConsoleMessages(wcId);
    return { content: [{ type: 'text', text: 'Console message buffer cleared.' }] };
  });
});

server.tool('evaluate', 'Evaluate a JavaScript expression on the page and return the result', {
  expression: z.string().describe('JavaScript expression to evaluate (e.g. "document.title", "JSON.stringify(performance.timing)")'),
}, async ({ expression }) => {
  return withMutex(async () => {
    const wcId = requirePanel();
    const resp = await cdp.sendCommand(wcId, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (resp.error) throw new Error(resp.error);
    const { result, exceptionDetails } = resp.result;
    if (exceptionDetails) {
      const errMsg = exceptionDetails.exception?.description || exceptionDetails.text || 'Evaluation error';
      return { content: [{ type: 'text', text: `Error: ${errMsg}` }] };
    }
    const value = result.value !== undefined ? JSON.stringify(result.value, null, 2) : result.description || result.type;
    return { content: [{ type: 'text', text: value }] };
  });
});

server.tool('route', 'Mock/intercept network requests matching a URL pattern', {
  pattern: z.string().describe('URL pattern to match (e.g. "**/api/users", "**/*.json")'),
  status: z.number().optional().describe('HTTP status code to return (default: 200)'),
  body: z.string().optional().describe('Response body (text or JSON string)'),
  contentType: z.string().optional().describe('Content-Type header (e.g. "application/json")'),
  headers: z.array(z.string()).optional().describe('Headers to add in "Name: Value" format'),
  removeHeaders: z.string().optional().describe('Comma-separated list of header names to remove from request'),
}, async ({ pattern, status, body, contentType, headers, removeHeaders }) => {
  return withMutex(async () => {
    const wcId = requirePanel();
    const route = { pattern, status: status || 200, body: body || '', contentType: contentType || null, headers: headers || [], removeHeaders: removeHeaders || null };
    const resp = await cdp.addRoute(wcId, route);
    if (resp.error) throw new Error(resp.error);
    return { content: [{ type: 'text', text: `Route added: ${pattern} → ${route.status}${body ? ` (${body.length} bytes)` : ''}\n${resp.count} active route(s)` }] };
  });
});

server.tool('unroute', 'Remove network routes (all routes if no pattern specified)', {
  pattern: z.string().optional().describe('URL pattern to remove (omit to remove all routes)'),
}, async ({ pattern }) => {
  return withMutex(async () => {
    const wcId = requirePanel();
    const resp = await cdp.removeRoute(wcId, pattern || null);
    if (resp.error) throw new Error(resp.error);
    return { content: [{ type: 'text', text: pattern ? `Removed route: ${pattern}` : 'All routes removed.' }] };
  });
});

// --- Start server ---

const transport = new StdioServerTransport();
await server.connect(transport);
