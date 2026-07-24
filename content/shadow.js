// SwitchCookie - MAIN world storage isolation
// Wraps window.localStorage AND window.sessionStorage with a Proxy that switches
// between "passthrough" (default) and "isolated" (per-tab in-memory) once the
// bridge signals this tab is bound. Also intercepts document.cookie writes so
// pages using cookie APIs directly don't leak into the global jar.
//
// Important: Proxy target must NOT be the Storage object itself. Forwarding traps
// onto a Storage target re-enters brand-check / [[Get]] paths on some sites and
// blows the stack (RangeError: Maximum call stack size exceeded).
(() => {
  if (window.__SC_SHADOW_INSTALLED__) return;
  window.__SC_SHADOW_INSTALLED__ = true;

  const proto = Storage.prototype;
  const native = {
    getItem: proto.getItem,
    setItem: proto.setItem,
    removeItem: proto.removeItem,
    clear: proto.clear,
    key: proto.key,
  };
  const METHOD_NAMES = new Set([
    "length", "key", "getItem", "setItem", "removeItem", "clear",
    "constructor", "toString", "toLocaleString", "valueOf",
    "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable",
    "toJSON"
  ]);

  function wrapStorage(realStorage, kind) {
    let mode = "passthrough";
    const priv = new Map();
    // Re-entrancy guard: page code triggered by our notify/dump must not recurse.
    let quiet = false;

    function withQuiet(fn) {
      const prev = quiet;
      quiet = true;
      try { return fn(); } finally { quiet = prev; }
    }

    function realLength() {
      try { return realStorage.length | 0; } catch { return 0; }
    }
    function realKey(i) {
      try { return native.key.call(realStorage, i); } catch { return null; }
    }
    function realGet(k) {
      try { return native.getItem.call(realStorage, k); } catch { return null; }
    }
    function realSet(k, v) {
      try { native.setItem.call(realStorage, k, v); } catch {}
    }
    function realRemove(k) {
      try { native.removeItem.call(realStorage, k); } catch {}
    }
    function realClear() {
      try { native.clear.call(realStorage); } catch {}
    }

    function realDump() {
      const o = {};
      try {
        const n = realLength();
        for (let i = 0; i < n; i++) {
          const k = realKey(i);
          if (k != null) o[k] = realGet(k);
        }
      } catch {}
      return o;
    }

    function dump() {
      if (mode !== "isolated") return withQuiet(realDump);
      const o = {};
      for (const [k, v] of priv) o[k] = v;
      return o;
    }

    function notify() {
      if (quiet) return;
      try {
        window.dispatchEvent(new CustomEvent("sc:storage-changed", { detail: { kind } }));
      } catch {}
    }

    function getItem(k) {
      const kk = String(k);
      if (mode === "isolated") return priv.has(kk) ? priv.get(kk) : null;
      return realGet(kk);
    }
    function setItem(k, v) {
      const kk = String(k);
      const vv = String(v);
      if (mode === "isolated") priv.set(kk, vv);
      else realSet(kk, vv);
      notify();
    }
    function removeItem(k) {
      const kk = String(k);
      if (mode === "isolated") priv.delete(kk);
      else realRemove(kk);
      notify();
    }
    function clear() {
      if (mode === "isolated") priv.clear();
      else realClear();
      notify();
    }
    function key(i) {
      const idx = Number(i) | 0;
      if (mode === "isolated") {
        if (idx < 0 || idx >= priv.size) return null;
        return Array.from(priv.keys())[idx] ?? null;
      }
      return realKey(idx);
    }

    // Empty target: avoids Storage brand-check recursion through the proxy target.
    const proxy = new Proxy(Object.create(null), {
      get(_, prop) {
        if (prop === "length") return mode === "isolated" ? priv.size : realLength();
        if (prop === "getItem") return getItem;
        if (prop === "setItem") return setItem;
        if (prop === "removeItem") return removeItem;
        if (prop === "clear") return clear;
        if (prop === "key") return key;
        if (prop === Symbol.toStringTag) return "Storage";
        if (prop === Symbol.iterator) {
          return function* () {
            const n = mode === "isolated" ? priv.size : realLength();
            for (let i = 0; i < n; i++) {
              const k = key(i);
              if (k != null) yield k;
            }
          };
        }
        if (typeof prop === "symbol") return undefined;
        if (METHOD_NAMES.has(prop)) return undefined;
        // Property-style access: localStorage.foo
        return getItem(prop);
      },
      set(_, prop, value) {
        if (prop === "length" || METHOD_NAMES.has(prop) || typeof prop === "symbol") return true;
        setItem(prop, value);
        return true;
      },
      deleteProperty(_, prop) {
        if (typeof prop === "symbol" || METHOD_NAMES.has(prop)) return true;
        removeItem(prop);
        return true;
      },
      has(_, prop) {
        if (prop === "length" || METHOD_NAMES.has(prop)) return true;
        if (typeof prop === "symbol") return false;
        const kk = String(prop);
        if (mode === "isolated") return priv.has(kk);
        return realGet(kk) != null;
      },
      ownKeys() {
        if (mode === "isolated") return Array.from(priv.keys());
        const keys = [];
        try {
          const n = realLength();
          for (let i = 0; i < n; i++) {
            const k = realKey(i);
            if (k != null) keys.push(k);
          }
        } catch {}
        return keys;
      },
      getOwnPropertyDescriptor(_, prop) {
        if (prop === "length") {
          return { value: mode === "isolated" ? priv.size : realLength(), writable: false, enumerable: false, configurable: true };
        }
        if (METHOD_NAMES.has(prop) || typeof prop === "symbol") return undefined;
        const val = getItem(prop);
        if (val == null) return undefined;
        return { value: val, writable: true, enumerable: true, configurable: true };
      },
      defineProperty() { return false; },
      getPrototypeOf() { return Storage.prototype; },
    });

    return {
      proxy,
      setMode(m) { mode = m; },
      loadFrom(obj) {
        withQuiet(() => {
          priv.clear();
          for (const [k, v] of Object.entries(obj || {})) {
            priv.set(String(k), String(v));
          }
        });
      },
      clearPriv() { priv.clear(); },
      dump,
    };
  }

  // Capture natives BEFORE replacing window accessors.
  let nativeLocal;
  let nativeSession;
  try { nativeLocal = window.localStorage; } catch { nativeLocal = null; }
  try { nativeSession = window.sessionStorage; } catch { nativeSession = null; }
  if (!nativeLocal || !nativeSession) return;

  const local = wrapStorage(nativeLocal, "local");
  const session = wrapStorage(nativeSession, "session");

  try {
    Object.defineProperty(window, "localStorage", {
      configurable: true, enumerable: true, get: () => local.proxy
    });
  } catch {}
  try {
    Object.defineProperty(window, "sessionStorage", {
      configurable: true, enumerable: true, get: () => session.proxy
    });
  } catch {}

  // --- document.cookie writer interception ---
  let cookieMode = "passthrough";
  try {
    const desc = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    if (desc && desc.configurable && typeof desc.set === "function" && typeof desc.get === "function") {
      const nativeGet = desc.get;
      const nativeSet = desc.set;
      Object.defineProperty(Document.prototype, "cookie", {
        configurable: true,
        enumerable: desc.enumerable,
        get() { return nativeGet.call(this); },
        set(v) {
          if (cookieMode === "isolated") {
            try {
              window.dispatchEvent(new CustomEvent("sc:cookie-write", {
                detail: { header: String(v), href: location.href }
              }));
            } catch {}
            return;
          }
          try { nativeSet.call(this, v); } catch {}
        }
      });
    }
  } catch {}

  // --- Bridge events (ISOLATED world -> MAIN world) ---
  window.addEventListener("sc:bind", (e) => {
    const data = (e && e.detail) || {};
    local.loadFrom(data.local || {});
    session.loadFrom(data.session || {});
    local.setMode("isolated");
    session.setMode("isolated");
    cookieMode = "isolated";
    try {
      window.dispatchEvent(new CustomEvent("sc:storage-changed", { detail: { kind: "bind" } }));
    } catch {}
  });
  window.addEventListener("sc:unbind", () => {
    local.clearPriv();
    session.clearPriv();
    local.setMode("passthrough");
    session.setMode("passthrough");
    cookieMode = "passthrough";
    try {
      window.dispatchEvent(new CustomEvent("sc:storage-changed", { detail: { kind: "unbind" } }));
    } catch {}
  });
  window.addEventListener("sc:dump-request", () => {
    try {
      window.dispatchEvent(new CustomEvent("sc:dump-response", {
        detail: { local: local.dump(), session: session.dump() }
      }));
    } catch {}
  });
})();
