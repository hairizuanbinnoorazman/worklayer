// panel-drag.js - Drag-and-drop reordering for panels and cross-workspace moves

const DRAG_THRESHOLD = 8;
const AUTO_SCROLL_EDGE_PX = 60;
const AUTO_SCROLL_MAX_SPEED = 15;
const SIDEBAR_AUTO_SCROLL_EDGE_PX = 40;
const SIDEBAR_AUTO_SCROLL_MAX_SPEED = 10;

let dragState = null;
let autoScrollRafId = null;

function clearSidebarDropTarget() {
  if (!dragState) return;
  if (dragState.targetEl) {
    dragState.targetEl.classList.remove('panel-drop-target');
    dragState.targetEl = null;
  }
  dragState.targetGroupId = null;
  dragState.targetNewGroup = false;
}

function updateDragBadge(text, clientX, clientY) {
  if (!dragState) return;
  if (!text) {
    if (dragState.badgeEl) dragState.badgeEl.style.display = 'none';
    return;
  }
  if (!dragState.badgeEl) {
    const badge = document.createElement('div');
    badge.className = 'panel-drag-badge';
    document.body.appendChild(badge);
    dragState.badgeEl = badge;
  }
  dragState.badgeEl.textContent = text;
  dragState.badgeEl.style.display = 'block';
  const rect = dragState.badgeEl.getBoundingClientRect();
  const left = Math.min(window.innerWidth - rect.width - 8, clientX + 14);
  const top = Math.min(window.innerHeight - rect.height - 8, clientY + 14);
  dragState.badgeEl.style.left = Math.max(8, left) + 'px';
  dragState.badgeEl.style.top = Math.max(8, top) + 'px';
}

function cleanupPanelDrag() {
  stopAutoScroll();
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);
  document.removeEventListener('keydown', onDragKeyDown, true);
  window.removeEventListener('blur', cleanupPanelDrag);
  document.body.classList.remove('dragging-panel');

  if (!dragState) return;
  clearSidebarDropTarget();
  if (dragState.started) {
    dragState.panelEl.classList.remove('dragging');
    if (dragState.indicator) {
      dragState.indicator.remove();
    }
  }
  if (dragState.badgeEl) {
    dragState.badgeEl.remove();
  }
  dragState = null;
}

function onDragKeyDown(e) {
  if (e.key === 'Escape' && dragState) {
    e.preventDefault();
    cleanupPanelDrag();
  }
}

function initPanelDrag(panelEl) {
  const header = panelEl.querySelector('.panel-header');
  if (!header) return;

  header.addEventListener('mousedown', e => {
    if (e.target.closest('.panel-close-btn') || e.target.closest('.panel-settings-btn') || e.target.closest('.panel-move-btn')) return;
    if (e.button !== 0) return;
    e.preventDefault();

    if (typeof closePanelMoveMenu === 'function') closePanelMoveMenu();

    // Clean up any in-progress drag before starting a new one
    if (dragState) {
      cleanupPanelDrag();
    }

    dragState = {
      panelEl,
      startX: e.clientX,
      startY: e.clientY,
      lastClientX: e.clientX,
      lastClientY: e.clientY,
      started: false,
      indicator: null,
      overSidebar: false,
      targetGroupId: null,
      targetNewGroup: false,
      targetEl: null,
      badgeEl: null,
    };
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
    document.addEventListener('keydown', onDragKeyDown, true);
    window.addEventListener('blur', cleanupPanelDrag);
  });
}

function onDragMove(e) {
  if (!dragState) return;

  dragState.lastClientX = e.clientX;
  dragState.lastClientY = e.clientY;

  if (!dragState.started) {
    if (Math.hypot(e.clientX - dragState.startX, e.clientY - dragState.startY) < DRAG_THRESHOLD) return;
    dragState.started = true;
    dragState.panelEl.classList.add('dragging');
    document.body.classList.add('dragging-panel');

    const indicator = document.createElement('div');
    indicator.className = 'drop-indicator';
    dragState.indicator = indicator;
    const container = getCachedContainer(getActiveGroupId());
    (container || document.getElementById('panel-strip')).appendChild(indicator);

    startAutoScroll();
  }

  updateSidebarDropTarget();
  if (!dragState.overSidebar) {
    updateDropIndicator();
  }
}

