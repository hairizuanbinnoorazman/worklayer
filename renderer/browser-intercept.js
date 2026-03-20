// browser-intercept.js — Opens URLs from terminal CLI tools as web panels

(function () {
  window.electronAPI.onTerminalBrowserOpen(({ termId, url }) => {
    if (!url) return;

    // Find the panelId that owns this termId
    let panelId = null;
    for (const [pid, entry] of activeTerminals) {
      if (entry.termId === termId) {
        panelId = pid;
        break;
      }
    }

    if (panelId) {
      addWebPanelAfter(panelId, url);
    } else {
      addWebPanelAtEnd(url);
    }
  });

  // MCP open_panel: create a web panel on request from main process
  window.electronAPI.onPanelCreateRequest(({ requestId, url, termId }) => {
    try {
      let sourcePanelId = null;
      if (termId !== null && termId !== undefined) {
        for (const [pid, entry] of activeTerminals) {
          if (entry.termId === termId) {
            sourcePanelId = pid;
            break;
          }
        }
      }
      const newPanelId = sourcePanelId
        ? addWebPanelAfter(sourcePanelId, url)
        : addWebPanelAtEnd(url);
      window.electronAPI.panelCreateResponse(requestId, newPanelId, null);
    } catch (e) {
      window.electronAPI.panelCreateResponse(requestId, null, e.message);
    }
  });
})();
