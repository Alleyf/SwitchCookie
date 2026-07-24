// SwitchCookie background service worker (per-tab isolation)
//
// Strategy:
//   - Each tab can be "bound" to a saved account for a registrable domain (+ related SSO domains).
//   - DNR session rules rewrite Cookie headers per-tab for those domains.
//   - webRequest.onHeadersReceived absorbs Set-Cookie into the tab virtual jar and scrubs global jar.
//   - document.cookie writes are forwarded from MAIN world → bridge → setCookie here.
//   - localStorage / sessionStorage are isolated via content-script proxies.
//
// Known hard limits (see README):
//   - Service Worker / Web Worker fetches have tabId = -1 → not rewritten.
//   - document.cookie reads still hit the browser global jar.
//   - IndexedDB / Cache Storage are origin-shared and not isolatable here.

import { getRegistrableDomain } from "./lib/psl.js";
import { deriveKey, createSalt, encryptJson, decryptJson } from "./lib/crypto.js";

// ---------- storage keys ----------
const LK_META    = "sc:meta";
const LK_CIPHER  = "sc:cipher";
const LK_PLAIN   = "sc:plain";
const LEGACY_ACC = "sc:accounts";
const LEGACY_ACT = "sc:active";

// in-memory state
let unlockedKey = null;
const tabBindings     = new Map(); // tabId -> { domainKey, accountId }
const tabJars         = new Map(); // tabId -> Cookie[]
const tabLocalStore   = new Map(); // tabId -> { key: value }
const tabSessionStore = new Map(); // tabId -> { key: value }
const RULE_BASE       = 1_000_000;

// ---------- related / SSO domain groups (P2) ----------
// When saving or rewriting cookies for a domain, also include these eTLD+1 peers.
const RELATED_DOMAIN_GROUPS = [
  ["google.com", "youtube.com", "googleapis.com", "gstatic.com", "ggpht.com", "ytimg.com", "googlevideo.com", "googleusercontent.com", "blogger.com", "blogspot.com"],
  ["github.com", "githubassets.com", "githubusercontent.com", "github.io"],
  ["microsoft.com", "live.com", "office.com", "office365.com", "microsoftonline.com", "msn.com", "bing.com", "azure.com", "sharepoint.com", "outlook.com", "hotmail.com"],
  ["amazon.com", "amazon.co.jp", "amazon.co.uk", "ssl-images-amazon.com", "media-amazon.com"],
  ["facebook.com", "fb.com", "fbcdn.net", "instagram.com", "whatsapp.com", "messenger.com"],
  ["twitter.com", "x.com", "twimg.com", "t.co"],
  ["apple.com", "icloud.com", "cdn-apple.com"],
  ["taobao.com", "tmall.com", "alipay.com", "alicdn.com", "aliyun.com", "alibaba.com", "1688.com"],
  ["qq.com", "weixin.qq.com", "tenpay.com", "gtimg.com", "idqqimg.com"],
  ["baidu.com", "bdimg.com", "bdstatic.com"],
  ["bilibili.com", "bilivideo.com", "hdslb.com"],
  ["zhihu.com", "zhimg.com"],
  ["jd.com", "360buyimg.com"],
  ["netflix.com", "nflxvideo.net", "nflximg.net"],
  ["spotify.com", "scdn.co"],
  ["reddit.com", "redditmedia.com", "redd.it"],
  ["linkedin.com", "licdn.com"],
  ["dropbox.com", "dropboxusercontent.com"],
  ["slack.com", "slack-edge.com"],
  ["notion.so", "notion.com"],
  // ByteDance / 火山引擎 / 抖音 — SSO often lives on bytedance.com, not only volcengine.com
  ["volcengine.com", "volces.com", "bytedance.com", "byteoversea.com", "douyin.com", "tiktok.com", "bytescm.com", "ibytedtos.com", "yuanbao.com", "feishu.cn", "larksuite.com"],
];

function relatedDomainsOf(domainKey) {
  const out = new Set([domainKey].filter(Boolean));
  if (!domainKey) return out;
  for (const group of RELATED_DOMAIN_GROUPS) {
    if (group.includes(domainKey)) {
      for (const d of group) out.add(d);
    }
  }
  return out;
}

function domainsFromJar(jar) {
  const out = new Set();
  for (const c of jar || []) {
    const host = (c.domain || "").replace(/^\./, "").toLowerCase();
    if (!host) continue;
    const dk = domainKeyOf(host);
    if (dk) out.add(dk);
  }
  return out;
}

function requestDomainsFor(tabId) {
  const b = tabBindings.get(tabId);
  if (!b) return [];
  const set = relatedDomainsOf(b.domainKey);
  for (const d of domainsFromJar(tabJars.get(tabId))) set.add(d);
  return [...set];
}

function hostInBindingScope(hostname, binding) {
  if (!hostname || !binding) return false;
  const dk = domainKeyOf(hostname);
  if (!dk) return false;
  if (dk === binding.domainKey) return true;
  return relatedDomainsOf(binding.domainKey).has(dk);
}

// ---------- session persistence (survive SW restart) ----------
const SESSION_BINDINGS_KEY = "sc:session:bindings";
const SESSION_JARS_KEY     = "sc:session:jars";
const SESSION_LOCAL_KEY    = "sc:session:local";
const SESSION_SESSION_KEY  = "sc:session:session";

