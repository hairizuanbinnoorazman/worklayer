// group-drag.js - Drag-and-drop reordering for workspace groups in the sidebar

const GROUP_DRAG_THRESHOLD = 8;
const GROUP_AUTO_SCROLL_EDGE_PX = 40;
const GROUP_AUTO_SCROLL_MAX_SPEED = 10;

let groupDragState = null;
let groupAutoScrollRafId = null;

function initGroupDrag(itemEl) {
  itemEl.addEventListener('mousedown', e => {
    if (e.target.closest('.group-delete-btn') || e.target.tagName === 'INPUT') return;

    // Clean up any in-progress drag
    if (groupDragState) {
      stopGroupAutoScroll();
      if (groupDragState.started) {
        groupDragState.itemEl.classList.remove('dragging');
        if (groupDragState.indicator) groupDragState.indicator.remove();
      }
      document.removeEventListener('mousemove', onGroupDragMove);
      document.removeEventListener('mouseup', onGroupDragEnd);
      groupDragState = null;
    }

    groupDragState = {
      itemEl,
      startY: e.clientY,
      lastClientY: e.clientY,
      started: false,
      indicator: null,
      insertBeforeEl: null,
    };
    document.addEventListener('mousemove', onGroupDragMove);
    document.addEventListener('mouseup', onGroupDragEnd);
  });
}

function onGroupDragMove(e) {
  if (!groupDragState) return;

  groupDragState.lastClientY = e.clientY;

  if (!groupDragState.started) {
    if (Math.abs(e.clientY - groupDragState.startY) < GROUP_DRAG_THRESHOLD) return;
    groupDragState.started = true;
    e.preventDefault();
    groupDragState.itemEl.classList.add('dragging');

    const indicator = document.createElement('div');
    indicator.className = 'group-drop-indicator';
    const list = document.querySelector('.group-list');
    if (list) list.appendChild(indicator);
    groupDragState.indicator = indicator;

    startGroupAutoScroll();
  }

  e.preventDefault();
  updateGroupDropIndicator();
}

function updateGroupDropIndicator() {
  if (!groupDragState || !groupDragState.started) return;

  const list = document.querySelector('.group-list');
  if (!list) return;

  const items = Array.from(list.querySelectorAll('.group-item:not(.dragging)'));
  let insertBeforeEl = null;

  for (const item of items) {
    const rect = item.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (groupDragState.lastClientY < midY) {
      insertBeforeEl = item;
      break;
    }
  }

  const listRect = list.getBoundingClientRect();

  if (insertBeforeEl) {
    const rect = insertBeforeEl.getBoundingClientRect();
    groupDragState.indicator.style.top = (rect.top - listRect.top + list.scrollTop - 1) + 'px';
    groupDragState.indicator.style.display = 'block';
  } else if (items.length > 0) {
    const lastItem = items[items.length - 1];
    const rect = lastItem.getBoundingClientRect();
    groupDragState.indicator.style.top = (rect.bottom - listRect.top + list.scrollTop - 1) + 'px';
    groupDragState.indicator.style.display = 'block';
  }

  groupDragState.insertBeforeEl = insertBeforeEl;
}

function startGroupAutoScroll() {
  if (groupAutoScrollRafId != null) return;

  function tick() {
    if (!groupDragState || !groupDragState.started) { stopGroupAutoScroll(); return; }

    const list = document.querySelector('.group-list');
    if (!list) { stopGroupAutoScroll(); return; }

    const rect = list.getBoundingClientRect();
    const y = groupDragState.lastClientY;
    let delta = 0;

    if (y < rect.top + GROUP_AUTO_SCROLL_EDGE_PX) {
      const depth = rect.top + GROUP_AUTO_SCROLL_EDGE_PX - y;
      delta = -(depth / GROUP_AUTO_SCROLL_EDGE_PX) * GROUP_AUTO_SCROLL_MAX_SPEED;
    } else if (y > rect.bottom - GROUP_AUTO_SCROLL_EDGE_PX) {
      const depth = y - (rect.bottom - GROUP_AUTO_SCROLL_EDGE_PX);
      delta = (depth / GROUP_AUTO_SCROLL_EDGE_PX) * GROUP_AUTO_SCROLL_MAX_SPEED;
    }

    if (delta !== 0) {
      const maxScroll = list.scrollHeight - list.clientHeight;
      list.scrollTop = Math.max(0, Math.min(maxScroll, list.scrollTop + delta));
      updateGroupDropIndicator();
    }

    groupAutoScrollRafId = requestAnimationFrame(tick);
  }

  groupAutoScrollRafId = requestAnimationFrame(tick);
}

function stopGroupAutoScroll() {
  if (groupAutoScrollRafId != null) {
    cancelAnimationFrame(groupAutoScrollRafId);
    groupAutoScrollRafId = null;
  }
}

function onGroupDragEnd() {
  stopGroupAutoScroll();
  document.removeEventListener('mousemove', onGroupDragMove);
  document.removeEventListener('mouseup', onGroupDragEnd);

  if (!groupDragState) return;

  if (groupDragState.started) {
    const itemEl = groupDragState.itemEl;
    itemEl.classList.remove('dragging');

    if (groupDragState.indicator) groupDragState.indicator.remove();

    const list = document.querySelector('.group-list');
    if (list) {
      const insertBeforeEl = groupDragState.insertBeforeEl;
      if (insertBeforeEl && insertBeforeEl !== itemEl) {
        list.insertBefore(itemEl, insertBeforeEl);
      } else if (!insertBeforeEl) {
        list.appendChild(itemEl);
      }
      syncGroupOrder();
    }

    // Suppress the click event that would fire after drag
    itemEl.addEventListener('click', function suppress(e) {
      e.stopPropagation();
      e.preventDefault();
      itemEl.removeEventListener('click', suppress, true);
    }, true);
  }

  groupDragState = null;
}

function syncGroupOrder() {
  const profile = getActiveProfile();
  if (!profile) return;

  const list = document.querySelector('.group-list');
  if (!list) return;

  const domGroupIds = Array.from(list.querySelectorAll('.group-item'))
    .map(el => el.dataset.groupId);

  const groupMap = new Map(profile.groups.map(g => [g.id, g]));
  profile.groups = domGroupIds
    .map(id => groupMap.get(id))
    .filter(Boolean);

  saveState();
}
