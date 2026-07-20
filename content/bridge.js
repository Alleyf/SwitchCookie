// SwitchCookie - ISOLATED world bridge.
// Talks to background to get the tab's binding, feeds MAIN world proxy,
// throttles change reports back.
(() => {
  if (window.__SC_BRIDGE_INSTALLED__) return;
  window.__SC_BRIDGE_INSTALLED__ = true;

  let bound = false;
  let saveTimer = null;

  function dispatchToPage(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch {}
  }

  function requestDump() {
    return new Promise((resolve) => {
      const handler = (e) => {
        window.removeEventListener("sc:dump-response", handler);
        resolve(e.detail || {});
      };
      window.addEventListener("sc:dump-response", handler, { once: true });
      dispatchToPage("sc:dump-request", null);
      // fallback timeout
      setTimeout(() => resolve({}), 500);
    });
  }

  function scheduleSave() {
    if (!bound) return;
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try {
        const dump = await requestDump();
        chrome.runtime.sendMessage({ type: "storageChanged", local: dump }).catch(() => {});
      } catch {}
    }, 400);
  }

  window.addEventListener("sc:ls-changed", scheduleSave);

  async function init() {
    let bindData = null;
    try {
      const resp = await chrome.runtime.sendMessage({ type: "getBinding", href: location.href });
      if (resp?.ok) bindData = resp.data;
    } catch { return; }
    if (!bindData || !bindData.bound) return;
    bound = true;
    dispatchToPage("sc:bind", { local: bindData.storage?.local || {} });
  }

  // Listen for updates from the background when the tab is (un)bound while alive.
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "sc:apply-binding") {
      bound = true;
      dispatchToPage("sc:bind", { local: msg.local || {} });
    } else if (msg.type === "sc:clear-binding") {
      bound = false;
      dispatchToPage("sc:unbind", null);
    }
  });

  init();
})();