async function persistSessionState() {
  try {
    const bindings = {}, jars = {}, locals = {}, sessions = {};
    for (const [tabId, b] of tabBindings) {
      const k = String(tabId);
      bindings[k] = b;
      jars[k] = tabJars.get(tabId) || [];
      locals[k] = tabLocalStore.get(tabId) || {};
      sessions[k] = tabSessionStore.get(tabId) || {};
    }
    await chrome.storage.session.set({
      [SESSION_BINDINGS_KEY]: bindings,
      [SESSION_JARS_KEY]: jars,
      [SESSION_LOCAL_KEY]: locals,
      [SESSION_SESSION_KEY]: sessions
    });
  } catch (e) { console.warn("[SwitchCookie] persistSessionState failed", e); }
}

async function restoreSessionState() {
  try {
    const stored = await chrome.storage.session.get([
      SESSION_BINDINGS_KEY, SESSION_JARS_KEY, SESSION_LOCAL_KEY, SESSION_SESSION_KEY
    ]);
    const bindings = stored[SESSION_BINDINGS_KEY] || {};
    const jars     = stored[SESSION_JARS_KEY] || {};
    const locals   = stored[SESSION_LOCAL_KEY] || {};
    const sessions = stored[SESSION_SESSION_KEY] || {};
    for (const [tabIdStr, binding] of Object.entries(bindings)) {
      const tabId = Number(tabIdStr);
      if (Number.isNaN(tabId)) continue;
      tabBindings.set(tabId, binding);
      tabJars.set(tabId, jars[tabIdStr] || []);
      tabLocalStore.set(tabId, locals[tabIdStr] || {});
      tabSessionStore.set(tabId, sessions[tabIdStr] || {});
      await applyRuleForTab(tabId);
    }
    if (Object.keys(bindings).length > 0) {
      console.log(`[SwitchCookie] restored ${Object.keys(bindings).length} tab binding(s) from session`);
    }
  } catch (e) { console.warn("[SwitchCookie] restoreSessionState failed", e); }
}

(() => { restoreSessionState(); })();

// ---------- utilities ----------
const uuid = () => "sc_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const domainKeyOf = (h) => getRegistrableDomain(h);

async function readMeta() {
  const { [LK_META]: m } = await chrome.storage.local.get(LK_META);
  return m || { encrypted: false, salt: null };
}
async function writeMeta(m) { await chrome.storage.local.set({ [LK_META]: m }); }

async function migrateLegacy() {
  const { [LEGACY_ACC]: a, [LEGACY_ACT]: b, [LK_PLAIN]: p } =
    await chrome.storage.local.get([LEGACY_ACC, LEGACY_ACT, LK_PLAIN]);
  if (p) return;
  if (a || b) {
    await chrome.storage.local.set({ [LK_PLAIN]: { accounts: a || {}, active: b || {} } });
    await chrome.storage.local.remove([LEGACY_ACC, LEGACY_ACT]);
  }
}

async function loadStore() {
  await migrateLegacy();
  const meta = await readMeta();
  if (meta.encrypted) {
    if (!unlockedKey) throw new Error("LOCKED");
    const { [LK_CIPHER]: c } = await chrome.storage.local.get(LK_CIPHER);
    if (!c) return { accounts: {}, active: {} };
    try { return await decryptJson(unlockedKey, c.iv, c.ct); }
    catch { unlockedKey = null; throw new Error("LOCKED"); }
  }
  const { [LK_PLAIN]: p } = await chrome.storage.local.get(LK_PLAIN);
  return p || { accounts: {}, active: {} };
}
async function saveStore(store) {
  const meta = await readMeta();
  if (meta.encrypted) {
    if (!unlockedKey) throw new Error("LOCKED");
    const enc = await encryptJson(unlockedKey, store);
    await chrome.storage.local.set({ [LK_CIPHER]: enc });
  } else {
    await chrome.storage.local.set({ [LK_PLAIN]: store });
  }
}

// ---------- cookie helpers ----------
function cookieUrl(c) {
  const scheme = c.secure ? "https" : "http";
  const host = (c.domain || "").replace(/^\./, "");
  return `${scheme}://${host}${c.path || "/"}`;
}

/** Best-effort cookie deletion (try https/http + path variants). */
async function removeCookieBestEffort(c) {
  const host = (c.domain || "").replace(/^\./, "");
  if (!host || !c.name) return;
  const path = c.path || "/";
  const urls = new Set([
    `https://${host}${path}`,
    `http://${host}${path}`,
    `https://${host}/`,
    `http://${host}/`,
  ]);
  const tasks = [];
  for (const url of urls) {
    const opts = { url, name: c.name };
    if (c.storeId) opts.storeId = c.storeId;
    tasks.push(chrome.cookies.remove(opts).catch(() => {}));
  }
  await Promise.all(tasks);
}

/**
 * Collect every cookie that belongs to this site scope for logout.
 * Broader than snapshot: also scans the full cookie store for matching suffixes
 * (catches host-only + cross-subdomain SSO cookies getAll({domain}) can miss).
 */
