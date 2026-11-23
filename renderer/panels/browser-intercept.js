// browser-intercept.js — Opens URLs from terminal CLI tools as web panels

(function () {
  window.electronAPI.onTerminalBrowserOpen(({ termId, url, groupId }) => {
    if (!url) return;

    // Find the panelId that owns this termId
    let panelId = null;
    for (const [pid, entry] of activeTerminals) {
      if (entry.termId === termId) {
        panelId = pid;
        break;
      }
    }

    const resolvedGroupId = (panelId && findGroupByPanelId(panelId)?.id) || groupId;
    if (panelId) {
      addWebPanelAfter(panelId, url, resolvedGroupId);
    } else {
      addWebPanelAtEnd(url, resolvedGroupId);
    }
  });

  // MCP open_panel: create a web panel on request from main process
  window.electronAPI.onPanelCreateRequest(({ requestId, url, termId, groupId }) => {
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
      const resolvedGroupId = (sourcePanelId && findGroupByPanelId(sourcePanelId)?.id) || groupId;
      const newPanelId = sourcePanelId
        ? addWebPanelAfter(sourcePanelId, url, resolvedGroupId)
        : addWebPanelAtEnd(url, resolvedGroupId);
      window.electronAPI.panelCreateResponse(requestId, newPanelId, null);
    } catch (e) {
      window.electronAPI.panelCreateResponse(requestId, null, e.message);
    }
  });
})();
