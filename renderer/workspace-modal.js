// workspace-modal.js - Modal for configuring new workspace panels and templates

function showWorkspaceModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal-container';

  // Panel config rows state
  let panelRows = [];

  // Header
  const header = document.createElement('div');
  header.className = 'modal-header';
  header.textContent = 'New Workspace';
  modal.appendChild(header);

  // Template selector
  if (state.templates.length > 0) {
    const templateSection = document.createElement('div');
    templateSection.className = 'modal-template-section';

    const templateLabel = document.createElement('label');
    templateLabel.className = 'modal-label';
    templateLabel.textContent = 'Load from template';
    templateSection.appendChild(templateLabel);

    const templateRow = document.createElement('div');
    templateRow.className = 'modal-template-row';

    const templateSelect = document.createElement('select');
    templateSelect.className = 'modal-select';

    const emptyOpt = document.createElement('option');
    emptyOpt.value = '';
    emptyOpt.textContent = '-- None --';
    templateSelect.appendChild(emptyOpt);

    state.templates.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = `${t.name} (${t.panels.length} panel${t.panels.length !== 1 ? 's' : ''})`;
      templateSelect.appendChild(opt);
    });

    const deleteTemplateBtn = document.createElement('button');
    deleteTemplateBtn.className = 'modal-btn modal-btn-danger';
    deleteTemplateBtn.textContent = 'Delete';
    deleteTemplateBtn.style.display = 'none';

    templateSelect.addEventListener('change', () => {
      const templateId = templateSelect.value;
      deleteTemplateBtn.style.display = templateId ? '' : 'none';
      if (templateId) {
        const template = state.templates.find(t => t.id === templateId);
        if (template) {
          nameInput.value = template.name;
          panelRows = template.panels.map(p => ({ ...p }));
          renderPanelList();
        }
      }
    });

    deleteTemplateBtn.addEventListener('click', () => {
      const templateId = templateSelect.value;
      if (!templateId) return;
      const template = state.templates.find(t => t.id === templateId);
      if (template && confirm(`Delete template "${template.name}"?`)) {
        deleteTemplate(templateId);
        // Remove from select
        const opt = templateSelect.querySelector(`option[value="${templateId}"]`);
        if (opt) opt.remove();
        templateSelect.value = '';
        deleteTemplateBtn.style.display = 'none';
        // Hide section if no templates left
        if (state.templates.length === 0) {
          templateSection.style.display = 'none';
        }
      }
    });

    templateRow.appendChild(templateSelect);
    templateRow.appendChild(deleteTemplateBtn);
    templateSection.appendChild(templateRow);
    modal.appendChild(templateSection);
  }

  // Name input
  const nameSection = document.createElement('div');
  nameSection.className = 'modal-field';
  const nameLabel = document.createElement('label');
  nameLabel.className = 'modal-label';
  nameLabel.textContent = 'Workspace name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'modal-input';
  nameInput.placeholder = `Work ${state.groups.length + 1}`;
  nameSection.appendChild(nameLabel);
  nameSection.appendChild(nameInput);
  modal.appendChild(nameSection);

  // Panel list
  const panelSection = document.createElement('div');
  panelSection.className = 'modal-panel-section';

  const panelHeader = document.createElement('div');
  panelHeader.className = 'modal-panel-header';
  const panelTitle = document.createElement('span');
  panelTitle.className = 'modal-label';
  panelTitle.textContent = 'Panels';
  const addPanelBtn = document.createElement('button');
  addPanelBtn.className = 'modal-btn modal-btn-add';
  addPanelBtn.textContent = '+ Add Panel';
  addPanelBtn.addEventListener('click', () => {
    panelRows.push({ type: 'terminal' });
    renderPanelList();
  });
  panelHeader.appendChild(panelTitle);
  panelHeader.appendChild(addPanelBtn);
  panelSection.appendChild(panelHeader);

  const panelList = document.createElement('div');
  panelList.className = 'modal-panel-list';
  panelSection.appendChild(panelList);
  modal.appendChild(panelSection);

  function renderPanelList() {
    panelList.innerHTML = '';
    panelRows.forEach((row, index) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'modal-panel-row';

      // Type selector
      const typeSelect = document.createElement('select');
      typeSelect.className = 'modal-select modal-type-select';
      ['terminal', 'web', 'file'].forEach(t => {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t === 'web' ? 'Browser' : t === 'file' ? 'File Browser' : 'Terminal';
        if (t === row.type) opt.selected = true;
        typeSelect.appendChild(opt);
      });
      typeSelect.addEventListener('change', () => {
        const newType = typeSelect.value;
        panelRows[index] = { type: newType };
        renderPanelList();
      });
      rowEl.appendChild(typeSelect);

      // Type-specific fields
      const fields = document.createElement('div');
      fields.className = 'modal-panel-fields';

      if (row.type === 'terminal') {
        const cwdField = createFieldWithBrowse('Directory', row.cwd || '', async (val) => {
          panelRows[index].cwd = val;
        });
        fields.appendChild(cwdField);

        const cmdInput = createTextField('Startup command', row.initialCommand || '', val => {
          panelRows[index].initialCommand = val;
        });
        fields.appendChild(cmdInput);
      } else if (row.type === 'web') {
        const urlInput = createTextField('URL', row.url || '', val => {
          panelRows[index].url = val;
        });
        fields.appendChild(urlInput);
      } else if (row.type === 'file') {
        const dirField = createFieldWithBrowse('Root directory', row.rootDir || '', async (val) => {
          panelRows[index].rootDir = val;
        });
        fields.appendChild(dirField);
      }

      rowEl.appendChild(fields);

      // Remove button
      const removeBtn = document.createElement('button');
      removeBtn.className = 'modal-btn modal-btn-remove';
      removeBtn.textContent = '\u00d7';
      removeBtn.title = 'Remove panel';
      removeBtn.addEventListener('click', () => {
        panelRows.splice(index, 1);
        renderPanelList();
      });
      rowEl.appendChild(removeBtn);

      panelList.appendChild(rowEl);
    });
  }

  function createTextField(placeholder, value, onChange) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'modal-input modal-field-input';
    input.placeholder = placeholder;
    input.value = value;
    input.addEventListener('input', () => onChange(input.value));
    return input;
  }

  function createFieldWithBrowse(placeholder, value, onChange) {
    const wrapper = document.createElement('div');
    wrapper.className = 'modal-browse-field';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'modal-input modal-field-input';
    input.placeholder = placeholder;
    input.value = value;
    input.addEventListener('input', () => onChange(input.value));

    const browseBtn = document.createElement('button');
    browseBtn.className = 'modal-btn modal-btn-browse';
    browseBtn.textContent = '...';
    browseBtn.title = 'Browse';
    browseBtn.addEventListener('click', async () => {
      const result = await window.electronAPI.openDirectory();
      if (!result.cancelled) {
        input.value = result.path;
        onChange(result.path);
      }
    });

    wrapper.appendChild(input);
    wrapper.appendChild(browseBtn);
    return wrapper;
  }

  // Save as template checkbox
  const templateSaveSection = document.createElement('div');
  templateSaveSection.className = 'modal-template-save';

  const saveCheck = document.createElement('input');
  saveCheck.type = 'checkbox';
  saveCheck.id = 'modal-save-template-check';

  const saveCheckLabel = document.createElement('label');
  saveCheckLabel.htmlFor = 'modal-save-template-check';
  saveCheckLabel.textContent = 'Save as template';

  const templateNameInput = document.createElement('input');
  templateNameInput.type = 'text';
  templateNameInput.className = 'modal-input modal-template-name';
  templateNameInput.placeholder = 'Template name';
  templateNameInput.style.display = 'none';

  saveCheck.addEventListener('change', () => {
    templateNameInput.style.display = saveCheck.checked ? '' : 'none';
  });

  templateSaveSection.appendChild(saveCheck);
  templateSaveSection.appendChild(saveCheckLabel);
  templateSaveSection.appendChild(templateNameInput);
  modal.appendChild(templateSaveSection);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'modal-footer';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'modal-btn modal-btn-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => overlay.remove());

  const createBtn = document.createElement('button');
  createBtn.className = 'modal-btn modal-btn-create';
  createBtn.textContent = 'Create';
  createBtn.addEventListener('click', () => {
    const name = nameInput.value.trim() || nameInput.placeholder;

    // Save template if checked
    if (saveCheck.checked && panelRows.length > 0) {
      const tplName = templateNameInput.value.trim() || name;
      saveTemplate(tplName, panelRows);
    }

    if (panelRows.length === 0) {
      addGroup();
      // Rename it if a name was provided
      if (nameInput.value.trim()) {
        const group = state.groups[state.groups.length - 1];
        group.label = nameInput.value.trim();
        saveState();
        renderSidebar();
      }
    } else {
      addGroupWithPanels(name, panelRows);
    }

    overlay.remove();
  });

  footer.appendChild(cancelBtn);
  footer.appendChild(createBtn);
  modal.appendChild(footer);

  overlay.appendChild(modal);
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.remove();
  });

  document.body.appendChild(overlay);
  renderPanelList();
  nameInput.focus();
}
