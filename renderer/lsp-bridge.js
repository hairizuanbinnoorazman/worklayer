// lsp-bridge.js - Renderer-side LSP client bridge

// Map<serverId, { cleanupNotifications, providers[] }>
const activeLspConnections = new Map();

// Debounce timers for didChange per filePath
const didChangeTimers = new Map();

const DIDCHANGE_DEBOUNCE_MS = 300;

// --- LSP <-> Monaco coordinate mapping ---
// LSP: 0-based line/char, Monaco: 1-based line/column

function lspPosToMonaco(pos) {
  return { lineNumber: pos.line + 1, column: pos.character + 1 };
}

function monacoPositionToLsp(pos) {
  return { line: pos.lineNumber - 1, character: pos.column - 1 };
}

function lspRangeToMonaco(range) {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

function lspSeverityToMonaco(severity) {
  // LSP: 1=Error, 2=Warning, 3=Information, 4=Hint
  // Monaco: 8=Error, 4=Warning, 2=Info, 1=Hint
  switch (severity) {
    case 1: return 8;
    case 2: return 4;
    case 3: return 2;
    case 4: return 1;
    default: return 2;
  }
}

function filePathToUri(filePath) {
  return 'file://' + filePath;
}

function uriToFilePath(uri) {
  if (uri.startsWith('file://')) return uri.slice(7);
  return uri;
}

// LSP CompletionItemKind -> Monaco CompletionItemKind
function lspCompletionKindToMonaco(kind) {
  // Rough mapping; both use similar numbering
  const map = {
    1: 18,  // Text -> Text
    2: 0,   // Method -> Method
    3: 1,   // Function -> Function
    4: 4,   // Constructor -> Constructor
    5: 3,   // Field -> Field
    6: 4,   // Variable -> Variable
    7: 5,   // Class -> Class
    8: 7,   // Interface -> Interface
    9: 8,   // Module -> Module
    10: 9,  // Property -> Property
    11: 12, // Unit -> Unit
    12: 11, // Value -> Value
    13: 15, // Enum -> Enum
    14: 13, // Keyword -> Keyword
    15: 14, // Snippet -> Snippet
    16: 15, // Color -> Color
    17: 16, // File -> File
    18: 17, // Reference -> Reference
    19: 18, // Folder -> Folder
    20: 16, // EnumMember -> EnumMember
    21: 14, // Constant -> Constant
    22: 6,  // Struct -> Struct
    23: 20, // Event -> Event
    24: 21, // Operator -> Operator
    25: 22, // TypeParameter -> TypeParameter
  };
  return map[kind] || 18; // default to Text
}

// --- Diagnostic handling ---

function handleDiagnostics(serverKey, params) {
  if (!window.monaco) return;

  const filePath = uriToFilePath(params.uri);
  // Find model by URI
  const models = monaco.editor.getModels();
  const model = models.find(m => {
    const mPath = m.uri.path;
    return mPath === filePath;
  });

  if (!model) return;

  const markers = (params.diagnostics || []).map(d => ({
    severity: lspSeverityToMonaco(d.severity),
    message: d.message,
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
    source: d.source || serverKey,
  }));

  monaco.editor.setModelMarkers(model, serverKey, markers);
}

// --- Provider registration ---

function registerLspProviders(serverId, serverKey, languageId) {
  const providers = [];

  // Completion provider
  const completionDisposable = monaco.languages.registerCompletionItemProvider(languageId, {
    triggerCharacters: ['.', '('],
    provideCompletionItems: async (model, position) => {
      try {
        const response = await window.electronAPI.lspSendRequest(serverId, 'textDocument/completion', {
          textDocument: { uri: model.uri.toString() },
          position: monacoPositionToLsp(position),
        });

        if (!response || response.error) return { suggestions: [] };

        const items = response.result
          ? (Array.isArray(response.result) ? response.result : response.result.items || [])
          : [];

        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: word.endColumn,
        };

        const suggestions = items.map(item => ({
          label: item.label,
          kind: lspCompletionKindToMonaco(item.kind),
          insertText: item.insertText || item.label,
          detail: item.detail || '',
          documentation: item.documentation
            ? (typeof item.documentation === 'string' ? item.documentation : item.documentation.value)
            : '',
          range,
          sortText: item.sortText || item.label,
        }));

        return { suggestions };
      } catch {
        return { suggestions: [] };
      }
    },
  });
  providers.push(completionDisposable);

  // Hover provider
  const hoverDisposable = monaco.languages.registerHoverProvider(languageId, {
    provideHover: async (model, position) => {
      try {
        const response = await window.electronAPI.lspSendRequest(serverId, 'textDocument/hover', {
          textDocument: { uri: model.uri.toString() },
          position: monacoPositionToLsp(position),
        });

        if (!response || response.error || !response.result) return null;

        const hover = response.result;
        const contents = [];

        if (typeof hover.contents === 'string') {
          contents.push({ value: hover.contents });
        } else if (hover.contents.kind) {
          contents.push({ value: hover.contents.value });
        } else if (Array.isArray(hover.contents)) {
          for (const c of hover.contents) {
            if (typeof c === 'string') {
              contents.push({ value: c });
            } else {
              contents.push({ value: c.value || '' });
            }
          }
        } else if (hover.contents.value) {
          contents.push({ value: hover.contents.value });
        }

        return {
          contents,
          range: hover.range ? lspRangeToMonaco(hover.range) : undefined,
        };
      } catch {
        return null;
      }
    },
  });
  providers.push(hoverDisposable);

  return providers;
}

