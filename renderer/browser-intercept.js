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
})();
