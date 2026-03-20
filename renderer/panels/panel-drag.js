// panel-drag.js - Drag-and-drop reordering for panels

const DRAG_THRESHOLD = 8;
const AUTO_SCROLL_EDGE_PX = 60;
const AUTO_SCROLL_MAX_SPEED = 15;

let dragState = null;
let autoScrollRafId = null;

function initPanelDrag(panelEl) {
  const header = panelEl.querySelector('.panel-header');
  if (!header) return;

  header.addEventListener('mousedown', e => {
    if (e.target.closest('.panel-close-btn') || e.target.closest('.panel-settings-btn')) return;
    e.preventDefault();

    // Clean up any in-progress drag before starting a new one
    if (dragState) {
      stopAutoScroll();
      if (dragState.started) {
        dragState.panelEl.classList.remove('dragging');
        if (dragState.indicator) {
          dragState.indicator.remove();
        }
      }
      document.removeEventListener('mousemove', onDragMove);
      document.removeEventListener('mouseup', onDragEnd);
      dragState = null;
    }

    dragState = {
      panelEl,
      startX: e.clientX,
      started: false,
      indicator: null,
    };
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
  });
}

function onDragMove(e) {
  if (!dragState) return;

  dragState.lastClientX = e.clientX;

  if (!dragState.started) {
    if (Math.abs(e.clientX - dragState.startX) < DRAG_THRESHOLD) return;
    dragState.started = true;
    dragState.panelEl.classList.add('dragging');

    const indicator = document.createElement('div');
    indicator.className = 'drop-indicator';
    dragState.indicator = indicator;
    const container = getCachedContainer(getActiveGroupId());
    (container || document.getElementById('panel-strip')).appendChild(indicator);

    startAutoScroll();
  }

  updateDropIndicator();
}

function updateDropIndicator() {
  if (!dragState || !dragState.started) return;

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
  stopAutoScroll();
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);

  if (!dragState) return;

  if (dragState.started) {
    dragState.panelEl.classList.remove('dragging');

    if (dragState.indicator) {
      dragState.indicator.remove();
    }

    const container = getCachedContainer(getActiveGroupId());
    const scope = container || document.getElementById('panel-strip');
    const panelEl = dragState.panelEl;
    const panelId = panelEl.dataset.panelId;

    // Find the resize handle that follows this panel
    const resizeHandle = panelEl.nextElementSibling &&
      panelEl.nextElementSibling.classList.contains('resize-handle')
        ? panelEl.nextElementSibling
        : null;

    const insertBeforeEl = dragState.insertBeforeEl;

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

    // Fit terminal if moved
    if (activeTerminals.has(panelId)) {
      const { fitAddon } = activeTerminals.get(panelId);
      if (fitAddon) {
        try { fitAddon.fit(); } catch (e) {}
      }
    }
  }

  dragState = null;
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
