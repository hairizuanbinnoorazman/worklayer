// lsp-manager.js - Main process LSP server manager
const { execSync, spawn } = require('child_process');

const SERVER_REGISTRY = {
  ty: { name: 'ty', command: 'ty', args: ['server'], languages: ['python'] },
  ruff: { name: 'Ruff', command: 'ruff', args: ['server'], languages: ['python'] },
};

// Map<serverId, { process, groupId, serverKey, pending, buffer }>
const activeServers = new Map();
let serverIdCounter = 0;

function getServerRegistry() {
  return { ...SERVER_REGISTRY };
}

function getActiveServers(groupId) {
  const result = [];
  for (const [serverId, info] of activeServers) {
    if (!groupId || info.groupId === groupId) {
      result.push({
        serverId,
        groupId: info.groupId,
        serverKey: info.serverKey,
        status: info.status,
      });
    }
  }
  return result;
}

function commandExists(command) {
  try {
    execSync(`which ${command}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// JSON-RPC framing: parse "Content-Length: N\r\n\r\n{json}" from buffer
function parseMessages(buffer) {
  const messages = [];
  let remaining = buffer;

  while (true) {
    const headerEnd = remaining.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;

    const header = remaining.slice(0, headerEnd).toString('utf-8');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      // Skip malformed header
      remaining = remaining.slice(headerEnd + 4);
      continue;
    }

    const contentLength = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;

    if (remaining.length < bodyStart + contentLength) break;

    const body = remaining.slice(bodyStart, bodyStart + contentLength).toString('utf-8');
    remaining = remaining.slice(bodyStart + contentLength);

    try {
      messages.push(JSON.parse(body));
    } catch (e) {
      // Skip malformed JSON
    }
  }

  return { messages, remaining };
}

function encodeMessage(msg) {
  const body = JSON.stringify(msg);
  const bodyBytes = Buffer.byteLength(body, 'utf-8');
  return `Content-Length: ${bodyBytes}\r\n\r\n${body}`;
}

function startServer(sender, { groupId, rootDir, serverKey }) {
  const registry = SERVER_REGISTRY[serverKey];
  if (!registry) {
    return { error: `Unknown server: ${serverKey}` };
  }

  if (!commandExists(registry.command)) {
    return { error: `Command not found: ${registry.command}. Install it first.` };
  }

  const serverId = `lsp-${++serverIdCounter}`;

  const proc = spawn(registry.command, registry.args, {
    cwd: rootDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const serverInfo = {
    process: proc,
    groupId,
    serverKey,
    status: 'starting',
    pending: new Map(), // id -> { resolve, reject }
    buffer: Buffer.alloc(0),
    requestId: 0,
    sender,
  };

  activeServers.set(serverId, serverInfo);

  proc.stdout.on('data', (chunk) => {
    serverInfo.buffer = Buffer.concat([serverInfo.buffer, chunk]);
    const { messages, remaining } = parseMessages(serverInfo.buffer);
    serverInfo.buffer = typeof remaining === 'string' ? Buffer.from(remaining) : remaining;

    for (const msg of messages) {
      if (msg.id !== undefined && serverInfo.pending.has(msg.id)) {
        // Response to a request we sent
        const { resolve } = serverInfo.pending.get(msg.id);
        serverInfo.pending.delete(msg.id);
        resolve(msg);
      } else if (msg.method) {
        // Notification or request from server
        if (!sender.isDestroyed()) {
          sender.send(`lsp:notification:${serverId}`, msg);
        }
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    // Log stderr for debugging but don't crash
    const text = chunk.toString('utf-8').trim();
    if (text) {
      try { require('fs').appendFileSync('/tmp/worklayer-debug.log',
        `[${new Date().toISOString()}] [LSP:${serverKey}:stderr] ${text}\n`); } catch (_) {}
    }
  });

  proc.on('error', (err) => {
    serverInfo.status = 'error';
    // Reject all pending requests
    for (const [, p] of serverInfo.pending) {
      p.reject(new Error(`LSP process error: ${err.message}`));
    }
    serverInfo.pending.clear();
  });

  proc.on('exit', (code, signal) => {
    serverInfo.status = 'stopped';
    for (const [, p] of serverInfo.pending) {
      p.reject(new Error(`LSP process exited: code=${code} signal=${signal}`));
    }
    serverInfo.pending.clear();
    activeServers.delete(serverId);

    if (!sender.isDestroyed()) {
      sender.send(`lsp:notification:${serverId}`, {
        method: 'lsp/serverExited',
        params: { code, signal },
      });
    }
  });

  // Send initialize request
  const rootUri = `file://${rootDir}`;
  const initResult = sendRequestInternal(serverId, 'initialize', {
    processId: process.pid,
    rootUri,
    rootPath: rootDir,
    workspaceFolders: [{ uri: rootUri, name: rootDir.split('/').pop() }],
    capabilities: {
      textDocument: {
        synchronization: {
          dynamicRegistration: false,
          willSave: false,
          willSaveWaitUntil: false,
          didSave: true,
        },
        completion: {
          dynamicRegistration: false,
          completionItem: {
            snippetSupport: false,
            commitCharactersSupport: true,
            documentationFormat: ['plaintext', 'markdown'],
            deprecatedSupport: true,
            preselectSupport: true,
          },
        },
        hover: {
          dynamicRegistration: false,
          contentFormat: ['plaintext', 'markdown'],
        },
        publishDiagnostics: {
          relatedInformation: true,
        },
      },
      workspace: {
        workspaceFolders: true,
      },
    },
  });

  initResult.then(() => {
    // Send initialized notification
    sendNotificationInternal(serverId, 'initialized', {});
    serverInfo.status = 'running';
  }).catch((err) => {
    serverInfo.status = 'error';
  });

  return { serverId };
}

function sendRequestInternal(serverId, method, params) {
  const info = activeServers.get(serverId);
  if (!info) return Promise.reject(new Error('Server not found'));

  const id = ++info.requestId;
  const msg = { jsonrpc: '2.0', id, method, params };

  return new Promise((resolve, reject) => {
    info.pending.set(id, { resolve, reject });
    try {
      info.process.stdin.write(encodeMessage(msg));
    } catch (e) {
      info.pending.delete(id);
      reject(e);
    }
  });
}

function sendNotificationInternal(serverId, method, params) {
  const info = activeServers.get(serverId);
  if (!info) return;

  const msg = { jsonrpc: '2.0', method, params };
  try {
    info.process.stdin.write(encodeMessage(msg));
  } catch (_) {}
}

function sendRequest(serverId, method, params) {
  return sendRequestInternal(serverId, method, params);
}

function sendNotification(serverId, method, params) {
  sendNotificationInternal(serverId, method, params);
}

function stopServer(serverId) {
  const info = activeServers.get(serverId);
  if (!info) return;

  // Try graceful shutdown
  sendRequestInternal(serverId, 'shutdown', null)
    .then(() => {
      sendNotificationInternal(serverId, 'exit', null);
    })
    .catch(() => {
      // Force kill if shutdown fails
      try { info.process.kill(); } catch (_) {}
    });

  // Force kill after timeout
  setTimeout(() => {
    if (activeServers.has(serverId)) {
      try { info.process.kill('SIGKILL'); } catch (_) {}
      activeServers.delete(serverId);
    }
  }, 3000);
}

function stopGroupServers(groupId) {
  for (const [serverId, info] of activeServers) {
    if (info.groupId === groupId) {
      stopServer(serverId);
    }
  }
}

function stopAllServers() {
  for (const [serverId] of activeServers) {
    stopServer(serverId);
  }
}

module.exports = {
  getServerRegistry,
  getActiveServers,
  startServer,
  stopServer,
  stopGroupServers,
  stopAllServers,
  sendRequest,
  sendNotification,
};
