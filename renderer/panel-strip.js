// panel-strip.js - Panel strip and resize handles with group DOM caching

function renderPanelStrip(scrollToEnd = true) {
  const strip = document.getElementById('panel-strip');
  const group = getActiveGroup();
  if (!group) return;

  // Hide all cached group containers
  groupDOMCache.forEach(container => {
    container.hidden = true;
  });

  // Check for cache hit
  const cached = getCachedContainer(group.id);
  if (cached) {
    console.log(`[PanelStrip] Cache HIT - reusing DOM for group=${group.id}`);
    cached.hidden = false;
    touchLRU(group.id);
    requestAnimationFrame(() => fitVisibleTerminals(group.id));
    renderStatusBar();
    return;
  }

  // Cache miss - build fresh
  console.log(`[PanelStrip] Cache MISS - building fresh DOM for group=${group.id}`);
  const wrapper = document.createElement('div');
  wrapper.className = 'group-container';
  wrapper.dataset.groupId = group.id;

  if (group.panels.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';

    const title = document.createElement('div');
    title.className = 'empty-state-title';
    title.textContent = 'No panels yet';

    const actions = document.createElement('div');
    actions.className = 'empty-state-actions';

    const webBtn = document.createElement('button');
    webBtn.className = 'add-panel-btn';
    webBtn.textContent = '+ Web Panel';
    webBtn.addEventListener('click', () => addPanel('web'));

    const termBtn = document.createElement('button');
    termBtn.className = 'add-panel-btn';
    termBtn.textContent = '+ Terminal';
    termBtn.addEventListener('click', () => addPanel('terminal'));

    const fileBtn = document.createElement('button');
    fileBtn.className = 'add-panel-btn';
    fileBtn.textContent = '+ Files';
    fileBtn.addEventListener('click', () => addPanel('file'));

    actions.appendChild(webBtn);
    actions.appendChild(termBtn);
    actions.appendChild(fileBtn);
    empty.appendChild(title);
    empty.appendChild(actions);
    wrapper.appendChild(empty);
  } else {
    group.panels.forEach((panel) => {
      wrapper.appendChild(createPanelElement(panel));
      wrapper.appendChild(createResizeHandle(panel.id));
    });

    const addControls = document.createElement('div');
    addControls.className = 'add-panel-controls';

    const webBtn = document.createElement('button');
    webBtn.className = 'add-panel-btn';
    webBtn.textContent = '+ Web';
    webBtn.addEventListener('click', () => addPanel('web'));

    const termBtn = document.createElement('button');
    termBtn.className = 'add-panel-btn';
    termBtn.textContent = '+ Terminal';
    termBtn.addEventListener('click', () => addPanel('terminal'));

    const fileBtn = document.createElement('button');
    fileBtn.className = 'add-panel-btn';
    fileBtn.textContent = '+ Files';
    fileBtn.addEventListener('click', () => addPanel('file'));

    addControls.appendChild(webBtn);
    addControls.appendChild(termBtn);
    addControls.appendChild(fileBtn);
    wrapper.appendChild(addControls);
  }

  strip.appendChild(wrapper);
  cacheContainer(group.id, wrapper);
  touchLRU(group.id);
  evictLRU();

  renderStatusBar();

  // Scroll to the rightmost panel after adding
  requestAnimationFrame(() => {
    strip.scrollLeft = scrollToEnd ? strip.scrollWidth : 0;
  });
}

function createPanelElement(panel) {
  const el = document.createElement('div');
  el.className = 'panel';
  el.dataset.panelId = panel.id;
  el.style.width = panel.width + 'px';

  const header = document.createElement('div');
  header.className = 'panel-header';

  const typeLabel = document.createElement('span');
  typeLabel.className = 'panel-type-label';
  typeLabel.textContent = panel.type === 'web' ? 'Web' : panel.type === 'file' ? 'Files' : 'Terminal';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'panel-close-btn';
  closeBtn.textContent = '\u00d7';
  closeBtn.addEventListener('click', () => removePanel(panel.id));

  header.appendChild(typeLabel);
  header.appendChild(closeBtn);
  el.appendChild(header);

  const content = document.createElement('div');
  content.className = 'panel-content';

  if (panel.type === 'web') {
    renderWebPanel(panel, content);
  } else if (panel.type === 'file') {
    renderFilePanel(panel, content);
  } else {
    renderTermPanel(panel, content);
  }

  el.appendChild(content);
  initPanelDrag(el);
  return el;
}

function createResizeHandle(panelId) {
  const handle = document.createElement('div');
  handle.className = 'resize-handle';

  let startX = 0;
  let startWidth = 0;

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    startX = e.clientX;

    const group = getActiveGroup();
    const panel = group.panels.find(p => p.id === panelId);
    if (!panel) return;
    startWidth = panel.width;

    handle.classList.add('active');

    const onMove = e => {
      const newWidth = Math.max(300, startWidth + (e.clientX - startX));
      updatePanelWidth(panelId, newWidth);

      const container = getCachedContainer(state.activeGroupId);
      const panelEl = container
        ? container.querySelector(`[data-panel-id="${panelId}"]`)
        : document.querySelector(`[data-panel-id="${panelId}"]`);
      if (panelEl) panelEl.style.width = newWidth + 'px';

      if (activeTerminals.has(panelId)) {
        const { fitAddon } = activeTerminals.get(panelId);
        if (fitAddon) {
          try { fitAddon.fit(); } catch (e) {}
        }
      }
      if (activeEditors.has(panelId)) {
        const { editor } = activeEditors.get(panelId);
        if (editor) {
          try { editor.layout(); } catch (e) {}
        }
      }
    };

    const onUp = () => {
      handle.classList.remove('active');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      saveState();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  return handle;
}
