// panel-drag.js - Drag-and-drop reordering for panels

const DRAG_THRESHOLD = 8;

let dragState = null;

function initPanelDrag(panelEl) {
  const header = panelEl.querySelector('.panel-header');
  if (!header) return;

  header.addEventListener('mousedown', e => {
    if (e.target.closest('.panel-close-btn')) return;
    e.preventDefault();
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

  if (!dragState.started) {
    if (Math.abs(e.clientX - dragState.startX) < DRAG_THRESHOLD) return;
    dragState.started = true;
    dragState.panelEl.classList.add('dragging');

    const indicator = document.createElement('div');
    indicator.className = 'drop-indicator';
    dragState.indicator = indicator;
    document.getElementById('panel-strip').appendChild(indicator);
  }

  const strip = document.getElementById('panel-strip');
  const panels = Array.from(strip.querySelectorAll('.panel:not(.dragging)'));

  let insertBeforeEl = null;
  for (const panel of panels) {
    const rect = panel.getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    if (e.clientX < midX) {
      insertBeforeEl = panel;
      break;
    }
  }

  // Position the indicator
  if (insertBeforeEl) {
    const rect = insertBeforeEl.getBoundingClientRect();
    const stripRect = strip.getBoundingClientRect();
    dragState.indicator.style.left = (rect.left - stripRect.left + strip.scrollLeft - 2) + 'px';
    dragState.indicator.style.display = 'block';
  } else if (panels.length > 0) {
    const lastPanel = panels[panels.length - 1];
    const rect = lastPanel.getBoundingClientRect();
    const stripRect = strip.getBoundingClientRect();
    dragState.indicator.style.left = (rect.right - stripRect.left + strip.scrollLeft - 1) + 'px';
    dragState.indicator.style.display = 'block';
  }

  dragState.insertBeforeEl = insertBeforeEl;
}

function onDragEnd() {
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);

  if (!dragState) return;

  if (dragState.started) {
    dragState.panelEl.classList.remove('dragging');

    if (dragState.indicator) {
      dragState.indicator.remove();
    }

    const strip = document.getElementById('panel-strip');
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
      strip.insertBefore(panelEl, insertBeforeEl);
      if (resizeHandle) {
        // Place resize handle after the panel
        if (panelEl.nextSibling) {
          strip.insertBefore(resizeHandle, panelEl.nextSibling);
        } else {
          strip.appendChild(resizeHandle);
        }
      }
    } else if (!insertBeforeEl) {
      // Move to end (before add-panel-controls)
      const addControls = strip.querySelector('.add-panel-controls');
      if (addControls) {
        strip.insertBefore(panelEl, addControls);
        if (resizeHandle) {
          strip.insertBefore(resizeHandle, addControls);
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

  const strip = document.getElementById('panel-strip');
  const domPanelIds = Array.from(strip.querySelectorAll('[data-panel-id]'))
    .map(el => el.dataset.panelId);

  const panelMap = new Map(group.panels.map(p => [p.id, p]));
  group.panels = domPanelIds
    .map(id => panelMap.get(id))
    .filter(Boolean);

  saveState();
}