function updateSidebarDropTarget() {
  if (!dragState || !dragState.started) return;

  const sidebar = document.getElementById('sidebar');
  if (!sidebar) {
    dragState.overSidebar = false;
    clearSidebarDropTarget();
    updateDragBadge(null);
    return;
  }

  const x = dragState.lastClientX;
  const y = dragState.lastClientY;
  const sidebarRect = sidebar.getBoundingClientRect();
  const isOverSidebar = x >= sidebarRect.left && x <= sidebarRect.right &&
    y >= sidebarRect.top && y <= sidebarRect.bottom;

  dragState.overSidebar = isOverSidebar;

  if (!isOverSidebar) {
    clearSidebarDropTarget();
    updateDragBadge(null);
    return;
  }

  // Hide panel-strip drop indicator while hovering over sidebar
  if (dragState.indicator) {
    dragState.indicator.style.display = 'none';
  }

  const activeGroupId = getActiveGroupId();
  let matchedEl = null;
  let matchedGroupId = null;
  let matchedNewGroup = false;
  let badgeText = null;

  const list = sidebar.querySelector('.group-list');
  if (list) {
    const listRect = list.getBoundingClientRect();
    if (y >= listRect.top && y <= listRect.bottom) {
      const items = list.querySelectorAll('.group-item');
      for (const item of items) {
        const rect = item.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          const gid = item.dataset.groupId;
          if (gid && gid !== activeGroupId) {
            matchedEl = item;
            matchedGroupId = gid;
            const labelEl = item.querySelector('.group-label');
            badgeText = `Move to ${labelEl ? labelEl.textContent : 'workspace'}`;
          }
          break;
        }
      }
    }
  }

  if (!matchedEl) {
    const addBtn = sidebar.querySelector('.add-group-btn');
    if (addBtn) {
      const rect = addBtn.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        matchedEl = addBtn;
        matchedNewGroup = true;
        badgeText = 'Move to New Workspace';
      }
    }
  }

  if (dragState.targetEl !== matchedEl) {
    clearSidebarDropTarget();
    if (matchedEl) {
      matchedEl.classList.add('panel-drop-target');
      dragState.targetEl = matchedEl;
    }
  }

  dragState.targetGroupId = matchedGroupId;
  dragState.targetNewGroup = matchedNewGroup;
  updateDragBadge(badgeText, x, y);
}

function updateDropIndicator() {
  if (!dragState || !dragState.started || dragState.overSidebar) return;

  const container = getCachedContainer(getActiveGroupId());
  const scope = container || document.getElementById('panel-strip');
  const panels = Array.from(scope.querySelectorAll('.panel:not(.dragging)'));

  let insertBeforeEl = null;
  for (const panel of panels) {
    const rect = panel.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    if (dragState.lastClientX < midX) {
      insertBeforeEl = panel;
      break;
    }
  }

  // Position the indicator
  if (insertBeforeEl) {
    const rect = insertBeforeEl.getBoundingClientRect();
    const scopeRect = scope.getBoundingClientRect();
    dragState.indicator.style.left = (rect.left - scopeRect.left + scope.scrollLeft - 2) + 'px';
    dragState.indicator.style.display = 'block';
  } else if (panels.length > 0) {
    const lastPanel = panels[panels.length - 1];
    const rect = lastPanel.getBoundingClientRect();
    const scopeRect = scope.getBoundingClientRect();
    dragState.indicator.style.left = (rect.right - scopeRect.left + scope.scrollLeft - 1) + 'px';
    dragState.indicator.style.display = 'block';
  }

  dragState.insertBeforeEl = insertBeforeEl;
}

