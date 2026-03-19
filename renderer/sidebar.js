// sidebar.js - Sidebar rendering

function renderSidebar() {
  const sidebar = document.getElementById('sidebar');
  sidebar.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'sidebar-title';
  title.textContent = 'Workspaces';
  sidebar.appendChild(title);

  const list = document.createElement('div');
  list.className = 'group-list';

  state.groups.forEach(group => {
    const item = document.createElement('div');
    item.className = 'group-item' + (group.id === state.activeGroupId ? ' active' : '');

    const label = document.createElement('span');
    label.className = 'group-label';
    label.textContent = group.label;
    label.addEventListener('dblclick', e => {
      e.stopPropagation();
      startRenameGroup(group.id, label);
    });

    const count = document.createElement('span');
    count.className = 'group-panel-count';
    count.textContent = group.panels.length;

    const del = document.createElement('button');
    del.className = 'group-delete-btn';
    del.textContent = '×';
    del.title = 'Delete workspace';
    del.addEventListener('click', e => {
      e.stopPropagation();
      if (group.panels.length === 0 || confirm(`Delete "${group.label}" and its ${group.panels.length} panel(s)?`)) {
        deleteGroup(group.id);
      }
    });

    item.appendChild(label);
    item.appendChild(count);
    item.appendChild(del);
    item.addEventListener('click', () => selectGroup(group.id));
    list.appendChild(item);
  });

  sidebar.appendChild(list);

  const addBtn = document.createElement('button');
  addBtn.className = 'add-group-btn';
  addBtn.textContent = '+ New Workspace';
  addBtn.addEventListener('click', () => showWorkspaceModal());
  sidebar.appendChild(addBtn);
}

function startRenameGroup(groupId, labelEl) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = labelEl.textContent;
  input.className = 'group-rename-input';

  const finish = () => renameGroup(groupId, input.value || labelEl.textContent);

  input.addEventListener('blur', finish);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = labelEl.textContent; input.blur(); }
  });

  labelEl.replaceWith(input);
  input.focus();
  input.select();
}

// ── Sidebar resize ───────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const handle = document.getElementById('sidebar-resize-handle');
  const sidebar = document.getElementById('sidebar');
  if (!handle || !sidebar) return;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebar.offsetWidth;
    handle.classList.add('active');

    const onMove = (ev) => {
      const newWidth = Math.max(150, Math.min(500, startW + (ev.clientX - startX)));
      sidebar.style.width = newWidth + 'px';
      state.sidebarWidth = newWidth;
      fitVisibleTerminals(state.activeGroupId);
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
});
