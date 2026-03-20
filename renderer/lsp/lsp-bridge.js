// lsp-bridge.js - Renderer-side LSP client bridge

// Map<serverId, { cleanupNotifications, providers[] }>
const activeLspConnections = new Map();

// Debounce entries for didChange per filePath: Map<key, {timer, flush}>
const didChangePending = new Map();

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
  switch (severity) {
    case 1: return 8;  // Error
    case 2: return 4;  // Warning
    case 3: return 2;  // Info
    case 4: return 1;  // Hint
    default: return 2;
  }
}

function filePathToUri(filePath) {
  // Use Monaco's URI builder for consistent encoding with model URIs
  if (window.monaco) return monaco.Uri.file(filePath).toString();
  return 'file://' + filePath;
}

function uriToFilePath(uri) {
  if (uri.startsWith('file://')) return decodeURIComponent(uri.slice(7));
  return uri;
}

function lspCompletionKindToMonaco(kind) {
  const map = {
    1: 18, 2: 0, 3: 1, 4: 4, 5: 3, 6: 4, 7: 5, 8: 7, 9: 8,
    10: 9, 11: 12, 12: 11, 13: 15, 14: 13, 15: 14, 16: 15,
    17: 16, 18: 17, 19: 18, 20: 16, 21: 14, 22: 6, 23: 20,
    24: 21, 25: 22,
  };
  return map[kind] || 18;
}

// --- Diagnostic handling ---

function handleDiagnostics(serverKey, params) {
  if (!window.monaco) return;

  const filePath = uriToFilePath(params.uri);
  const models = monaco.editor.getModels();
  const model = models.find(m => m.uri.path === filePath);

  if (!model) {
    console.log(`[LSP-bridge] diagnostics: no model for ${filePath}`);
    return;
  }

  const markers = (params.diagnostics || []).map(d => ({
    severity: lspSeverityToMonaco(d.severity),
    message: d.message,
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
    source: d.source || serverKey,
  }));

  console.log(`[LSP-bridge] setting ${markers.length} markers for ${serverKey} on ${filePath}`);
  monaco.editor.setModelMarkers(model, serverKey, markers);
}

// --- Provider registration ---

