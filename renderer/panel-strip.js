// panel-strip.js - Panel strip and resize handles

function renderPanelStrip() {
  const strip = document.getElementById('panel-strip');
  strip.innerHTML = '';

  const group = getActiveGroup();
  if (!group) return;

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

    actions.appendChild(webBtn);
    actions.appendChild(termBtn);
    empty.appendChild(title);
    empty.appendChild(actions);
    strip.appendChild(empty);
    return;
  }

  group.panels.forEach((panel, index) => {
    strip.appendChild(createPanelElement(panel));
    strip.appendChild(createResizeHandle(panel.id, index));
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

  addControls.appendChild(webBtn);
  addControls.appendChild(termBtn);
  strip.appendChild(addControls);

  // Scroll to the rightmost panel after adding
  requestAnimationFrame(() => {
    strip.scrollLeft = strip.scrollWidth;
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
  typeLabel.textContent = panel.type === 'web' ? 'Web' : 'Terminal';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'panel-close-btn';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => removePanel(panel.id));

  header.appendChild(typeLabel);
  header.appendChild(closeBtn);
  el.appendChild(header);

  const content = document.createElement('div');
  content.className = 'panel-content';

  if (panel.type === 'web') {
    renderWebPanel(panel, content);
  } else {
    renderTermPanel(panel, content);
  }

  el.appendChild(content);
  return el;
}

function createResizeHandle(panelId, index) {
  const handle = document.createElement('div');
  handle.className = 'resize-handle';

  let startX = 0;
  let startWidth = 0;

  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    startX = e.clientX;

    const group = getActiveGroup();
    const panel = group.panels[index];
    startWidth = panel.width;

    handle.classList.add('active');

    const onMove = e => {
      const newWidth = Math.max(300, startWidth + (e.clientX - startX));
      updatePanelWidth(panelId, newWidth);

      const panelEl = document.querySelector(`[data-panel-id="${panelId}"]`);
      if (panelEl) panelEl.style.width = newWidth + 'px';

      if (activeTerminals.has(panelId)) {
        const { fitAddon } = activeTerminals.get(panelId);
        if (fitAddon) {
          try { fitAddon.fit(); } catch (e) {}
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