// --- Document sync helpers ---

function lspDidOpen(serverId, filePath, languageId, content) {
  window.electronAPI.lspSendNotification(serverId, 'textDocument/didOpen', {
    textDocument: {
      uri: filePathToUri(filePath),
      languageId: languageId,
      version: 1,
      text: content,
    },
  });
}

function lspDidChange(serverId, filePath, content, version) {
  const key = `${serverId}:${filePath}`;
  clearTimeout(didChangeTimers.get(key));

  didChangeTimers.set(key, setTimeout(() => {
    didChangeTimers.delete(key);
    window.electronAPI.lspSendNotification(serverId, 'textDocument/didChange', {
      textDocument: {
        uri: filePathToUri(filePath),
        version: version || 1,
      },
      contentChanges: [{ text: content }],
    });
  }, DIDCHANGE_DEBOUNCE_MS));
}

function lspDidClose(serverId, filePath) {
  const key = `${serverId}:${filePath}`;
  clearTimeout(didChangeTimers.get(key));
  didChangeTimers.delete(key);

  window.electronAPI.lspSendNotification(serverId, 'textDocument/didClose', {
    textDocument: { uri: filePathToUri(filePath) },
  });
}

// --- Connection management ---

function connectLspServer(serverId, serverKey, languageId) {
  if (activeLspConnections.has(serverId)) return;

  // Listen for notifications from this server
  const cleanup = window.electronAPI.onLspNotification(serverId, (msg) => {
    if (msg.method === 'textDocument/publishDiagnostics') {
      handleDiagnostics(serverKey, msg.params);
    }
    // Could handle other notifications here (e.g., window/logMessage)
  });

  const providers = registerLspProviders(serverId, serverKey, languageId);

  activeLspConnections.set(serverId, { cleanup, providers });
}

function disconnectLspServer(serverId, serverKey) {
  const conn = activeLspConnections.get(serverId);
  if (!conn) return;

  if (conn.cleanup) conn.cleanup();
  for (const p of conn.providers) {
    try { p.dispose(); } catch (_) {}
  }
  activeLspConnections.delete(serverId);

  // Clear markers owned by this server key
  if (window.monaco) {
    for (const model of monaco.editor.getModels()) {
      monaco.editor.setModelMarkers(model, serverKey, []);
    }
  }
}

function disconnectAllLsp() {
  for (const [serverId] of activeLspConnections) {
    const conn = activeLspConnections.get(serverId);
    if (conn.cleanup) conn.cleanup();
    for (const p of conn.providers) {
      try { p.dispose(); } catch (_) {}
    }
  }
  activeLspConnections.clear();
}