function registerLspProviders(serverId, serverKey, languageId) {
  console.log(`[LSP-bridge] registerLspProviders: serverId=${serverId} serverKey=${serverKey} lang=${languageId}`);
  if (!window.monaco) {
    console.warn(`[LSP-bridge] registerLspProviders: monaco not loaded yet, skipping`);
    return [];
  }
  const providers = [];

  // Completion provider
  const completionDisposable = monaco.languages.registerCompletionItemProvider(languageId, {
    triggerCharacters: ['.', '('],
    provideCompletionItems: async (model, position, context) => {
      console.log(`[LSP-bridge] completion request to ${serverKey} at line ${position.lineNumber}`);
      try {
        // Flush any pending didChange so the LSP server has up-to-date content
        const filePath = uriToFilePath(model.uri.toString());
        flushDidChange(serverId, filePath);

        // Map Monaco trigger kind to LSP trigger kind (Monaco is 0-based, LSP is 1-based)
        const triggerKind = (context.triggerKind || 0) + 1;
        const lspContext = { triggerKind };
        if (context.triggerCharacter) {
          lspContext.triggerCharacter = context.triggerCharacter;
        }

        const response = await window.electronAPI.lspSendRequest(serverId, 'textDocument/completion', {
          textDocument: { uri: model.uri.toString() },
          position: monacoPositionToLsp(position),
          context: lspContext,
        });

        if (!response || response.error) {
          console.log(`[LSP-bridge] completion error from ${serverKey}:`, response?.error);
          return { suggestions: [] };
        }

        const items = response.result
          ? (Array.isArray(response.result) ? response.result : response.result.items || [])
          : [];

        console.log(`[LSP-bridge] completion: got ${items.length} items from ${serverKey}`);

        const word = model.getWordUntilPosition(position);
        const fallbackRange = {
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: word.endColumn,
        };

        const suggestions = items.map(item => {
          // Determine range and insertText from textEdit if available
          let range = fallbackRange;
          let insertText = item.insertText || item.label;
          if (item.textEdit) {
            const lspRange = item.textEdit.range || item.textEdit.insert;
            if (lspRange) {
              const converted = lspRangeToMonaco(lspRange);
              // Validate: range must be on the same line as the cursor and within model bounds
              if (converted.startLineNumber === position.lineNumber &&
                  converted.endLineNumber === position.lineNumber &&
                  converted.startColumn >= 1 &&
                  converted.endColumn <= model.getLineMaxColumn(position.lineNumber)) {
                range = converted;
              }
              insertText = item.textEdit.newText;
            }
          }

          return {
            label: item.label,
            kind: lspCompletionKindToMonaco(item.kind),
            insertText,
            detail: item.detail || '',
            documentation: item.documentation
              ? (typeof item.documentation === 'string' ? item.documentation : item.documentation.value)
              : '',
            range,
            sortText: item.sortText || item.label,
            preselect: !!item.preselect,
            filterText: item.filterText || undefined,
            _lspItem: item,
          };
        });

        return { suggestions };
      } catch (e) {
        console.warn(`[LSP-bridge] completion exception from ${serverKey}:`, e);
        return { suggestions: [] };
      }
    },
    resolveCompletionItem: async (item) => {
      if (!item._lspItem) return item;
      try {
        const response = await window.electronAPI.lspSendRequest(serverId, 'completionItem/resolve', item._lspItem);
        if (response && !response.error && response.result) {
          const resolved = response.result;
          if (resolved.detail) item.detail = resolved.detail;
          if (resolved.documentation) {
            item.documentation = typeof resolved.documentation === 'string'
              ? resolved.documentation
              : resolved.documentation.value || '';
          }
        }
      } catch (e) {
        console.warn(`[LSP-bridge] resolve exception from ${serverKey}:`, e);
      }
      return item;
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
            contents.push({ value: typeof c === 'string' ? c : (c.value || '') });
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
  const uri = filePathToUri(filePath);
  console.log(`[LSP-bridge] didOpen: serverId=${serverId} uri=${uri}`);
  window.electronAPI.lspSendNotification(serverId, 'textDocument/didOpen', {
    textDocument: {
      uri,
      languageId,
      version: 1,
      text: content,
    },
  });
}

function lspDidChange(serverId, filePath, content, version) {
  const key = `${serverId}:${filePath}`;
  const existing = didChangePending.get(key);
  if (existing) clearTimeout(existing.timer);

  const send = () => {
    didChangePending.delete(key);
    const uri = filePathToUri(filePath);
    window.electronAPI.lspSendNotification(serverId, 'textDocument/didChange', {
      textDocument: {
        uri,
        version: version || 1,
      },
      contentChanges: [{ text: content }],
    });
  };

  didChangePending.set(key, {
    timer: setTimeout(send, DIDCHANGE_DEBOUNCE_MS),
    flush: send,
  });
}

function flushDidChange(serverId, filePath) {
  const key = `${serverId}:${filePath}`;
  const pending = didChangePending.get(key);
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.flush();
}

function lspDidSave(serverId, filePath, content) {
  flushDidChange(serverId, filePath);
  const uri = filePathToUri(filePath);
  window.electronAPI.lspSendNotification(serverId, 'textDocument/didSave', {
    textDocument: { uri },
    text: content,
  });
}

function lspDidClose(serverId, filePath) {
  const key = `${serverId}:${filePath}`;
  const pending = didChangePending.get(key);
  if (pending) clearTimeout(pending.timer);
  didChangePending.delete(key);

  const uri = filePathToUri(filePath);
  console.log(`[LSP-bridge] didClose: serverId=${serverId} uri=${uri}`);
  window.electronAPI.lspSendNotification(serverId, 'textDocument/didClose', {
    textDocument: { uri },
  });
}

// --- Connection management ---

function connectLspServer(serverId, serverKey, languageId) {
  if (activeLspConnections.has(serverId)) return;
  console.log(`[LSP-bridge] connectLspServer: serverId=${serverId} serverKey=${serverKey} lang=${languageId}`);

  const cleanup = window.electronAPI.onLspNotification(serverId, (msg) => {
    if (msg.method === 'textDocument/publishDiagnostics') {
      handleDiagnostics(serverKey, msg.params);
    } else if (msg.method === 'lsp/serverExited') {
      console.log(`[LSP-bridge] server exited: ${serverId}`, msg.params);
    }
  });

  const providers = registerLspProviders(serverId, serverKey, languageId);
  activeLspConnections.set(serverId, { cleanup, providers });
}

function disconnectLspServer(serverId, serverKey) {
  const conn = activeLspConnections.get(serverId);
  if (!conn) return;
  console.log(`[LSP-bridge] disconnectLspServer: serverId=${serverId} serverKey=${serverKey}`);

  if (conn.cleanup) conn.cleanup();
  for (const p of conn.providers) {
    try { p.dispose(); } catch (_) {}
  }
  activeLspConnections.delete(serverId);

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
