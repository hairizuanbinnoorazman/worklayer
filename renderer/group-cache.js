// group-cache.js - LRU cache for group DOM containers

const groupDOMCache = new Map(); // groupId -> wrapper div
const lruOrder = [];             // index 0 = least recently used

function getMaxCached() {
  return (state && state.maxCachedGroups) || 5;
}

function touchLRU(groupId) {
  const idx = lruOrder.indexOf(groupId);
  if (idx !== -1) lruOrder.splice(idx, 1);
  lruOrder.push(groupId);
}

function evictLRU() {
  const max = getMaxCached();
  while (lruOrder.length > max) {
    const evictId = lruOrder.shift();
    const el = groupDOMCache.get(evictId);
    if (el) {
      el.remove();
      groupDOMCache.delete(evictId);
    }
    const group = state.groups.find(g => g.id === evictId);
    if (group) killGroupTerminals(group);
  }
}

function getCachedContainer(groupId) {
  return groupDOMCache.get(groupId) || null;
}

function cacheContainer(groupId, el) {
  groupDOMCache.set(groupId, el);
}

function removeCachedGroup(groupId) {
  const el = groupDOMCache.get(groupId);
  if (el) {
    el.remove();
    groupDOMCache.delete(groupId);
  }
  const idx = lruOrder.indexOf(groupId);
  if (idx !== -1) lruOrder.splice(idx, 1);
}

function fitVisibleTerminals(groupId) {
  const group = state.groups.find(g => g.id === groupId);
  if (!group) return;
  group.panels.forEach(p => {
    if (p.type === 'terminal' && activeTerminals.has(p.id)) {
      const { fitAddon } = activeTerminals.get(p.id);
      if (fitAddon) {
        try { fitAddon.fit(); } catch (e) {}
      }
    }
  });
}
