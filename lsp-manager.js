// lsp-manager.js - Main process LSP server manager
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEBUG_LOG = '/tmp/worklayer-debug.log';
function debugLog(...args) {
  const msg = `[${new Date().toISOString()}] [LSP] ${args.join(' ')}\n`;
  try { fs.appendFileSync(DEBUG_LOG, msg); } catch (_) {}
}

const SERVER_REGISTRY = {
  ty: { name: 'ty', command: 'ty', args: ['server'], languages: ['python'] },
  ruff: { name: 'Ruff', command: 'ruff', args: ['server'], languages: ['python'] },
};

// Map<serverId, { process, groupId, serverKey, pending, buffer, ... }>
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

// Resolve command binary from project virtual environments or system PATH
function resolveCommand(command, rootDir) {
  // 1. Check <rootDir>/.venv/bin/<command> (uv default, common convention)
  const venvPath = path.join(rootDir, '.venv', 'bin', command);
  if (fs.existsSync(venvPath)) {
    debugLog(`resolveCommand: found ${command} at ${venvPath}`);
    return venvPath;
  }

  // 2. Check <rootDir>/venv/bin/<command>
  const venvPath2 = path.join(rootDir, 'venv', 'bin', command);
  if (fs.existsSync(venvPath2)) {
    debugLog(`resolveCommand: found ${command} at ${venvPath2}`);
    return venvPath2;
  }

  // 3. Try pipenv --venv from rootDir
  try {
    const pipenvVenv = execSync('pipenv --venv', {
      cwd: rootDir,
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
    if (pipenvVenv) {
      const pipenvBin = path.join(pipenvVenv, 'bin', command);
      if (fs.existsSync(pipenvBin)) {
        debugLog(`resolveCommand: found ${command} via pipenv at ${pipenvBin}`);
        return pipenvBin;
      }
      debugLog(`resolveCommand: pipenv venv at ${pipenvVenv} but no ${command} binary`);
    }
  } catch (e) {
    debugLog(`resolveCommand: pipenv --venv failed: ${e.message}`);
  }

  // 4. Try uv run which <command>
  try {
    const uvResult = execSync(`uv run --directory "${rootDir}" which ${command}`, {
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString().trim();
    if (uvResult && fs.existsSync(uvResult)) {
      debugLog(`resolveCommand: found ${command} via uv at ${uvResult}`);
      return uvResult;
    }
  } catch (e) {
    debugLog(`resolveCommand: uv run failed: ${e.message}`);
  }

  // 5. Common bin directories (may not be in PATH when Electron is GUI-launched)
  const commonDirs = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];
  for (const dir of commonDirs) {
    const binPath = path.join(dir, command);
    if (fs.existsSync(binPath)) {
      debugLog(`resolveCommand: found ${command} at ${binPath}`);
      return binPath;
    }
  }

  // 6. System PATH fallback
  try {
    const systemPath = execSync(`which ${command}`, { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
    if (systemPath) {
      debugLog(`resolveCommand: found ${command} in system PATH at ${systemPath}`);
      return systemPath;
    }
  } catch {
    debugLog(`resolveCommand: ${command} not found in system PATH`);
  }

  debugLog(`resolveCommand: ${command} not found anywhere`);
  return null;
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
      debugLog('parseMessages: malformed JSON:', body.slice(0, 200));
    }
  }

  return { messages, remaining };
}

function encodeMessage(msg) {
  const body = JSON.stringify(msg);
  const bodyBytes = Buffer.byteLength(body, 'utf-8');
  return `Content-Length: ${bodyBytes}\r\n\r\n${body}`;
}

async function startServer(sender, { groupId, rootDir, serverKey }) {
  debugLog(`startServer: serverKey=${serverKey} groupId=${groupId} rootDir=${rootDir}`);

  const registry = SERVER_REGISTRY[serverKey];
  if (!registry) {
    debugLog(`startServer: unknown server ${serverKey}`);
    return { error: `Unknown server: ${serverKey}` };
  }

  const resolvedCommand = resolveCommand(registry.command, rootDir);
  if (!resolvedCommand) {
    const msg = `Command not found: ${registry.command}. Searched .venv/bin, venv/bin, pipenv, uv, and system PATH.`;
    debugLog(`startServer: ${msg}`);
    return { error: msg };
  }

  debugLog(`startServer: spawning ${resolvedCommand} ${registry.args.join(' ')}`);

  const serverId = `lsp-${++serverIdCounter}`;

  // Build environment with virtual env hints so LSP servers can resolve imports
  const spawnEnv = { ...process.env };
  const venvCandidates = [path.join(rootDir, '.venv'), path.join(rootDir, 'venv')];
  for (const venv of venvCandidates) {
    if (fs.existsSync(path.join(venv, 'bin', 'python'))) {
      spawnEnv.VIRTUAL_ENV = venv;
      spawnEnv.PATH = path.join(venv, 'bin') + ':' + (spawnEnv.PATH || '');
      debugLog(`startServer: set VIRTUAL_ENV=${venv}`);
      break;
    }
  }

  const proc = spawn(resolvedCommand, registry.args, {
    cwd: rootDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: spawnEnv,
  });

  const serverInfo = {
    process: proc,
    groupId,
    serverKey,
    status: 'starting',
    pending: new Map(),
    buffer: Buffer.alloc(0),
    requestId: 0,
    sender,
  };

  activeServers.set(serverId, serverInfo);

  proc.stdin.on('error', (err) => {
    debugLog(`startServer[${serverId}]: stdin error: ${err.message}`);
  });

  proc.stdout.on('data', (chunk) => {
    serverInfo.buffer = Buffer.concat([serverInfo.buffer, chunk]);
    const { messages, remaining } = parseMessages(serverInfo.buffer);
    serverInfo.buffer = typeof remaining === 'string' ? Buffer.from(remaining) : remaining;

    for (const msg of messages) {
      if (msg.id !== undefined && serverInfo.pending.has(msg.id)) {
        const { resolve } = serverInfo.pending.get(msg.id);
        serverInfo.pending.delete(msg.id);
        debugLog(`startServer[${serverId}]: got response for request id=${msg.id}`);
        resolve(msg);
      } else if (msg.method) {
        debugLog(`startServer[${serverId}]: notification from server: ${msg.method}`);
        if (!sender.isDestroyed()) {
          sender.send(`lsp:notification:${serverId}`, msg);
        }
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf-8').trim();
    if (text) {
      debugLog(`[${serverKey}:stderr] ${text}`);
    }
  });

  proc.on('error', (err) => {
    debugLog(`startServer[${serverId}]: process error: ${err.message}`);
    serverInfo.status = 'error';
    for (const [, p] of serverInfo.pending) {
      p.reject(new Error(`LSP process error: ${err.message}`));
    }
    serverInfo.pending.clear();
  });

  proc.on('exit', (code, signal) => {
    debugLog(`startServer[${serverId}]: process exited code=${code} signal=${signal}`);
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

  // Send initialize request and AWAIT the response before returning
  const rootUri = `file://${rootDir}`;
  debugLog(`startServer[${serverId}]: sending initialize request`);

  try {
    const initResponse = await Promise.race([
      sendRequestInternal(serverId, 'initialize', {
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
              contextSupport: true,
              completionItem: {
                snippetSupport: false,
                commitCharactersSupport: true,
                documentationFormat: ['plaintext', 'markdown'],
                deprecatedSupport: true,
                preselectSupport: true,
                labelDetailsSupport: true,
                resolveSupport: {
                  properties: ['documentation', 'detail'],
                },
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
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Initialize timed out after 10s')), 10000)
      ),
    ]);

    debugLog(`startServer[${serverId}]: initialize response received, sending initialized notification`);
    sendNotificationInternal(serverId, 'initialized', {});
    serverInfo.status = 'running';
    debugLog(`startServer[${serverId}]: server is running`);
    return { serverId };

  } catch (err) {
    debugLog(`startServer[${serverId}]: initialization failed: ${err.message}`);
    serverInfo.status = 'error';
    // Clean up the failed server
    try { proc.kill(); } catch (_) {}
    activeServers.delete(serverId);
    return { error: `LSP initialization failed: ${err.message}` };
  }
}

function sendRequestInternal(serverId, method, params) {
  const info = activeServers.get(serverId);
  if (!info) return Promise.reject(new Error('Server not found'));

  const id = ++info.requestId;
  const msg = { jsonrpc: '2.0', id, method, params };

  return new Promise((resolve, reject) => {
    info.pending.set(id, { resolve, reject });
    if (!info.process.stdin.writable) {
      info.pending.delete(id);
      reject(new Error('LSP process stdin is not writable'));
      return;
    }
    try {
      debugLog(`sendRequest[${serverId}]: ${method} id=${id}`);
      info.process.stdin.write(encodeMessage(msg));
    } catch (e) {
      debugLog(`sendRequest[${serverId}]: write failed: ${e.message}`);
      info.pending.delete(id);
      reject(e);
    }
  });
}

function sendNotificationInternal(serverId, method, params) {
  const info = activeServers.get(serverId);
  if (!info) return;

  const msg = { jsonrpc: '2.0', method, params };
  if (!info.process.stdin.writable) return;
  try {
    debugLog(`sendNotification[${serverId}]: ${method}`);
    info.process.stdin.write(encodeMessage(msg));
  } catch (e) {
    debugLog(`sendNotification[${serverId}]: write failed: ${e.message}`);
  }
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
  debugLog(`stopServer: ${serverId}`);

  sendRequestInternal(serverId, 'shutdown', null)
    .then(() => {
      sendNotificationInternal(serverId, 'exit', null);
    })
    .catch(() => {
      try { info.process.kill(); } catch (_) {}
    });

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