async function collectLogoutCookies(domainKey, hostname) {
  const byId = new Map();
  const addAll = (list) => {
    for (const c of list || []) byId.set(cookieIdentity(c), c);
  };

  // Baseline: related-domain + hostname walk
  addAll(await getDomainCookies(domainKey, hostname));

  const suffixes = [...relatedDomainsOf(domainKey)];
  if (hostname) {
    suffixes.push(hostname.toLowerCase());
    const labels = hostname.toLowerCase().split(".");
    for (let i = 0; i < labels.length - 1; i++) suffixes.push(labels.slice(i).join("."));
  }
  const uniqSuffix = [...new Set(suffixes.filter(Boolean))];

  const matchesScope = (domainAttr) => {
    const d = (domainAttr || "").replace(/^\./, "").toLowerCase();
    if (!d) return false;
    return uniqSuffix.some((s) => d === s || d.endsWith("." + s) || s.endsWith("." + d));
  };

  try {
    const all = await chrome.cookies.getAll({});
    for (const c of all) {
      if (matchesScope(c.domain)) byId.set(cookieIdentity(c), c);
    }
  } catch {}

  return [...byId.values()];
}

async function clearPageAuthState(tabId) {
  // Fire-and-forget: best-effort page cleanup, never block reload.
  // allFrames + async func can reject on cross-origin iframes in MV3.
  chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: "MAIN",
    func: async () => {
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
      try {
        if (indexedDB.databases) {
          const dbs = await indexedDB.databases();
          await Promise.all((dbs || []).map((db) => new Promise((res) => {
            if (!db?.name) return res();
            const req = indexedDB.deleteDatabase(db.name);
            req.onsuccess = req.onerror = req.onblocked = () => res();
          })));
        }
      } catch {}
      try {
        if (globalThis.caches?.keys) {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
        }
      } catch {}
      try {
        const regs = await navigator.serviceWorker?.getRegistrations?.();
        if (regs?.length) await Promise.all(regs.map((r) => r.unregister()));
      } catch {}
    }
  }).catch(() => {});
}

function cookieIdentity(c) {
  return `${c.name}\u0000${(c.domain || "").replace(/^\./, "").toLowerCase()}\u0000${c.path || "/"}`;
}

function serializeCookieHeader(cookies) {
  // Dedupe only exact name+domain+path (keep last). Same name with different
  // path/domain both go into the Cookie header — servers ignore unknown names.
  const lastIdx = new Map();
  cookies.forEach((c, i) => {
    if (!c?.name) return;
    lastIdx.set(cookieIdentity(c), i);
  });
  const parts = [];
  cookies.forEach((c, i) => {
    if (!c?.name) return;
    if (lastIdx.get(cookieIdentity(c)) !== i) return;
    parts.push(`${c.name}=${c.value}`);
  });
  return parts.join("; ");
}

function parseSetCookie(line) {
  const [nv, ...attrs] = String(line || "").split(";");
  const eq = nv.indexOf("=");
  if (eq < 0) return null;
  const name = nv.slice(0, eq).trim();
  const value = nv.slice(eq + 1).trim();
  if (!name) return null;
  const c = { name, value, path: "/", secure: false, httpOnly: false, sameSite: "unspecified" };
  let maxAge = null, expires = null;
  for (const a of attrs) {
    const sep = a.indexOf("=");
    const key = (sep < 0 ? a : a.slice(0, sep)).trim().toLowerCase();
    const val = (sep < 0 ? "" : a.slice(sep + 1)).trim();
    if (key === "path") c.path = val || "/";
    else if (key === "domain") { c.domain = val.toLowerCase(); c.hostOnly = false; }
    else if (key === "secure") c.secure = true;
    else if (key === "httponly") c.httpOnly = true;
    else if (key === "samesite") c.sameSite = (val || "unspecified").toLowerCase().replace(/-/g, "_");
    else if (key === "max-age") maxAge = Number(val);
    else if (key === "expires") expires = val;
    else if (key === "partitioned") c.partitioned = true;
  }
  if (maxAge != null && !Number.isNaN(maxAge)) {
    c.expirationDate = Date.now() / 1000 + maxAge;
    c.session = false;
  } else if (expires) {
    const t = Date.parse(expires);
    if (!Number.isNaN(t)) { c.expirationDate = t / 1000; c.session = false; }
    else c.session = true;
  } else {
    c.session = true;
  }
  if (c.name.startsWith("__Host-")) {
    c.secure = true; c.path = "/"; c.hostOnly = true; delete c.domain;
  } else if (c.name.startsWith("__Secure-")) {
    c.secure = true;
  }
  // Normalize SameSite tokens from Set-Cookie
  if (c.sameSite === "none") c.sameSite = "no_restriction";
  return c;
}

function mergeIntoJar(jar, incoming, defaultHost) {
  if (!incoming.domain && defaultHost) {
    incoming.hostOnly = true;
    incoming.domain = defaultHost;
  }
  const norm = (s) => (s || "").replace(/^\./, "").toLowerCase();
  const idx = jar.findIndex(c =>
    c.name === incoming.name &&
    norm(c.domain) === norm(incoming.domain) &&
    (c.path || "/") === (incoming.path || "/"));
  const now = Date.now() / 1000;
  const isExpired = incoming.expirationDate && incoming.expirationDate <= now;
  if (idx >= 0) jar.splice(idx, 1);
  if (!isExpired) jar.push(incoming);
}

// ---------- DNR rule management ----------
function ruleIdFor(tabId) { return RULE_BASE + tabId; }

const dnrDebounceTimers = new Map();
function scheduleRuleUpdate(tabId) {
  const existing = dnrDebounceTimers.get(tabId);
  if (existing) clearTimeout(existing);
  dnrDebounceTimers.set(tabId, setTimeout(async () => {
    dnrDebounceTimers.delete(tabId);
    await applyRuleForTab(tabId);
  }, 80));
}

