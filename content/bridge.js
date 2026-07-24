// SwitchCookie - ISOLATED world bridge.
// Talks to background to fetch this tab's binding, feeds MAIN world proxies,
// forwards storage / cookie-write events back.
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
      setTimeout(() => resolve({}), 500);
    });
  }

  function scheduleSave() {
    if (!bound || saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try {
        const dump = await requestDump();
        chrome.runtime.sendMessage({
          type: "storageChanged",
          local: dump.local || {},
          session: dump.session || {}
        }).catch(() => {});
      } catch {}
    }, 400);
  }

  window.addEventListener("sc:storage-changed", scheduleSave);
  window.addEventListener("sc:cookie-write", (e) => {
    if (!bound) return;
    const detail = (e && e.detail) || {};
    chrome.runtime.sendMessage({
      type: "setCookie",
      header: detail.header || "",
      href: detail.href || location.href
    }).catch(() => {});
  });

  async function init() {
    let bindData = null;
    try {
      const resp = await chrome.runtime.sendMessage({ type: "getBinding", href: location.href });
      if (resp?.ok) bindData = resp.data;
    } catch { return; }
    if (!bindData || !bindData.bound) return;
    bound = true;
    dispatchToPage("sc:bind", {
      local: bindData.storage?.local || {},
      session: bindData.storage?.session || {}
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "sc:apply-binding") {
      bound = true;
      dispatchToPage("sc:bind", { local: msg.local || {}, session: msg.session || {} });
    } else if (msg.type === "sc:clear-binding") {
      bound = false;
      dispatchToPage("sc:unbind", null);
    }
  });

  init();
})();