function startAutoScroll() {
  if (autoScrollRafId != null) return;

  function tick() {
    if (!dragState || !dragState.started) { stopAutoScroll(); return; }

    if (dragState.overSidebar) {
      const list = document.querySelector('#sidebar .group-list');
      if (list) {
        const rect = list.getBoundingClientRect();
        const y = dragState.lastClientY;
        let delta = 0;
        if (y >= rect.top && y < rect.top + SIDEBAR_AUTO_SCROLL_EDGE_PX) {
          const depth = rect.top + SIDEBAR_AUTO_SCROLL_EDGE_PX - y;
          delta = -(depth / SIDEBAR_AUTO_SCROLL_EDGE_PX) * SIDEBAR_AUTO_SCROLL_MAX_SPEED;
        } else if (y <= rect.bottom && y > rect.bottom - SIDEBAR_AUTO_SCROLL_EDGE_PX) {
          const depth = y - (rect.bottom - SIDEBAR_AUTO_SCROLL_EDGE_PX);
          delta = (depth / SIDEBAR_AUTO_SCROLL_EDGE_PX) * SIDEBAR_AUTO_SCROLL_MAX_SPEED;
        }
        if (delta !== 0) {
          const maxScroll = list.scrollHeight - list.clientHeight;
          list.scrollTop = Math.max(0, Math.min(maxScroll, list.scrollTop + delta));
          updateSidebarDropTarget();
        }
      }
      autoScrollRafId = requestAnimationFrame(tick);
      return;
    }

    const strip = document.getElementById('panel-strip');
    const rect = strip.getBoundingClientRect();
    const x = dragState.lastClientX;
    let delta = 0;

    if (x < rect.left + AUTO_SCROLL_EDGE_PX) {
      const depth = rect.left + AUTO_SCROLL_EDGE_PX - x;
      delta = -(depth / AUTO_SCROLL_EDGE_PX) * AUTO_SCROLL_MAX_SPEED;
    } else if (x > rect.right - AUTO_SCROLL_EDGE_PX) {
      const depth = x - (rect.right - AUTO_SCROLL_EDGE_PX);
      delta = (depth / AUTO_SCROLL_EDGE_PX) * AUTO_SCROLL_MAX_SPEED;
    }

    if (delta !== 0) {
      const maxScroll = strip.scrollWidth - strip.clientWidth;
      strip.scrollLeft = Math.max(0, Math.min(maxScroll, strip.scrollLeft + delta));
      updateDropIndicator();
    }

    autoScrollRafId = requestAnimationFrame(tick);
  }

  autoScrollRafId = requestAnimationFrame(tick);
}

function stopAutoScroll() {
  if (autoScrollRafId != null) {
    cancelAnimationFrame(autoScrollRafId);
    autoScrollRafId = null;
  }
}

function onDragEnd() {
  if (!dragState) {
    cleanupPanelDrag();
    return;
  }

  const stateSnapshot = {
    started: dragState.started,
    panelEl: dragState.panelEl,
    overSidebar: dragState.overSidebar,
    targetGroupId: dragState.targetGroupId,
    targetNewGroup: dragState.targetNewGroup,
    insertBeforeEl: dragState.insertBeforeEl,
  };

  cleanupPanelDrag();

  if (!stateSnapshot.started) return;

  const panelEl = stateSnapshot.panelEl;
  const panelId = panelEl.dataset.panelId;

  // Dropped on another workspace in the sidebar
  if (stateSnapshot.targetGroupId) {
    movePanelToGroup(panelId, stateSnapshot.targetGroupId);
    return;
  }

  // Dropped on "+ New Workspace" in the sidebar
  if (stateSnapshot.targetNewGroup) {
    movePanelToNewGroup(panelId);
    return;
  }

  // Dropped over sidebar (active workspace or empty space) — cancel without reordering
  if (stateSnapshot.overSidebar) {
    return;
  }

  const container = getCachedContainer(getActiveGroupId());
  const scope = container || document.getElementById('panel-strip');

  // Find the resize handle that follows this panel
  const resizeHandle = panelEl.nextElementSibling &&
    panelEl.nextElementSibling.classList.contains('resize-handle')
      ? panelEl.nextElementSibling
      : null;

  const insertBeforeEl = stateSnapshot.insertBeforeEl;

  if (insertBeforeEl && insertBeforeEl !== panelEl) {
    // Move panel before the target; also move its resize handle
    scope.insertBefore(panelEl, insertBeforeEl);
    if (resizeHandle) {
      if (panelEl.nextSibling) {
        scope.insertBefore(resizeHandle, panelEl.nextSibling);
      } else {
        scope.appendChild(resizeHandle);
      }
    }
  } else if (!insertBeforeEl) {
    // Move to end (before add-panel-controls)
    const addControls = scope.querySelector('.add-panel-controls');
    if (addControls) {
      scope.insertBefore(panelEl, addControls);
      if (resizeHandle) {
        scope.insertBefore(resizeHandle, addControls);
      }
    }
  }

  syncPanelOrder();

  // Fit terminal / layout editor if moved
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
}

function syncPanelOrder() {
  const group = getActiveGroup();
  if (!group) return;

  const container = getCachedContainer(getActiveGroupId());
  const scope = container || document.getElementById('panel-strip');
  const domPanelIds = Array.from(scope.querySelectorAll('[data-panel-id]'))
    .map(el => el.dataset.panelId);

  const panelMap = new Map(group.panels.map(p => [p.id, p]));
  group.panels = domPanelIds
    .map(id => panelMap.get(id))
    .filter(Boolean);

  saveState();
}