async function applyRuleForTab(tabId) {
  const binding = tabBindings.get(tabId);
  if (!binding) return;
  const jar = tabJars.get(tabId) || [];
  const header = serializeCookieHeader(jar);
  const domains = requestDomainsFor(tabId);
  if (!domains.length) return;

  const addRules = [{
    id: ruleIdFor(tabId),
    priority: 1,
    condition: {
      tabIds: [tabId],
      requestDomains: domains,
      resourceTypes: [
        "main_frame","sub_frame","xmlhttprequest","script","stylesheet",
        "image","font","media","websocket","ping","object","other"
      ]
    },
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        { header: "cookie", operation: header ? "set" : "remove", value: header || undefined }
      ]
    }
  }];
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleIdFor(tabId)],
      addRules
    });
  } catch (e) { console.error("[SwitchCookie] DNR set failed", e); }
}

async function removeRuleForTab(tabId) {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleIdFor(tabId)],
      addRules: []
    });
  } catch (e) { console.warn("[SwitchCookie] DNR remove failed", e); }
}

async function scrubFromGlobalJar(cookie) {
  const url = cookieUrl(cookie);
  try {
    const opts = { url, name: cookie.name };
    if (cookie.storeId) opts.storeId = cookie.storeId;
    await chrome.cookies.remove(opts);
  } catch {}
}

// ---------- live account sync (P1) ----------
const accountSyncTimers = new Map();
function scheduleAccountSync(tabId) {
  const existing = accountSyncTimers.get(tabId);
  if (existing) clearTimeout(existing);
  accountSyncTimers.set(tabId, setTimeout(() => {
    accountSyncTimers.delete(tabId);
    saveAccountLiveState(tabId).catch(() => {});
  }, 1500));
}

async function saveAccountLiveState(tabId) {
  const b = tabBindings.get(tabId);
  if (!b) return;
  try {
    const store = await loadStore();
    const arr = store.accounts[b.domainKey] || [];
    const idx = arr.findIndex(a => a.id === b.accountId);
    if (idx < 0) return;
    arr[idx] = {
      ...arr[idx],
      cookies: JSON.parse(JSON.stringify(tabJars.get(tabId) || [])),
      storage: {
        local: JSON.parse(JSON.stringify(tabLocalStore.get(tabId) || {})),
        session: JSON.parse(JSON.stringify(tabSessionStore.get(tabId) || {}))
      },
      updatedAt: Date.now()
    };
    store.accounts[b.domainKey] = arr;
    await saveStore(store);
  } catch (e) {
    // LOCKED or transient — ignore
    if (e?.message !== "LOCKED") console.warn("[SwitchCookie] saveAccountLiveState", e);
  }
}

// ---------- webRequest: absorb Set-Cookie headers ----------
chrome.webRequest.onHeadersReceived.addListener((details) => {
  const tabId = details.tabId;
  if (tabId < 0) return;
  const binding = tabBindings.get(tabId);
  if (!binding) return;
  try {
    const u = new URL(details.url);
    if (!hostInBindingScope(u.hostname, binding)) return;
    let jar = tabJars.get(tabId);
    if (!jar) { jar = []; tabJars.set(tabId, jar); }
    let touched = false;
    for (const h of details.responseHeaders || []) {
      if ((h.name || "").toLowerCase() !== "set-cookie") continue;
      const line = h.value || "";
      for (const one of line.split(/\r?\n/)) {
        const c = parseSetCookie(one);
        if (!c) continue;
        mergeIntoJar(jar, c, u.hostname);
        touched = true;
        setTimeout(() => scrubFromGlobalJar({
          ...c,
          secure: c.secure || u.protocol === "https:"
        }), 50);
      }
    }
    if (touched) {
      scheduleRuleUpdate(tabId);
      scheduleAccountSync(tabId);
    }
  } catch (e) { console.warn("[SwitchCookie] onHeadersReceived error", e); }
}, { urls: ["<all_urls>"] }, ["responseHeaders", "extraHeaders"]);

// ---------- tab lifecycle ----------
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await saveAccountLiveState(tabId);
  tabBindings.delete(tabId);
  tabJars.delete(tabId);
  tabLocalStore.delete(tabId);
  tabSessionStore.delete(tabId);
  await removeRuleForTab(tabId);
  await persistSessionState();
  const t = accountSyncTimers.get(tabId);
  if (t) { clearTimeout(t); accountSyncTimers.delete(tabId); }
});

chrome.tabs.onUpdated.addListener(async () => {});

chrome.runtime.onStartup.addListener(() => {});

