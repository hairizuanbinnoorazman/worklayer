// sidebar.js - Sidebar rendering

function renderSidebar() {
  const sidebar = document.getElementById('sidebar');
  sidebar.innerHTML = '';

  const profile = getActiveProfile();

  // ── Profile selector ──────────────────────────
  const profileSection = document.createElement('div');
  profileSection.className = 'profile-section';

  const profileSelect = document.createElement('select');
  profileSelect.className = 'profile-select';
  state.profiles.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === state.activeProfileId) opt.selected = true;
    profileSelect.appendChild(opt);
  });
  profileSelect.addEventListener('change', () => {
    switchProfile(profileSelect.value);
  });

  const profileActions = document.createElement('div');
  profileActions.className = 'profile-actions';

  const addProfileBtn = document.createElement('button');
  addProfileBtn.className = 'profile-action-btn';
  addProfileBtn.textContent = '+';
  addProfileBtn.title = 'Add profile';
  addProfileBtn.addEventListener('click', () => {
    // Replace the select with an inline input for naming the new profile
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'profile-rename-input';
    input.placeholder = 'New profile name';
    profileSelect.replaceWith(input);
    input.focus();

    const finish = () => {
      const name = input.value.trim();
      if (name) {
        addProfile(name);
      } else {
        // Cancelled — re-render to restore the select
        renderSidebar();
      }
    };
    input.addEventListener('blur', finish);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.value = ''; input.blur(); }
    });
  });

  const renameProfileBtn = document.createElement('button');
  renameProfileBtn.className = 'profile-action-btn';
  renameProfileBtn.textContent = '\u270E';
  renameProfileBtn.title = 'Rename profile';
  renameProfileBtn.addEventListener('click', () => {
    if (!profile) return;
    // Replace the select with an inline input for renaming
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'profile-rename-input';
    input.value = profile.name;
    profileSelect.replaceWith(input);
    input.focus();
    input.select();

    const finish = () => {
      const newName = input.value.trim() || profile.name;
      renameProfile(profile.id, newName);
    };
    input.addEventListener('blur', finish);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') { input.value = profile.name; input.blur(); }
    });
  });

  const deleteProfileBtn = document.createElement('button');
  deleteProfileBtn.className = 'profile-action-btn profile-action-btn-danger';
  deleteProfileBtn.textContent = '\u00d7';
  deleteProfileBtn.title = 'Delete profile';
  if (state.profiles.length <= 1) {
    deleteProfileBtn.disabled = true;
    deleteProfileBtn.classList.add('profile-action-btn-disabled');
  }
  deleteProfileBtn.addEventListener('click', () => {
    if (!profile || state.profiles.length <= 1) return;
    if (confirm(`Delete profile "${profile.name}" and all its workspaces?`)) {
      deleteProfile(profile.id);
    }
  });

  profileActions.appendChild(addProfileBtn);
  profileActions.appendChild(renameProfileBtn);
  profileActions.appendChild(deleteProfileBtn);

  profileSection.appendChild(profileSelect);
  profileSection.appendChild(profileActions);
  sidebar.appendChild(profileSection);

  // ── Workspace title ───────────────────────────
  const title = document.createElement('div');
  title.className = 'sidebar-title';
  title.textContent = 'Workspaces';
  sidebar.appendChild(title);

  if (!profile) return;

  const list = document.createElement('div');
  list.className = 'group-list';

  profile.groups.forEach(group => {
    const item = document.createElement('div');
    item.className = 'group-item' + (group.id === profile.activeGroupId ? ' active' : '');

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
    del.textContent = '\u00d7';
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
      const activeGId = getActiveGroupId();
      if (activeGId) fitVisibleTerminals(activeGId);
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
