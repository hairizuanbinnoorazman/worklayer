// file-panel.js - File explorer + Monaco editor panel

let monacoLoaded = false;
let monacoLoadPromise = null;

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg',
  'woff', 'woff2', 'ttf', 'eot', 'otf',
  'zip', 'tar', 'gz', 'bz2', '7z', 'rar',
  'pdf', 'doc', 'docx', 'xls', 'xlsx',
  'exe', 'dll', 'so', 'dylib', 'o', 'a',
  'mp3', 'mp4', 'wav', 'avi', 'mov', 'mkv',
  'sqlite', 'db',
]);

const EXT_LANG_MAP = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', rs: 'rust', go: 'go',
  java: 'java', kt: 'kotlin', scala: 'scala',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
  cs: 'csharp', swift: 'swift', m: 'objective-c',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  xml: 'xml', html: 'html', htm: 'html',
  css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', txt: 'plaintext',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  sql: 'sql', graphql: 'graphql',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  r: 'r', lua: 'lua', php: 'php', pl: 'perl',
};

function getLanguageFromPath(filePath) {
  const name = filePath.split('/').pop().toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  const ext = name.includes('.') ? name.split('.').pop() : '';
  return EXT_LANG_MAP[ext] || 'plaintext';
}

function isBinaryFile(filePath) {
  const ext = filePath.split('.').pop().toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

function loadMonaco() {
  if (monacoLoaded) return Promise.resolve();
  if (monacoLoadPromise) return monacoLoadPromise;

  monacoLoadPromise = new Promise((resolve, reject) => {
    const loaderScript = document.createElement('script');
    loaderScript.src = '../node_modules/monaco-editor/min/vs/loader.js';
    loaderScript.onload = () => {
      require.config({
        paths: { vs: '../node_modules/monaco-editor/min/vs' },
      });
      require(['vs/editor/editor.main'], () => {
        monacoLoaded = true;
        resolve();
      }, reject);
    };
    loaderScript.onerror = reject;
    document.head.appendChild(loaderScript);
  });

  return monacoLoadPromise;
}

function renderFilePanel(panel, container) {
  const layout = document.createElement('div');
  layout.className = 'file-panel-layout';

  // Left sidebar - file tree
  const sidebar = document.createElement('div');
  sidebar.className = 'file-tree-sidebar';

  const treeHeader = document.createElement('div');
  treeHeader.className = 'file-tree-header';

  const rootLabel = document.createElement('span');
  rootLabel.className = 'file-tree-root-label';
  rootLabel.textContent = panel.rootDir ? panel.rootDir.split('/').pop() || panel.rootDir : 'No directory';
  rootLabel.title = panel.rootDir || '';

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'file-tree-refresh-btn';
  refreshBtn.textContent = '\u21bb';
  refreshBtn.title = 'Refresh';

  treeHeader.appendChild(rootLabel);
  treeHeader.appendChild(refreshBtn);
  sidebar.appendChild(treeHeader);

  const treeContainer = document.createElement('div');
  treeContainer.className = 'file-tree-entries';
  sidebar.appendChild(treeContainer);

  // Internal resize handle
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'file-tree-resize-handle';

  // Right side - editor area
  const editorArea = document.createElement('div');
  editorArea.className = 'file-editor-area';

  const toolbar = document.createElement('div');
  toolbar.className = 'editor-toolbar';

  const fileLabel = document.createElement('span');
  fileLabel.className = 'editor-file-label';
  fileLabel.textContent = 'No file selected';

  const modifiedDot = document.createElement('span');
  modifiedDot.className = 'editor-modified-dot';
  modifiedDot.title = 'Unsaved changes';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'editor-save-btn';
  saveBtn.textContent = 'Save';
  saveBtn.disabled = true;

  const lspBtn = document.createElement('button');
  lspBtn.className = 'editor-lsp-btn';
  lspBtn.textContent = 'LSP';
  lspBtn.title = 'Language Server Settings';

  toolbar.appendChild(fileLabel);
  toolbar.appendChild(modifiedDot);
  toolbar.appendChild(saveBtn);
  toolbar.appendChild(lspBtn);
  editorArea.appendChild(toolbar);

  const editorContainer = document.createElement('div');
  editorContainer.className = 'editor-container';

  const placeholder = document.createElement('div');
  placeholder.className = 'editor-placeholder';
  placeholder.textContent = 'Select a file to edit';
  editorContainer.appendChild(placeholder);

  editorArea.appendChild(editorContainer);

  layout.appendChild(sidebar);
  layout.appendChild(resizeHandle);
  layout.appendChild(editorArea);
  container.appendChild(layout);

  // State
  let currentEditor = null;
  let currentFilePath = null;
  let isDirty = false;
  let activeTreeItem = null;
  let docVersion = 0;
  let gitDecorationCollection = null;
  const panelLspServerIds = []; // track server IDs started for this panel

  function setDirty(dirty) {
    isDirty = dirty;
    modifiedDot.classList.toggle('visible', dirty);
    saveBtn.disabled = !dirty;
  }

  async function saveFile() {
    if (!currentFilePath || !currentEditor || !isDirty) return;
    const content = currentEditor.getValue();
    const result = await window.electronAPI.writeFile(currentFilePath, content);
    if (result.error) {
      alert('Save failed: ' + result.error);
    } else {
      setDirty(false);
      updateGitDecorations();
      for (const sid of panelLspServerIds) {
        lspDidSave(sid, currentFilePath, content);
      }
    }
  }

  saveBtn.addEventListener('click', saveFile);

  async function updateGitDecorations() {
    if (!currentFilePath || !currentEditor) {
      if (gitDecorationCollection) {
        gitDecorationCollection.clear();
      }
      return;
    }
    const targetPath = currentFilePath;
    try {
      const result = await window.electronAPI.gitDiff(targetPath);
      if (currentFilePath !== targetPath) return; // stale response guard
      const decorations = (result.changes || []).map(change => ({
        range: new monaco.Range(change.startLine, 1, change.endLine, 1),
        options: {
          linesDecorationsClassName: `git-gutter-${change.type}`,
        },
      }));
      if (gitDecorationCollection) {
        gitDecorationCollection.clear();
      }
      gitDecorationCollection = currentEditor.createDecorationsCollection(decorations);
    } catch (e) {
      console.warn('[file-panel] git decoration error:', e);
    }
  }

  async function openFile(filePath) {
    if (isBinaryFile(filePath)) {
      if (currentEditor) {
        currentEditor.setValue('');
        currentEditor.updateOptions({ readOnly: true });
      }
      fileLabel.textContent = filePath.split('/').pop();
      placeholder.textContent = 'Cannot edit binary file';
      placeholder.style.display = currentEditor ? 'none' : '';
      if (currentEditor) {
        currentEditor.setValue('// Cannot edit binary file');
        currentEditor.updateOptions({ readOnly: true });
      }
      setDirty(false);
      currentFilePath = null;
      if (gitDecorationCollection) {
        gitDecorationCollection.clear();
      }
      return;
    }

    if (isDirty && currentFilePath) {
      const proceed = confirm(`"${currentFilePath.split('/').pop()}" has unsaved changes. Discard?`);
      if (!proceed) return;
    }

    const result = await window.electronAPI.readFile(filePath);
    if (result.error) {
      alert('Failed to read file: ' + result.error);
      return;
    }

    const previousFilePath = currentFilePath;
    currentFilePath = filePath;
    panel.openFile = filePath;
    saveState();

    fileLabel.textContent = filePath.split('/').pop();
    fileLabel.title = filePath;

    const lang = getLanguageFromPath(filePath);
    docVersion++;

    if (!currentEditor) {
      await loadMonaco();
      placeholder.style.display = 'none';

      // Use URI-based model so LSP diagnostics match by URI
      const uri = monaco.Uri.file(filePath);
      let model = monaco.editor.getModel(uri);
      if (model) {
        model.setValue(result.content);
        monaco.editor.setModelLanguage(model, lang);
      } else {
        model = monaco.editor.createModel(result.content, lang, uri);
      }

      currentEditor = monaco.editor.create(editorContainer, {
        model,
        theme: 'vs-dark',
        automaticLayout: false,
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        scrollBeyondLastLine: false,
        wordWrap: 'on',
      });

      currentEditor.onDidChangeModelContent(() => {
        setDirty(true);
        // Send didChange to all active LSP servers
        docVersion++;
        for (const sid of panelLspServerIds) {
          lspDidChange(sid, currentFilePath, currentEditor.getValue(), docVersion);
        }
      });

      currentEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        saveFile();
      });

      activeEditors.set(panel.id, {
        editor: currentEditor,
        dispose: () => {
          // Close current doc in LSP servers
          if (currentFilePath) {
            for (const sid of panelLspServerIds) {
              lspDidClose(sid, currentFilePath);
            }
          }
          currentEditor.dispose();
          activeEditors.delete(panel.id);
        },
      });

      requestAnimationFrame(() => currentEditor.layout());
    } else {
      // Close old file in LSP servers
      if (previousFilePath && previousFilePath !== filePath) {
        for (const sid of panelLspServerIds) {
          lspDidClose(sid, previousFilePath);
        }
      }

      // Switch to URI-based model
      const uri = monaco.Uri.file(filePath);
      let model = monaco.editor.getModel(uri);
      if (model) {
        model.setValue(result.content);
        monaco.editor.setModelLanguage(model, lang);
      } else {
        model = monaco.editor.createModel(result.content, lang, uri);
      }
      currentEditor.setModel(model);
      currentEditor.updateOptions({ readOnly: false });
    }

    // Notify LSP servers of file open
    for (const sid of panelLspServerIds) {
      lspDidOpen(sid, filePath, lang, result.content);
    }

    setDirty(false);
    updateGitDecorations();
  }

  // Open the previously open file on restore
  if (panel.openFile) {
    openFile(panel.openFile);
  }

  // File tree loading
  async function loadTreeEntries(dirPath, parentEl, depth) {
    const result = await window.electronAPI.readDirectory(dirPath);
    if (result.error) return;

    result.entries.forEach(entry => {
      const item = document.createElement('div');
      item.className = 'tree-item ' + (entry.isDirectory ? 'tree-directory' : 'tree-file');
      item.style.paddingLeft = (12 + depth * 14) + 'px';

      const icon = document.createElement('span');
      icon.className = 'tree-icon';
      icon.textContent = entry.isDirectory ? '\u25b6' : '';

      const name = document.createElement('span');
      name.className = 'tree-name';
      name.textContent = entry.name;

      item.appendChild(icon);
      item.appendChild(name);
      parentEl.appendChild(item);

      if (entry.isDirectory) {
        const children = document.createElement('div');
        children.className = 'tree-children';
        children.hidden = true;
        parentEl.appendChild(children);

        let loaded = false;
        item.addEventListener('click', async (e) => {
          e.stopPropagation();
          const isOpen = !children.hidden;
          children.hidden = isOpen;
          icon.textContent = isOpen ? '\u25b6' : '\u25bc';
          if (!loaded) {
            loaded = true;
            await loadTreeEntries(dirPath + '/' + entry.name, children, depth + 1);
          }
        });
      } else {
        const fullPath = dirPath + '/' + entry.name;
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          if (activeTreeItem) activeTreeItem.classList.remove('active');
          item.classList.add('active');
          activeTreeItem = item;
          openFile(fullPath);
        });
      }
    });
  }

  if (panel.rootDir) {
    loadTreeEntries(panel.rootDir, treeContainer, 0);
  }

  refreshBtn.addEventListener('click', () => {
    treeContainer.innerHTML = '';
    if (panel.rootDir) {
      loadTreeEntries(panel.rootDir, treeContainer, 0);
    }
  });

  // LSP button handler
  function updateLspButton() {
    const count = panelLspServerIds.length;
    lspBtn.textContent = count > 0 ? `LSP (${count})` : 'LSP';
    lspBtn.classList.toggle('lsp-active', count > 0);
  }

  async function applyLspConfig(newConfig) {
    const group = getActiveGroup();
    if (!group) return;
    group.lspServers = newConfig;
    saveState();

    const activeServers = await window.electronAPI.lspGetActiveServers(group.id);
    const activeKeys = new Set(activeServers.map(s => s.serverKey));
    const activeById = {};
    for (const s of activeServers) {
      activeById[s.serverKey] = s.serverId;
    }

    // Stop servers that are no longer enabled
    for (const conf of newConfig) {
      if (!conf.enabled && activeKeys.has(conf.serverKey)) {
        const sid = activeById[conf.serverKey];
        console.log(`[file-panel] stopping LSP server: ${conf.serverKey} (${sid})`);
        disconnectLspServer(sid, conf.serverKey);
        await window.electronAPI.lspStopServer(sid);
        const idx = panelLspServerIds.indexOf(sid);
        if (idx !== -1) panelLspServerIds.splice(idx, 1);
        activeLspServers.delete(sid);

        if (window.monaco) {
          for (const model of monaco.editor.getModels()) {
            monaco.editor.setModelMarkers(model, conf.serverKey, []);
          }
        }
      }
    }

    // Start servers that are newly enabled
    const errors = [];
    for (const conf of newConfig) {
      if (conf.enabled && !activeKeys.has(conf.serverKey)) {
        console.log(`[file-panel] starting LSP server: ${conf.serverKey}`);
        const result = await window.electronAPI.lspStartServer({
          groupId: group.id,
          rootDir: panel.rootDir,
          serverKey: conf.serverKey,
        });
        if (result.error) {
          console.warn(`[file-panel] LSP start failed for ${conf.serverKey}: ${result.error}`);
          errors.push(`${conf.serverKey}: ${result.error}`);
          continue;
        }
        if (result.serverId) {
          console.log(`[file-panel] LSP server started: ${conf.serverKey} -> ${result.serverId}`);
          panelLspServerIds.push(result.serverId);
          activeLspServers.set(result.serverId, {
            groupId: group.id,
            serverKey: conf.serverKey,
          });
          const registry = await window.electronAPI.lspGetRegistry();
          const langs = registry[conf.serverKey]?.languages || ['python'];
          for (const lang of langs) {
            connectLspServer(result.serverId, conf.serverKey, lang);
          }
          if (currentFilePath && currentEditor) {
            const fileLang = getLanguageFromPath(currentFilePath);
            lspDidOpen(result.serverId, currentFilePath, fileLang, currentEditor.getValue());
          }
        }
      }
    }

    updateLspButton();

    if (errors.length > 0) {
      lspBtn.title = 'LSP errors:\n' + errors.join('\n');
      lspBtn.classList.add('lsp-error');
    } else {
      lspBtn.classList.remove('lsp-error');
      lspBtn.title = 'Language Server Settings';
    }
  }

  lspBtn.addEventListener('click', () => {
    const group = getActiveGroup();
    if (!group) return;
    showLspSettingsModal(group, panel.rootDir, applyLspConfig);
  });

  // Auto-start LSP servers if previously enabled
  async function autoStartLsp() {
    const group = getActiveGroup();
    if (!group || !panel.rootDir) return;
    const lspConfig = group.lspServers || [];
    const enabled = lspConfig.filter(s => s.enabled);
    if (enabled.length === 0) return;

    console.log(`[file-panel] autoStartLsp: starting ${enabled.length} server(s)`);

    // Ensure Monaco is loaded before registering providers
    await loadMonaco();

    const registry = await window.electronAPI.lspGetRegistry();
    const errors = [];

    for (const conf of enabled) {
      try {
        console.log(`[file-panel] autoStartLsp: starting ${conf.serverKey}`);
        const result = await window.electronAPI.lspStartServer({
          groupId: group.id,
          rootDir: panel.rootDir,
          serverKey: conf.serverKey,
        });
        if (result.error) {
          console.warn(`[file-panel] autoStartLsp: ${conf.serverKey} failed: ${result.error}`);
          errors.push(`${conf.serverKey}: ${result.error}`);
          continue;
        }
        if (result.serverId) {
          console.log(`[file-panel] autoStartLsp: ${conf.serverKey} -> ${result.serverId}`);
          panelLspServerIds.push(result.serverId);
          activeLspServers.set(result.serverId, {
            groupId: group.id,
            serverKey: conf.serverKey,
          });
          const langs = registry[conf.serverKey]?.languages || ['python'];
          for (const lang of langs) {
            connectLspServer(result.serverId, conf.serverKey, lang);
          }
          // Send didOpen for already-open file (openFile ran before servers were ready)
          if (currentFilePath && currentEditor) {
            const fileLang = getLanguageFromPath(currentFilePath);
            console.log(`[file-panel] autoStartLsp: sending didOpen for ${currentFilePath} to ${result.serverId}`);
            lspDidOpen(result.serverId, currentFilePath, fileLang, currentEditor.getValue());
          }
        }
      } catch (e) {
        console.error(`[file-panel] autoStartLsp: ${conf.serverKey} exception:`, e);
        errors.push(`${conf.serverKey}: ${e.message}`);
      }
    }

    updateLspButton();

    if (errors.length > 0) {
      lspBtn.title = 'LSP errors:\n' + errors.join('\n');
      lspBtn.classList.add('lsp-error');
      // Show green if at least some servers started successfully
      if (panelLspServerIds.length > 0) {
        lspBtn.classList.remove('lsp-error');
        lspBtn.title = `${panelLspServerIds.length} server(s) running\nErrors:\n` + errors.join('\n');
      }
    }
  }

  autoStartLsp();

  // Internal sidebar resize
  let sidebarWidth = 220;
  resizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebar.offsetWidth;

    const onMove = (e) => {
      sidebarWidth = Math.max(120, Math.min(500, startW + (e.clientX - startX)));
      sidebar.style.width = sidebarWidth + 'px';
      if (currentEditor) currentEditor.layout();
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