// ---------- per-tab binding & unbinding ----------
async function bindTab(tabId, hostname, accountId) {
  const domainKey = domainKeyOf(hostname);
  const store = await loadStore();
  const acc = (store.accounts[domainKey] || []).find(a => a.id === accountId);
  if (!acc) throw new Error("账号不存在");
  tabBindings.set(tabId, { domainKey, accountId });
  tabJars.set(tabId, JSON.parse(JSON.stringify(acc.cookies || [])));
  tabLocalStore.set(tabId, JSON.parse(JSON.stringify(acc.storage?.local || {})));
  tabSessionStore.set(tabId, JSON.parse(JSON.stringify(acc.storage?.session || {})));
  await applyRuleForTab(tabId);
  await persistSessionState();

  // Write saved cookies into the browser global jar so document.cookie reads
  // (which are not interceptable) see the correct auth state.
  for (const c of acc.cookies || []) {
    if (c.session && !c.expirationDate) continue;
    try {
      const scheme = c.secure ? "https" : "http";
      const host = (c.domain || "").replace(/^\./, "");
      const url = `${scheme}://${host}${c.path || "/"}`;
      const details = {
        url, name: c.name, value: c.value,
        path: c.path || "/",
        secure: !!c.secure, httpOnly: !!c.httpOnly,
        sameSite: c.sameSite || "unspecified"
      };
      if (c.domain && !c.hostOnly) details.domain = c.domain;
      if (c.expirationDate && !c.session) details.expirationDate = c.expirationDate;
      await chrome.cookies.set(details).catch(() => {});
    } catch {}
  }

  try { await chrome.tabs.reload(tabId); } catch {}
} catch {}
}

async function unbindTab(tabId) {
  await saveAccountLiveState(tabId);
  tabBindings.delete(tabId);
  tabJars.delete(tabId);
  tabLocalStore.delete(tabId);
  tabSessionStore.delete(tabId);
  await removeRuleForTab(tabId);
  await persistSessionState();
  try {
    await chrome.tabs.sendMessage(tabId, { type: "sc:clear-binding" }).catch(() => {});
  } catch {}
  try { await chrome.tabs.reload(tabId); } catch {}
}

async function openInNewTab(hostname, accountId, url) {
  const targetUrl = url || `https://${hostname}/`;
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  const domainKey = domainKeyOf(hostname);
  const store = await loadStore();
  const acc = (store.accounts[domainKey] || []).find(a => a.id === accountId);
  if (!acc) throw new Error("账号不存在");
  tabBindings.set(tab.id, { domainKey, accountId });
  tabJars.set(tab.id, JSON.parse(JSON.stringify(acc.cookies || [])));
  tabLocalStore.set(tab.id, JSON.parse(JSON.stringify(acc.storage?.local || {})));
  tabSessionStore.set(tab.id, JSON.parse(JSON.stringify(acc.storage?.session || {})));

  // Write cookies to global jar so document.cookie reads work.
  for (const c of acc.cookies || []) {
    if (c.session && !c.expirationDate) continue;
    try {
      const scheme = c.secure ? "https" : "http";
      const host = (c.domain || "").replace(/^\./, "");
      const url = `${scheme}://${host}${c.path || "/"}`;
      const details = {
        url, name: c.name, value: c.value,
        path: c.path || "/",
        secure: !!c.secure, httpOnly: !!c.httpOnly,
        sameSite: c.sameSite || "unspecified"
      };
      if (c.domain && !c.hostOnly) details.domain = c.domain;
      if (c.expirationDate && !c.session) details.expirationDate = c.expirationDate;
      await chrome.cookies.set(details).catch(() => {});
    } catch {}
  }

  await applyRuleForTab(tab.id);
  await persistSessionState();
  try { await chrome.tabs.update(tab.id, { url: targetUrl }); } catch {}
  return tab.id;
}); } catch {}
  return tab.id;
}

async function saveJarBack(tabId) {
  await saveAccountLiveState(tabId);
}

// ---------- snapshot management ----------
async function readWebStorage(tabId) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId }, world: "MAIN",
    func: () => ({
      local: (() => {
        const o = {};
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            o[k] = localStorage.getItem(k);
          }
        } catch {}
        return o;
      })(),
      session: (() => {
        const o = {};
        try {
          for (let i = 0; i < sessionStorage.length; i++) {
            const k = sessionStorage.key(i);
            o[k] = sessionStorage.getItem(k);
          }
        } catch {}
        return o;
      })()
    })
  });
  return res?.result || { local: {}, session: {} };
}

async function getDomainCookies(domainKey, hostname) {
  const domains = relatedDomainsOf(domainKey);
  const byId = new Map();
  const addAll = (list) => {
    for (const c of list || []) {
      byId.set(cookieIdentity(c), c);
    }
  };

  await Promise.all([...domains].map(async (d) => {
    try { addAll(await chrome.cookies.getAll({ domain: d })); } catch {}
    try { addAll(await chrome.cookies.getAll({ url: `https://${d}/` })); } catch {}
    try { addAll(await chrome.cookies.getAll({ url: `http://${d}/` })); } catch {}
  }));

  if (hostname) {
    try { addAll(await chrome.cookies.getAll({ url: `https://${hostname}/` })); } catch {}
    try { addAll(await chrome.cookies.getAll({ url: `http://${hostname}/` })); } catch {}
    // Walk parent labels for host-only cookies on subdomains
    const labels = String(hostname).split(".");
    for (let i = 0; i < labels.length - 1; i++) {
      const sub = labels.slice(i).join(".");
      try { addAll(await chrome.cookies.getAll({ domain: sub })); } catch {}
      try { addAll(await chrome.cookies.getAll({ url: `https://${sub}/` })); } catch {}
    }
  }

  return [...byId.values()];
}

function summary(a) {
  const cookies = a.cookies || [];
  const now = Date.now() / 1000;
  let expired = 0;
  for (const c of cookies) if (!c.session && c.expirationDate && c.expirationDate < now) expired++;
  return {
    id: a.id, name: a.name, createdAt: a.createdAt, updatedAt: a.updatedAt,
    cookieCount: cookies.length, expiredCount: expired,
    lsCount: Object.keys(a.storage?.local || {}).length,
    ssCount: Object.keys(a.storage?.session || {}).length
  };
}

