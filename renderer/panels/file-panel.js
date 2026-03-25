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

  // Search section
  const searchSection = document.createElement('div');
  searchSection.className = 'file-search-section';

  const searchRow = document.createElement('div');
  searchRow.className = 'file-search-row';

  const searchInput = document.createElement('input');
  searchInput.className = 'file-search-input';
  searchInput.type = 'text';
  searchInput.placeholder = 'Search files...';

  const searchModeBtn = document.createElement('button');
  searchModeBtn.className = 'file-search-mode-btn';
  searchModeBtn.textContent = 'aa';
  searchModeBtn.title = 'Search mode: case-insensitive';

  searchRow.appendChild(searchInput);
  searchRow.appendChild(searchModeBtn);

  const filterRow = document.createElement('div');
  filterRow.className = 'file-search-filter-row';

  const includeInput = document.createElement('input');
  includeInput.className = 'file-search-include';
  includeInput.type = 'text';
  includeInput.placeholder = 'Include *.js,*.ts';

  const excludeInput = document.createElement('input');
  excludeInput.className = 'file-search-exclude';
  excludeInput.type = 'text';
  excludeInput.placeholder = 'Exclude *.test.js';

  filterRow.appendChild(includeInput);
  filterRow.appendChild(excludeInput);

  const searchInfo = document.createElement('div');
  searchInfo.className = 'file-search-info';

  searchSection.appendChild(searchRow);
  searchSection.appendChild(filterRow);
  searchSection.appendChild(searchInfo);
  sidebar.appendChild(searchSection);

  const treeContainer = document.createElement('div');
  treeContainer.className = 'file-tree-entries';
  sidebar.appendChild(treeContainer);

  const searchResults = document.createElement('div');
  searchResults.className = 'file-search-results';
  searchResults.hidden = true;
  sidebar.appendChild(searchResults);

  // Internal resize handle
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'file-tree-resize-handle';

  // Right side - editor area
  const editorArea = document.createElement('div');
  editorArea.className = 'file-editor-area';

  const toolbar = document.createElement('div');
  toolbar.className = 'editor-toolbar';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'editor-save-btn';
  saveBtn.textContent = 'Save';
  saveBtn.disabled = true;

  const lspBtn = document.createElement('button');
  lspBtn.className = 'editor-lsp-btn';
  lspBtn.textContent = 'LSP';
  lspBtn.title = 'Language Server Settings';

  toolbar.appendChild(saveBtn);
  toolbar.appendChild(lspBtn);
  editorArea.appendChild(toolbar);

  const tabBar = document.createElement('div');
  tabBar.className = 'editor-tab-bar';
  editorArea.appendChild(tabBar);

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
  let cleanupDiagListener = null;

  function setDirty(dirty) {
    isDirty = dirty;
    saveBtn.disabled = !dirty;
    const activeTab = tabBar.querySelector('.editor-tab.active');
    if (activeTab) {
      const dot = activeTab.querySelector('.editor-tab-modified-dot');
      if (dot) dot.classList.toggle('visible', dirty);
    }
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
      applyTreeColors();
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

  const MAX_OPEN_TABS = 20;

  function renderTabs() {
    tabBar.innerHTML = '';
    const openFiles = panel.openFiles || [];

    openFiles.forEach(filePath => {
      const tab = document.createElement('div');
      tab.className = 'editor-tab';
      if (filePath === currentFilePath) {
        tab.classList.add('active');
      }
      tab.title = filePath;

      const tabDot = document.createElement('span');
      tabDot.className = 'editor-tab-modified-dot';
      if (filePath === currentFilePath && isDirty) {
        tabDot.classList.add('visible');
      }

      const tabName = document.createElement('span');
      tabName.className = 'editor-tab-name';
      tabName.textContent = filePath.split('/').pop();

      const tabClose = document.createElement('button');
      tabClose.className = 'editor-tab-close';
      tabClose.textContent = '\u00d7';
      tabClose.title = 'Close tab';
      tabClose.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(filePath);
      });

      tab.appendChild(tabDot);
      tab.appendChild(tabName);
      tab.appendChild(tabClose);

      tab.addEventListener('click', () => {
        if (filePath !== currentFilePath) {
          openFile(filePath);
        }
      });

      tab.addEventListener('mousedown', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          closeTab(filePath);
        }
      });

      tabBar.appendChild(tab);
    });
  }

  function closeTab(filePath) {
    if (!panel.openFiles) return;

    const idx = panel.openFiles.indexOf(filePath);
    if (idx === -1) return;

    if (filePath === currentFilePath) {
      if (isDirty) {
        const proceed = confirm(`"${filePath.split('/').pop()}" has unsaved changes. Discard?`);
        if (!proceed) return;
      }

      panel.openFiles.splice(idx, 1);

      if (panel.openFiles.length > 0) {
        const newIdx = Math.min(idx, panel.openFiles.length - 1);
        const newFile = panel.openFiles[newIdx];
        panel.openFile = newFile;
        saveState();
        openFile(newFile, true);
      } else {
        if (currentFilePath) {
          for (const sid of panelLspServerIds) {
            lspDidClose(sid, currentFilePath);
          }
        }
        currentFilePath = null;
        panel.openFile = null;
        setDirty(false);
        if (currentEditor) {
          currentEditor.setModel(null);
        }
        placeholder.style.display = '';
        placeholder.textContent = 'Select a file to edit';
        saveState();
        renderTabs();
      }
    } else {
      panel.openFiles.splice(idx, 1);
      if (window.monaco) {
        const uri = monaco.Uri.file(filePath);
        const model = monaco.editor.getModel(uri);
        if (model) model.dispose();
      }
      saveState();
      renderTabs();
    }
  }

  async function openFile(filePath, skipDirtyCheck) {
    if (isBinaryFile(filePath)) {
      if (currentEditor) {
        currentEditor.setValue('');
        currentEditor.updateOptions({ readOnly: true });
      }
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

    if (!skipDirtyCheck && isDirty && currentFilePath) {
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

    if (!panel.openFiles) panel.openFiles = [];
    if (!panel.openFiles.includes(filePath)) {
      panel.openFiles.push(filePath);
    }
    // Evict oldest non-active tabs if over limit
    while (panel.openFiles.length > MAX_OPEN_TABS) {
      const oldest = panel.openFiles[0];
      if (oldest !== filePath) {
        panel.openFiles.shift();
        if (window.monaco) {
          const uri = monaco.Uri.file(oldest);
          const m = monaco.editor.getModel(uri);
          if (m) m.dispose();
        }
      } else {
        break;
      }
    }
    panel.openFile = filePath;
    saveState();
    renderTabs();

    // Sync tree selection
    if (activeTreeItem) activeTreeItem.classList.remove('active');
    const treeItem = treeContainer.querySelector(`.tree-item[data-path="${CSS.escape(filePath)}"]`);
    if (treeItem) {
      treeItem.classList.add('active');
      activeTreeItem = treeItem;
    }

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
          if (cleanupDiagListener) cleanupDiagListener();
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

  // Initialize openFiles if missing (migration)
  if (!panel.openFiles) {
    panel.openFiles = panel.openFile ? [panel.openFile] : [];
  }
  renderTabs();

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
        item.dataset.path = dirPath + '/' + entry.name;
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
            applyTreeColors();
          }
        });
      } else {
        const fullPath = dirPath + '/' + entry.name;
        item.dataset.path = fullPath;
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

  // --- Tree coloring for git status & diagnostics ---

  async function applyTreeColors() {
    if (!panel.rootDir) return;

    const gitResult = await window.electronAPI.gitStatus(panel.rootDir);
    const gitFiles = gitResult.files || {};
    const errorMap = getFileErrorMap();

    const allItems = treeContainer.querySelectorAll('.tree-item');
    for (const item of allItems) {
      item.classList.remove('git-modified', 'git-new', 'has-errors');
    }

    // Color file items
    for (const item of allItems) {
      const p = item.dataset.path;
      if (!p) continue;

      if (item.classList.contains('tree-file')) {
        const hasError = errorMap.has(p);
        const gitStatus = gitFiles[p];

        if (hasError) {
          item.classList.add('has-errors');
        } else if (gitStatus === 'modified') {
          item.classList.add('git-modified');
        } else if (gitStatus === 'new') {
          item.classList.add('git-new');
        }
      }
    }

    // Propagate to parent directories
    // For each colored file, walk up through tree-children -> tree-directory
    for (const item of allItems) {
      if (!item.classList.contains('tree-file')) continue;
      if (!item.classList.contains('git-modified') && !item.classList.contains('git-new') && !item.classList.contains('has-errors')) continue;

      let el = item.parentElement;
      while (el && el !== treeContainer) {
        if (el.classList.contains('tree-children')) {
          // The directory item is the previous sibling
          const dirItem = el.previousElementSibling;
          if (dirItem && dirItem.classList.contains('tree-directory')) {
            // Apply highest priority: has-errors > git-modified > git-new
            if (item.classList.contains('has-errors')) {
              dirItem.classList.remove('git-modified', 'git-new');
              dirItem.classList.add('has-errors');
            } else if (item.classList.contains('git-modified') && !dirItem.classList.contains('has-errors')) {
              dirItem.classList.remove('git-new');
              dirItem.classList.add('git-modified');
            } else if (item.classList.contains('git-new') && !dirItem.classList.contains('has-errors') && !dirItem.classList.contains('git-modified')) {
              dirItem.classList.add('git-new');
            }
          }
        }
        el = el.parentElement;
      }
    }

    // Color directories whose children haven't been loaded yet
    for (const [absPath, status] of Object.entries(gitFiles)) {
      if (status === 'deleted') continue;
      // Find directory items that are ancestors of this path
      const dirItems = treeContainer.querySelectorAll('.tree-item.tree-directory');
      for (const dirItem of dirItems) {
        const dirPath = dirItem.dataset.path;
        if (!dirPath) continue;
        if (absPath.startsWith(dirPath + '/')) {
          if (status === 'modified' && !dirItem.classList.contains('has-errors')) {
            dirItem.classList.remove('git-new');
            dirItem.classList.add('git-modified');
          } else if (status === 'new' && !dirItem.classList.contains('has-errors') && !dirItem.classList.contains('git-modified')) {
            dirItem.classList.add('git-new');
          }
        }
      }
    }

    // Also propagate errors for unloaded directories
    for (const [filePath] of errorMap) {
      const dirItems = treeContainer.querySelectorAll('.tree-item.tree-directory');
      for (const dirItem of dirItems) {
        const dirPath = dirItem.dataset.path;
        if (!dirPath) continue;
        if (filePath.startsWith(dirPath + '/')) {
          dirItem.classList.remove('git-modified', 'git-new');
          dirItem.classList.add('has-errors');
        }
      }
    }
  }

  let applyTreeColorsTimer = null;
  function scheduleApplyTreeColors() {
    clearTimeout(applyTreeColorsTimer);
    applyTreeColorsTimer = setTimeout(applyTreeColors, 200);
  }

  if (panel.rootDir) {
    loadTreeEntries(panel.rootDir, treeContainer, 0).then(() => applyTreeColors());
  }

  // --- File search ---

  let cachedFileList = null;
  let isFileListLoading = false;
  let searchDebounceTimer = null;
  let currentSearchMode = 'loose'; // 'loose' | 'strict' | 'regex'
  let isSearchActive = false;

  function updateModeButton() {
    searchModeBtn.classList.remove('mode-strict', 'mode-regex');
    if (currentSearchMode === 'loose') {
      searchModeBtn.textContent = 'aa';
      searchModeBtn.title = 'Search mode: case-insensitive';
    } else if (currentSearchMode === 'strict') {
      searchModeBtn.textContent = 'Aa';
      searchModeBtn.title = 'Search mode: case-sensitive';
      searchModeBtn.classList.add('mode-strict');
    } else {
      searchModeBtn.textContent = '.*';
      searchModeBtn.title = 'Search mode: regex';
      searchModeBtn.classList.add('mode-regex');
    }
  }

  searchModeBtn.addEventListener('click', () => {
    if (currentSearchMode === 'loose') currentSearchMode = 'strict';
    else if (currentSearchMode === 'strict') currentSearchMode = 'regex';
    else currentSearchMode = 'loose';
    updateModeButton();
    scheduleSearch();
  });

  async function ensureFileList() {
    if (cachedFileList) return cachedFileList;
    if (isFileListLoading) return null;
    isFileListLoading = true;
    searchInfo.textContent = 'Scanning...';
    const result = await window.electronAPI.scanDirectory(panel.rootDir);
    isFileListLoading = false;
    if (result.error) {
      searchInfo.textContent = 'Scan failed';
      return null;
    }
    cachedFileList = result.files;
    if (result.truncated) {
      searchInfo.textContent = `${result.files.length}+ files (truncated)`;
    }
    return cachedFileList;
  }

  function parseGlobPatterns(input) {
    if (!input.trim()) return [];
    return input.split(',').map(p => p.trim()).filter(Boolean).map(pattern => {
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
                             .replace(/\*/g, '.*')
                             .replace(/\?/g, '.');
      return new RegExp('^' + escaped + '$', 'i');
    });
  }

  function showSearchResults(results) {
    isSearchActive = true;
    treeContainer.hidden = true;
    searchResults.hidden = false;
    searchResults.innerHTML = '';

    const MAX_DISPLAY = 500;
    const displayResults = results.slice(0, MAX_DISPLAY);

    searchInfo.textContent = results.length > MAX_DISPLAY
      ? `${results.length} matches (showing ${MAX_DISPLAY})`
      : `${results.length} match${results.length !== 1 ? 'es' : ''}`;

    displayResults.forEach(fullPath => {
      const item = document.createElement('div');
      item.className = 'tree-item tree-file file-search-result-item';

      const relPath = fullPath.substring(panel.rootDir.length + 1);
      const fileName = relPath.split('/').pop();
      const dirPath = relPath.substring(0, relPath.length - fileName.length);

      const nameSpan = document.createElement('span');
      nameSpan.className = 'tree-name';
      nameSpan.textContent = fileName;

      const pathSpan = document.createElement('span');
      pathSpan.className = 'file-search-result-path';
      pathSpan.textContent = dirPath;

      item.appendChild(nameSpan);
      item.appendChild(pathSpan);
      item.title = fullPath;

      item.addEventListener('click', () => {
        if (activeTreeItem) activeTreeItem.classList.remove('active');
        item.classList.add('active');
        activeTreeItem = item;
        openFile(fullPath);
      });

      searchResults.appendChild(item);
    });
  }

  function exitSearch() {
    isSearchActive = false;
    treeContainer.hidden = false;
    searchResults.hidden = true;
    searchResults.innerHTML = '';
    searchInfo.textContent = '';
  }

  async function executeSearch() {
    const query = searchInput.value.trim();
    if (!query && !includeInput.value.trim() && !excludeInput.value.trim()) {
      exitSearch();
      return;
    }

    if (!panel.rootDir) return;

    const files = await ensureFileList();
    if (!files) return;

    // Build matcher based on mode
    let matcher;
    if (!query) {
      matcher = () => true;
    } else if (currentSearchMode === 'strict') {
      matcher = (relPath) => relPath.includes(query);
    } else if (currentSearchMode === 'loose') {
      const lowerQ = query.toLowerCase();
      matcher = (relPath) => relPath.toLowerCase().includes(lowerQ);
    } else {
      try {
        const re = new RegExp(query);
        matcher = (relPath) => re.test(relPath);
      } catch (e) {
        searchInfo.textContent = 'Invalid regex';
        return;
      }
    }

    const includePatterns = parseGlobPatterns(includeInput.value);
    const excludePatterns = parseGlobPatterns(excludeInput.value);

    const results = files.filter(fullPath => {
      const relPath = fullPath.substring(panel.rootDir.length + 1);
      const fileName = relPath.split('/').pop();

      if (includePatterns.length > 0) {
        if (!includePatterns.some(re => re.test(fileName))) return false;
      }
      if (excludePatterns.length > 0) {
        if (excludePatterns.some(re => re.test(fileName))) return false;
      }

      return matcher(relPath);
    });

    showSearchResults(results);
  }

  function scheduleSearch() {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(executeSearch, 200);
  }

  searchInput.addEventListener('input', scheduleSearch);
  includeInput.addEventListener('input', scheduleSearch);
  excludeInput.addEventListener('input', scheduleSearch);

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      includeInput.value = '';
      excludeInput.value = '';
      exitSearch();
    }
  });

  refreshBtn.addEventListener('click', () => {
    searchInput.value = '';
    includeInput.value = '';
    excludeInput.value = '';
    cachedFileList = null;
    exitSearch();

    treeContainer.innerHTML = '';
    if (panel.rootDir) {
      loadTreeEntries(panel.rootDir, treeContainer, 0).then(() => applyTreeColors());
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

  // Register diagnostic change listener for tree coloring
  cleanupDiagListener = onDiagnosticChange(scheduleApplyTreeColors);

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
