// SwitchCookie - MAIN world storage isolation
// Installs a Proxy over window.localStorage. Default passthrough; switches to
// per-tab in-memory storage once the bridge tells us this tab is bound.
(() => {
  if (window.__SC_SHADOW_INSTALLED__) return;
  window.__SC_SHADOW_INSTALLED__ = true;

  const realStorage = window.localStorage;
  let mode = "passthrough";
  const priv = new Map();

  function realDump() {
    const o = {};
    try { for (let i = 0; i < realStorage.length; i++) { const k = realStorage.key(i); o[k] = realStorage.getItem(k); } } catch {}
    return o;
  }
  function currentDump() {
    if (mode !== "isolated") return realDump();
    const o = {}; for (const [k, v] of priv) o[k] = v; return o;
  }
  function notify() {
    try { window.dispatchEvent(new CustomEvent("sc:ls-changed")); } catch {}
  }

  const proxy = new Proxy(realStorage, {
    get(_, prop) {
      if (prop === "length")     return mode === "isolated" ? priv.size : realStorage.length;
      if (prop === "clear")      return () => { if (mode === "isolated") priv.clear(); else { try { realStorage.clear(); } catch {} } notify(); };
      if (prop === "getItem")    return (k) => { const kk = String(k); return mode === "isolated" ? (priv.has(kk) ? priv.get(kk) : null) : realStorage.getItem(kk); };
      if (prop === "setItem")    return (k, v) => { const kk = String(k); const vv = String(v); if (mode === "isolated") priv.set(kk, vv); else { try { realStorage.setItem(kk, vv); } catch {} } notify(); };
      if (prop === "removeItem") return (k) => { const kk = String(k); if (mode === "isolated") priv.delete(kk); else { try { realStorage.removeItem(kk); } catch {} } notify(); };
      if (prop === "key")        return (i) => { if (mode === "isolated") { const arr = Array.from(priv.keys()); return arr[i] ?? null; } return realStorage.key(i); };
      if (typeof prop === "symbol") return realStorage[prop];
      // property-style access: localStorage.foo
      if (mode === "isolated") return priv.has(prop) ? priv.get(prop) : undefined;
      return realStorage[prop];
    },
    set(_, prop, value) {
      const kk = String(prop), vv = String(value);
      if (mode === "isolated") priv.set(kk, vv);
      else { try { realStorage[prop] = value; } catch {} }
      notify();
      return true;
    },
    deleteProperty(_, prop) {
      if (mode === "isolated") priv.delete(String(prop));
      else { try { delete realStorage[prop]; } catch {} }
      notify();
      return true;
    },
    has(_, prop) {
      if (mode === "isolated") return priv.has(String(prop));
      return prop in realStorage;
    },
    ownKeys(_) {
      if (mode === "isolated") return Array.from(priv.keys());
      const keys = []; try { for (let i = 0; i < realStorage.length; i++) keys.push(realStorage.key(i)); } catch {}
      return keys;
    },
    getOwnPropertyDescriptor(_, prop) {
      if (mode === "isolated") {
        if (!priv.has(String(prop))) return undefined;
        return { value: priv.get(String(prop)), writable: true, enumerable: true, configurable: true };
      }
      try { return Object.getOwnPropertyDescriptor(realStorage, prop); } catch { return undefined; }
    }
  });

  try {
    Object.defineProperty(window, "localStorage", {
      configurable: true, enumerable: true, get: () => proxy
    });
  } catch (e) { /* some sites freeze; give up gracefully */ }

  window.addEventListener("sc:bind", (e) => {
    const data = (e && e.detail) || {};
    priv.clear();
    for (const [k, v] of Object.entries(data.local || {})) priv.set(String(k), String(v));
    mode = "isolated";
    notify();
  });
  window.addEventListener("sc:unbind", () => {
    priv.clear();
    mode = "passthrough";
    notify();
  });
  window.addEventListener("sc:dump-request", () => {
    try {
      window.dispatchEvent(new CustomEvent("sc:dump-response", { detail: currentDump() }));
    } catch {}
  });
})();