async function stateInfo(tabId, hostname) {
  const meta = await readMeta();
  const b = tabBindings.get(tabId);
  return {
    encrypted: !!meta.encrypted,
    locked: !!meta.encrypted && !unlockedKey,
    boundAccountId: b?.accountId || null,
    boundDomainKey: b?.domainKey || null,
    currentDomainKey: hostname ? domainKeyOf(hostname) : null
  };
}

async function listAccounts(hostname) {
  const domainKey = domainKeyOf(hostname);
  const store = await loadStore();
  const arr = store.accounts[domainKey] || [];
  return { domainKey, list: arr.map(summary) };
}

async function snapshotCurrent(tabId, hostname, name) {
  const domainKey = domainKeyOf(hostname);
  const b = tabBindings.get(tabId);
  const cookies = b
    ? JSON.parse(JSON.stringify(tabJars.get(tabId) || []))
    : await getDomainCookies(domainKey, hostname);
  let storage = { local: {}, session: {} };
  try { storage = await readWebStorage(tabId); } catch {}
  const store = await loadStore();
  const now = Date.now();
  const account = {
    id: uuid(),
    name: (name || "").trim() || `账号 ${(store.accounts[domainKey] || []).length + 1}`,
    createdAt: now, updatedAt: now, cookies, storage
  };
  store.accounts[domainKey] = store.accounts[domainKey] || [];
  store.accounts[domainKey].push(account);
  await saveStore(store);
  return account.id;
}

async function updateSnapshot(tabId, hostname, accountId) {
  const domainKey = domainKeyOf(hostname);
  const b = tabBindings.get(tabId);
  const cookies = b
    ? JSON.parse(JSON.stringify(tabJars.get(tabId) || []))
    : await getDomainCookies(domainKey, hostname);
  let storage = { local: {}, session: {} };
  try { storage = await readWebStorage(tabId); } catch {}
  const store = await loadStore();
  const arr = store.accounts[domainKey] || [];
  const idx = arr.findIndex(a => a.id === accountId);
  if (idx < 0) throw new Error("账号不存在");
  arr[idx] = { ...arr[idx], cookies, storage, updatedAt: Date.now() };
  store.accounts[domainKey] = arr;
  await saveStore(store);
  if (b && b.accountId === accountId) {
    tabJars.set(tabId, JSON.parse(JSON.stringify(cookies)));
    tabLocalStore.set(tabId, JSON.parse(JSON.stringify(storage.local || {})));
    tabSessionStore.set(tabId, JSON.parse(JSON.stringify(storage.session || {})));
    await applyRuleForTab(tabId);
    await persistSessionState();
  }
}

async function renameSnapshot(hostname, accountId, name) {
  const domainKey = domainKeyOf(hostname);
  const store = await loadStore();
  const a = (store.accounts[domainKey] || []).find(a => a.id === accountId);
  if (!a) throw new Error("账号不存在");
  a.name = String(name || "").trim() || a.name;
  a.updatedAt = Date.now();
  await saveStore(store);
}

async function deleteSnapshot(hostname, accountId) {
  const domainKey = domainKeyOf(hostname);
  const store = await loadStore();
  store.accounts[domainKey] = (store.accounts[domainKey] || []).filter(a => a.id !== accountId);
  for (const [tid, b] of tabBindings.entries()) {
    if (b.accountId === accountId) {
      tabBindings.delete(tid);
      tabJars.delete(tid);
      tabLocalStore.delete(tid);
      tabSessionStore.delete(tid);
      await removeRuleForTab(tid);
    }
  }
  await saveStore(store);
  await persistSessionState();
}

async function getAccount(hostname, accountId) {
  const domainKey = domainKeyOf(hostname);
  const store = await loadStore();
  const acc = (store.accounts[domainKey] || []).find(a => a.id === accountId);
  if (!acc) throw new Error("账号不存在");
  return JSON.parse(JSON.stringify(acc));
}

function normalizeCookieForSave(raw, defaultHost) {
  const now = Date.now() / 1000;
  const c = {
    name: String(raw.name ?? "").trim(),
    value: String(raw.value ?? ""),
    path: String(raw.path ?? "/") || "/",
    secure: !!raw.secure,
    httpOnly: !!raw.httpOnly,
    sameSite: (raw.sameSite || "unspecified").toLowerCase(),
  };
  if (raw.partitioned) c.partitioned = true;
  if (raw.hostOnly || !raw.domain) {
    c.hostOnly = true;
    if (raw.domain) c.domain = String(raw.domain).replace(/^\./, "").toLowerCase();
    else if (defaultHost) c.domain = defaultHost;
  } else {
    c.hostOnly = false;
    c.domain = String(raw.domain).toLowerCase();
  }
  if (raw.session) {
    c.session = true;
  } else if (raw.expirationDate != null && raw.expirationDate !== "") {
    const t = Number(raw.expirationDate);
    if (!Number.isNaN(t) && t > 0) { c.expirationDate = t; c.session = false; }
    else c.session = true;
  } else {
    c.session = true;
  }
  if (c.name.startsWith("__Host-")) {
    c.secure = true; c.path = "/"; c.hostOnly = true; delete c.domain;
  } else if (c.name.startsWith("__Secure-")) {
    c.secure = true;
  }
  if (!c.name) return null;
  if (c.expirationDate && c.expirationDate <= now) return null;
  return c;
}

