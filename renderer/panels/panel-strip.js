// panel-strip.js - Panel strip and resize handles with group DOM caching

const RESIZE_AUTO_SCROLL_EDGE_PX = 60;
const RESIZE_AUTO_SCROLL_MAX_SPEED = 15;
let resizeAutoScrollRafId = null;

function stopResizeAutoScroll() {
  if (resizeAutoScrollRafId != null) {
    cancelAnimationFrame(resizeAutoScrollRafId);
    resizeAutoScrollRafId = null;
  }
}

// Clear focus when clicking empty area of the panel strip
document.addEventListener('DOMContentLoaded', () => {
  const strip = document.getElementById('panel-strip');
  if (strip) {
    strip.addEventListener('mousedown', e => {
      if (!e.target.closest('.panel')) {
        setFocusedPanel(null);
      }
    });
  }
});

function createAddPanelControls() {
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

  const debugBtn = document.createElement('button');
  debugBtn.className = 'add-panel-btn';
  debugBtn.textContent = '+ Debug';
  debugBtn.addEventListener('click', () => addPanel('debug'));

  addControls.appendChild(webBtn);
  addControls.appendChild(termBtn);
  addControls.appendChild(fileBtn);
  addControls.appendChild(debugBtn);
  return addControls;
}

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
    requestAnimationFrame(() => {
      fitVisibleTerminals(group.id);
      layoutVisibleEditors(group.id);
    });
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

    const debugBtn = document.createElement('button');
    debugBtn.className = 'add-panel-btn';
    debugBtn.textContent = '+ Debug';
    debugBtn.addEventListener('click', () => addPanel('debug'));

    actions.appendChild(webBtn);
    actions.appendChild(termBtn);
    actions.appendChild(fileBtn);
    actions.appendChild(debugBtn);
    empty.appendChild(title);
    empty.appendChild(actions);
    wrapper.appendChild(empty);
  } else {
    group.panels.forEach((panel) => {
      wrapper.appendChild(createPanelElement(panel));
      wrapper.appendChild(createResizeHandle(panel.id));
    });

    wrapper.appendChild(createAddPanelControls());
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
  typeLabel.textContent = panel.type === 'web' ? 'Web' : panel.type === 'file' ? 'Files' : panel.type === 'debug' ? 'Debug' : 'Terminal';

  const moveBtn = document.createElement('button');
  moveBtn.className = 'panel-move-btn';
  moveBtn.textContent = '\u21c4';
  moveBtn.title = 'Move to another workspace';
  moveBtn.addEventListener('click', e => {
    e.stopPropagation();
    showPanelMoveMenu(panel.id, moveBtn);
  });

  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'panel-settings-btn';
  settingsBtn.textContent = '\u2699';
  settingsBtn.title = 'Panel settings';
  settingsBtn.addEventListener('click', e => {
    e.stopPropagation();
    showPanelSettingsModal(panel);
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'panel-close-btn';
  closeBtn.textContent = '\u00d7';
  closeBtn.addEventListener('click', () => removePanel(panel.id));

  header.appendChild(typeLabel);
  header.appendChild(moveBtn);
  header.appendChild(settingsBtn);
  header.appendChild(closeBtn);
  el.appendChild(header);

  const content = document.createElement('div');
  content.className = 'panel-content';

  if (panel.type === 'web') {
    renderWebPanel(panel, content);
  } else if (panel.type === 'file') {
    renderFilePanel(panel, content);
  } else if (panel.type === 'debug') {
    renderDebugPanel(panel, content);
  } else {
    renderTermPanel(panel, content);
  }

  el.appendChild(content);

  // Focus tracking: clicking a panel focuses it
  el.addEventListener('mousedown', e => {
    // Don't steal focus when clicking header action buttons
    if (e.target.closest('.panel-close-btn') || e.target.closest('.panel-settings-btn') || e.target.closest('.panel-move-btn')) return;
    setFocusedPanel(panel.id);
  });

  initPanelDrag(el);
  return el;
}

// ── Panel move-to-workspace menu ──────────────────
let activePanelMoveMenu = null;

function closePanelMoveMenu() {
  if (!activePanelMoveMenu) return;
  document.removeEventListener('keydown', activePanelMoveMenu.onKeyDown, true);
  activePanelMoveMenu.backdrop.remove();
  activePanelMoveMenu.menu.remove();
  activePanelMoveMenu = null;
}

function showPanelMoveMenu(panelId, anchorBtn) {
  if (activePanelMoveMenu && activePanelMoveMenu.panelId === panelId) {
    closePanelMoveMenu();
    return;
  }
  closePanelMoveMenu();

  const profile = getActiveProfile();
  if (!profile) return;
  const currentGroup = findGroupByPanelId(panelId);
  if (!currentGroup) return;

  const otherGroups = profile.groups.filter(g => g.id !== currentGroup.id);

  // Transparent backdrop catches clicks anywhere outside, including over <webview>
  const backdrop = document.createElement('div');
  backdrop.className = 'panel-move-backdrop';
  backdrop.addEventListener('mousedown', e => {
    e.stopPropagation();
    closePanelMoveMenu();
  });

  const menu = document.createElement('div');
  menu.className = 'panel-move-menu';

  const menuHeader = document.createElement('div');
  menuHeader.className = 'panel-move-menu-header';
  menuHeader.textContent = 'Move to workspace';
  menu.appendChild(menuHeader);

  const list = document.createElement('div');
  list.className = 'panel-move-list';

  if (otherGroups.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'panel-move-empty';
    empty.textContent = 'No other workspaces';
    list.appendChild(empty);
  } else {
    otherGroups.forEach(group => {
      const item = document.createElement('div');
      item.className = 'panel-move-item';
      item.dataset.targetGroupId = group.id;

      const label = document.createElement('span');
      label.className = 'panel-move-item-label';
      label.textContent = group.label;

      const count = document.createElement('span');
      count.className = 'panel-move-item-count';
      count.textContent = group.panels.length;

      const switchBtn = document.createElement('button');
      switchBtn.className = 'panel-move-switch-btn';
      switchBtn.textContent = '\u2197';
      switchBtn.title = 'Move and switch to workspace';
      switchBtn.addEventListener('click', e => {
        e.stopPropagation();
        closePanelMoveMenu();
        movePanelToGroup(panelId, group.id, { switchToTarget: true });
      });

      item.appendChild(label);
      item.appendChild(count);
      item.appendChild(switchBtn);

      item.addEventListener('click', e => {
        e.stopPropagation();
        closePanelMoveMenu();
        movePanelToGroup(panelId, group.id, { switchToTarget: e.metaKey || e.ctrlKey });
      });

      list.appendChild(item);
    });
  }

  menu.appendChild(list);

  const divider = document.createElement('div');
  divider.className = 'panel-move-divider';
  menu.appendChild(divider);

  const newItem = document.createElement('div');
  newItem.className = 'panel-move-item panel-move-new';

  const newLabel = document.createElement('span');
  newLabel.className = 'panel-move-item-label';
  newLabel.textContent = '+ New Workspace';

  const newSwitchBtn = document.createElement('button');
  newSwitchBtn.className = 'panel-move-switch-btn';
  newSwitchBtn.textContent = '\u2197';
  newSwitchBtn.title = 'Move to new workspace and switch';
  newSwitchBtn.addEventListener('click', e => {
    e.stopPropagation();
    closePanelMoveMenu();
    movePanelToNewGroup(panelId, { switchToTarget: true });
  });

  newItem.appendChild(newLabel);
  newItem.appendChild(newSwitchBtn);
  newItem.addEventListener('click', e => {
    e.stopPropagation();
    closePanelMoveMenu();
    movePanelToNewGroup(panelId, { switchToTarget: e.metaKey || e.ctrlKey });
  });
  menu.appendChild(newItem);

  const onKeyDown = e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePanelMoveMenu();
    }
  };
  document.addEventListener('keydown', onKeyDown, true);

  document.body.appendChild(backdrop);
  document.body.appendChild(menu);

  // Position menu anchored below anchorBtn, clamped within viewport
  const btnRect = anchorBtn.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const margin = 8;
  let left = btnRect.right - menuRect.width;
  if (left < margin) left = margin;
  if (left + menuRect.width > window.innerWidth - margin) {
    left = window.innerWidth - menuRect.width - margin;
  }
  let top = btnRect.bottom + 4;
  if (top + menuRect.height > window.innerHeight - margin) {
    top = Math.max(margin, btnRect.top - menuRect.height - 4);
  }
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  activePanelMoveMenu = { panelId, backdrop, menu, onKeyDown };
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
    document.body.classList.add('resizing');

    let latestWidth = startWidth;
    let rafId = null;
    let accumulatedScrollDelta = 0;
    let lastClientX = e.clientX;
    const strip = document.getElementById('panel-strip');

    const applyDOM = () => {
      const container = getCachedContainer(getActiveGroupId());
      const panelEl = container
        ? container.querySelector(`[data-panel-id="${panelId}"]`)
        : document.querySelector(`[data-panel-id="${panelId}"]`);
      if (panelEl) panelEl.style.width = latestWidth + 'px';

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
      rafId = null;
    };

    function resizeAutoScrollTick() {
      if (!strip) { stopResizeAutoScroll(); return; }
      const rect = strip.getBoundingClientRect();
      let scrollDelta = 0;

      if (lastClientX > rect.right - RESIZE_AUTO_SCROLL_EDGE_PX) {
        const depth = lastClientX - (rect.right - RESIZE_AUTO_SCROLL_EDGE_PX);
        scrollDelta = (depth / RESIZE_AUTO_SCROLL_EDGE_PX) * RESIZE_AUTO_SCROLL_MAX_SPEED;
      }

      if (scrollDelta > 0) {
        const oldScrollLeft = strip.scrollLeft;
        const maxScroll = strip.scrollWidth - strip.clientWidth;
        strip.scrollLeft = Math.min(maxScroll, oldScrollLeft + scrollDelta);
        const actualDelta = strip.scrollLeft - oldScrollLeft;
        if (actualDelta > 0) {
          accumulatedScrollDelta += actualDelta;
          latestWidth = Math.max(300, startWidth + (lastClientX - startX) + accumulatedScrollDelta);
          updatePanelWidth(panelId, latestWidth);
          if (!rafId) rafId = requestAnimationFrame(applyDOM);
        }
      }
      resizeAutoScrollRafId = requestAnimationFrame(resizeAutoScrollTick);
    }

    resizeAutoScrollRafId = requestAnimationFrame(resizeAutoScrollTick);

    const onMove = e => {
      lastClientX = e.clientX;
      latestWidth = Math.max(300, startWidth + (e.clientX - startX) + accumulatedScrollDelta);
      updatePanelWidth(panelId, latestWidth);

      if (!rafId) {
        rafId = requestAnimationFrame(applyDOM);
      }
    };

    const onUp = () => {
      stopResizeAutoScroll();
      handle.classList.remove('active');
      document.body.classList.remove('resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      applyDOM();
      saveState();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  handle.addEventListener('dblclick', e => {
    e.preventDefault();
    const group = getActiveGroup();
    const panel = group.panels.find(p => p.id === panelId);
    if (!panel) return;

    const strip = document.getElementById('panel-strip');
    const maxWidth = strip.clientWidth - 40;
    const newWidth = Math.min(panel.width * 2, maxWidth);
    updatePanelWidth(panelId, newWidth);

    const container = getCachedContainer(getActiveGroupId());
    const panelEl = container
      ? container.querySelector(`[data-panel-id="${panelId}"]`)
      : document.querySelector(`[data-panel-id="${panelId}"]`);
    if (panelEl) {
      panelEl.style.width = newWidth + 'px';
      panelEl.scrollIntoView({ behavior: 'smooth', inline: 'nearest' });
    }

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

    saveState();
  });

  return handle;
}