async function editAccount(hostname, accountId, patch) {
  const domainKey = domainKeyOf(hostname);
  const store = await loadStore();
  const arr = store.accounts[domainKey] || [];
  const idx = arr.findIndex(a => a.id === accountId);
  if (idx < 0) throw new Error("账号不存在");
  const acc = arr[idx];

  if (Array.isArray(patch?.cookies)) {
    const cleaned = [];
    const seen = new Set();
    for (const raw of patch.cookies) {
      const c = normalizeCookieForSave(raw, hostname);
      if (!c) continue;
      const k = cookieIdentity(c);
      if (seen.has(k)) {
        const dup = cleaned.findIndex(x => cookieIdentity(x) === k);
        if (dup >= 0) cleaned.splice(dup, 1);
      }
      seen.add(k);
      cleaned.push(c);
    }
    acc.cookies = cleaned;
  }
  if (patch?.storage) {
    const local = patch.storage.local && typeof patch.storage.local === "object"
      ? patch.storage.local : (acc.storage?.local || {});
    const session = patch.storage.session && typeof patch.storage.session === "object"
      ? patch.storage.session : (acc.storage?.session || {});
    const norm = (obj) => {
      const out = {};
      for (const [k, v] of Object.entries(obj || {})) {
        if (typeof k !== "string" || !k) continue;
        out[k] = v == null ? "" : String(v);
      }
      return out;
    };
    acc.storage = { local: norm(local), session: norm(session) };
  }
  if (typeof patch?.name === "string" && patch.name.trim()) {
    acc.name = patch.name.trim();
  }
  acc.updatedAt = Date.now();
  arr[idx] = acc;
  store.accounts[domainKey] = arr;
  await saveStore(store);

  for (const [tid, b] of tabBindings.entries()) {
    if (b.domainKey !== domainKey || b.accountId !== accountId) continue;
    if (Array.isArray(patch?.cookies)) {
      tabJars.set(tid, JSON.parse(JSON.stringify(acc.cookies)));
      await applyRuleForTab(tid);
    }
    if (patch?.storage) {
      tabLocalStore.set(tid, JSON.parse(JSON.stringify(acc.storage?.local || {})));
      tabSessionStore.set(tid, JSON.parse(JSON.stringify(acc.storage?.session || {})));
      try {
        chrome.tabs.sendMessage(tid, {
          type: "sc:apply-binding",
          local: acc.storage?.local || {},
          session: acc.storage?.session || {}
        }).catch(() => {});
      } catch {}
    }
  }
  await persistSessionState();
  return summary(acc);
}

async function logoutCurrent(tabId, hostname) {
  const b = tabBindings.get(tabId);
  const domainKey = domainKeyOf(hostname);

  // Always wipe browser global cookies for this site scope.
  // Bound tabs previously only cleared the virtual jar — refresh then re-read
  // global SSO cookies (e.g. bytedance.com for volcengine) and looked "still logged in".
  const cur = await collectLogoutCookies(domainKey, hostname);
  await Promise.all(cur.map((c) => removeCookieBestEffort(c)));

  if (b) {
    tabJars.set(tabId, []);
    tabLocalStore.set(tabId, {});
    tabSessionStore.set(tabId, {});
    await applyRuleForTab(tabId);
    await persistSessionState();
    // Mirror empty state into the bound account snapshot so re-bind stays logged out.
    scheduleAccountSync(tabId);
    await saveAccountLiveState(tabId);
  }

  await clearPageAuthState(tabId);
  try { await chrome.tabs.reload(tabId, { bypassCache: true }); } catch {}
}

// ---------- encryption controls ----------
async function unlock(pw) {
  const meta = await readMeta();
  if (!meta.encrypted) throw new Error("未启用加密");
  const key = await deriveKey(pw, meta.salt);
  const { [LK_CIPHER]: c } = await chrome.storage.local.get(LK_CIPHER);
  if (c) { try { await decryptJson(key, c.iv, c.ct); } catch { throw new Error("主密码错误"); } }
  unlockedKey = key;
}
async function enableEncryption(pw) {
  const meta = await readMeta();
  if (meta.encrypted) throw new Error("已启用");
  const { [LK_PLAIN]: plain } = await chrome.storage.local.get(LK_PLAIN);
  const salt = await createSalt();
  const key = await deriveKey(pw, salt);
  const enc = await encryptJson(key, plain || { accounts: {}, active: {} });
  await chrome.storage.local.set({ [LK_CIPHER]: enc });
  await chrome.storage.local.remove(LK_PLAIN);
  await writeMeta({ encrypted: true, salt });
  unlockedKey = key;
}
async function disableEncryption(pw) {
  const meta = await readMeta();
  if (!meta.encrypted) return;
  const key = await deriveKey(pw, meta.salt);
  const { [LK_CIPHER]: c } = await chrome.storage.local.get(LK_CIPHER);
  let store = { accounts: {}, active: {} };
  if (c) { try { store = await decryptJson(key, c.iv, c.ct); } catch { throw new Error("主密码错误"); } }
  await chrome.storage.local.set({ [LK_PLAIN]: store });
  await chrome.storage.local.remove(LK_CIPHER);
  await writeMeta({ encrypted: false, salt: null });
  unlockedKey = null;
}
async function changePassword(oldPw, newPw) {
  const meta = await readMeta();
  if (!meta.encrypted) throw new Error("未启用");
  const oldKey = await deriveKey(oldPw, meta.salt);
  const { [LK_CIPHER]: c } = await chrome.storage.local.get(LK_CIPHER);
  let store = { accounts: {}, active: {} };
  if (c) { try { store = await decryptJson(oldKey, c.iv, c.ct); } catch { throw new Error("原主密码错误"); } }
  const salt = await createSalt();
  const key = await deriveKey(newPw, salt);
  const enc = await encryptJson(key, store);
  await chrome.storage.local.set({ [LK_CIPHER]: enc });
  await writeMeta({ encrypted: true, salt });
  unlockedKey = key;
}

// ---------- message router ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "state":     return sendResponse({ ok: true, data: await stateInfo(msg.tabId, msg.hostname) });
        case "domainKey": return sendResponse({ ok: true, data: domainKeyOf(msg.hostname) });
        case "list":      return sendResponse({ ok: true, data: await listAccounts(msg.hostname) });

        case "bind":      await bindTab(msg.tabId, msg.hostname, msg.accountId); return sendResponse({ ok: true });
        case "unbind":    await unbindTab(msg.tabId); return sendResponse({ ok: true });
        case "openIn": {
          const id = await openInNewTab(msg.hostname, msg.accountId, msg.url);
          return sendResponse({ ok: true, data: { tabId: id } });
        }

        case "snapshot":  return sendResponse({ ok: true, data: await snapshotCurrent(msg.tabId, msg.hostname, msg.name) });
        case "update":    await updateSnapshot(msg.tabId, msg.hostname, msg.accountId); return sendResponse({ ok: true });
        case "rename":    await renameSnapshot(msg.hostname, msg.accountId, msg.name); return sendResponse({ ok: true });
        case "delete":    await deleteSnapshot(msg.hostname, msg.accountId); return sendResponse({ ok: true });
        case "getAccount": return sendResponse({ ok: true, data: await getAccount(msg.hostname, msg.accountId) });
        case "editAccount": return sendResponse({ ok: true, data: await editAccount(msg.hostname, msg.accountId, msg.patch || {}) });
        case "logout":    await logoutCurrent(msg.tabId, msg.hostname); return sendResponse({ ok: true });
        case "saveJar":   await saveJarBack(msg.tabId); return sendResponse({ ok: true });

        case "unlock":              await unlock(msg.password); return sendResponse({ ok: true });
        case "lock":                unlockedKey = null; return sendResponse({ ok: true });
        case "enableEncryption":    await enableEncryption(msg.password); return sendResponse({ ok: true });
        case "disableEncryption":   await disableEncryption(msg.password); return sendResponse({ ok: true });
        case "changePassword":      await changePassword(msg.oldPassword, msg.newPassword); return sendResponse({ ok: true });

        case "getBinding": {
          const tabId = sender.tab?.id;
          if (tabId == null) return sendResponse({ ok: true, data: { bound: false } });
          const b = tabBindings.get(tabId);
          if (!b) return sendResponse({ ok: true, data: { bound: false } });
          try {
            const u = new URL(msg.href || "");
            if (!hostInBindingScope(u.hostname, b)) {
              return sendResponse({ ok: true, data: { bound: false } });
            }
          } catch {}
          return sendResponse({
            ok: true,
            data: {
              bound: true,
              storage: {
                local: tabLocalStore.get(tabId) || {},
                session: tabSessionStore.get(tabId) || {}
              }
            }
          });
        }

        case "storageChanged": {
          const tabId = sender.tab?.id;
          if (tabId != null && tabBindings.has(tabId)) {
            if (msg.local && typeof msg.local === "object") {
              tabLocalStore.set(tabId, msg.local);
            }
            if (msg.session && typeof msg.session === "object") {
              tabSessionStore.set(tabId, msg.session);
            }
            await persistSessionState();
            scheduleAccountSync(tabId);
          }
          return sendResponse({ ok: true });
        }

        case "setCookie": {
          const tabId = sender.tab?.id;
          if (tabId == null || !tabBindings.has(tabId)) return sendResponse({ ok: true });
          const binding = tabBindings.get(tabId);
          let hrefHost = "";
          try { hrefHost = new URL(msg.href || sender.tab?.url || "").hostname; } catch {}
          if (hrefHost && !hostInBindingScope(hrefHost, binding)) {
            return sendResponse({ ok: true });
          }
          const c = parseSetCookie(msg.header || "");
          if (!c) return sendResponse({ ok: true });
          let jar = tabJars.get(tabId);
          if (!jar) { jar = []; tabJars.set(tabId, jar); }
          mergeIntoJar(jar, c, hrefHost);
          scheduleRuleUpdate(tabId);
          scheduleAccountSync(tabId);
          setTimeout(() => scrubFromGlobalJar({
            ...c,
            secure: c.secure || (msg.href || "").startsWith("https:")
          }), 50);
          return sendResponse({ ok: true });
        }

        default: sendResponse({ ok: false, error: "unknown: " + msg.type });
      }
    } catch (e) {
      console.error("[SwitchCookie]", e);
      sendResponse({
        ok: false,
        error: e?.message || String(e),
        code: e?.message === "LOCKED" ? "LOCKED" : undefined
      });
    }
  })();
  return true;
});
