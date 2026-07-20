// SwitchCookie background service worker (v0.2 - per-tab isolation)
//
// Strategy:
//   - Each tab can be "bound" to a saved account for a specific registrable domain.
//   - When bound, requests from that tab whose host is within the domain are matched
//     by a declarativeNetRequest session rule, and the Cookie header is fully replaced
//     with the account's virtual jar.
//   - Response Set-Cookie headers are captured via webRequest.onHeadersReceived,
//     merged back into the tab's virtual jar. Cookies that also landed in the global
//     jar (browser can't be prevented from doing so in MV3) are immediately removed
//     so they don't leak to other tabs.
//   - Snapshots (cookies + localStorage + sessionStorage + IndexedDB) remain the way
//     users save/restore an "account". Storage is restored when a tab is bound.
//
// Known limits (documented in README):
//   - Service Worker / Web Worker fetches have tabId = -1 → won't be rewritten.
//   - Same-origin concurrent tabs share localStorage/IndexedDB; only cookies are isolated.

import { getRegistrableDomain } from "./lib/psl.js";
import { deriveKey, createSalt, encryptJson, decryptJson } from "./lib/crypto.js";

// ---------- storage keys ----------
const LK_META    = "sc:meta";     // { encrypted, salt }
const LK_CIPHER  = "sc:cipher";
const LK_PLAIN   = "sc:plain";    // { accounts, active }
const LEGACY_ACC = "sc:accounts";
const LEGACY_ACT = "sc:active";

// in-memory state
let unlockedKey = null;                // AES key while unlocked
const tabBindings = new Map();         // tabId -> { domainKey, accountId }
const tabJars     = new Map();         // tabId -> Array<Cookie> (virtual jar for the bound domain)
const tabLocalStore = new Map();      // tabId -> { key: value } (per-tab localStorage snapshot)
const RULE_BASE   = 1_000_000;         // rule id = RULE_BASE + tabId

// ---------- session persistence (survive SW restart) ----------
const SESSION_BINDINGS_KEY = "sc:session:bindings";
const SESSION_JARS_KEY     = "sc:session:jars";
const SESSION_LOCAL_KEY    = "sc:session:local";

async function persistSessionState() {
  try {
    const bindings = {}, jars = {}, locals = {};
    for (const [tabId, b] of tabBindings) {
      const k = String(tabId);
      bindings[k] = b;
      jars[k] = tabJars.get(tabId) || [];
      locals[k] = tabLocalStore.get(tabId) || {};
    }
    await chrome.storage.session.set({
      [SESSION_BINDINGS_KEY]: bindings,
      [SESSION_JARS_KEY]: jars,
      [SESSION_LOCAL_KEY]: locals
    });
  } catch (e) { console.warn("[SwitchCookie] persistSessionState failed", e); }
}

async function restoreSessionState() {
  try {
    const stored = await chrome.storage.session.get([
      SESSION_BINDINGS_KEY, SESSION_JARS_KEY, SESSION_LOCAL_KEY
    ]);
    const bindings = stored[SESSION_BINDINGS_KEY] || {};
    const jars     = stored[SESSION_JARS_KEY] || {};
    const locals   = stored[SESSION_LOCAL_KEY] || {};
    for (const [tabIdStr, binding] of Object.entries(bindings)) {
      const tabId = Number(tabIdStr);
      if (Number.isNaN(tabId)) continue;
      tabBindings.set(tabId, binding);
      tabJars.set(tabId, jars[tabIdStr] || []);
      tabLocalStore.set(tabId, locals[tabIdStr] || {});
      await applyRuleForTab(tabId);
    }
    if (Object.keys(bindings).length > 0) {
      console.log(`[SwitchCookie] restored ${Object.keys(bindings).length} tab binding(s) from session`);
    }
  } catch (e) { console.warn("[SwitchCookie] restoreSessionState failed", e); }
}

// restore on SW start (MV3: service workers disallow top-level await)
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

function serializeCookieHeader(cookies) {
  // We can't (easily) filter by request path; sending the whole domain jar is
  // safe because servers only look up cookies by name.
  const seen = new Set();
  const parts = [];
  for (const c of cookies) {
    if (!c.name) continue;
    if (seen.has(c.name)) continue; // last-write-wins keeps original array order
    seen.add(c.name);
    parts.push(`${c.name}=${c.value}`);
  }
  return parts.join("; ");
}

// Merge a Set-Cookie header line into the jar.
function parseSetCookie(line) {
  // line: "name=value; Path=/; Domain=example.com; ..."
  const [nv, ...attrs] = line.split(";");
  const eq = nv.indexOf("=");
  if (eq < 0) return null;
  const name = nv.slice(0, eq).trim();
  const value = nv.slice(eq + 1).trim();
  const c = { name, value, path: "/", secure: false, httpOnly: false, sameSite: "unspecified" };
  let maxAge = null, expires = null;
  for (const a of attrs) {
    const [k, v] = a.split("=");
    const key = (k || "").trim().toLowerCase();
    const val = (v || "").trim();
    if (key === "path") c.path = val || "/";
    else if (key === "domain") { c.domain = val.toLowerCase(); c.hostOnly = false; }
    else if (key === "secure") c.secure = true;
    else if (key === "httponly") c.httpOnly = true;
    else if (key === "samesite") c.sameSite = val.toLowerCase() || "unspecified";
    else if (key === "max-age") maxAge = Number(val);
    else if (key === "expires") expires = val;
  }
  if (maxAge != null && !Number.isNaN(maxAge)) {
    c.expirationDate = Date.now() / 1000 + maxAge;
    c.session = false;
  } else if (expires) {
    const t = Date.parse(expires);
    if (!Number.isNaN(t)) { c.expirationDate = t / 1000; c.session = false; }
  } else {
    c.session = true;
  }
  if (c.name.startsWith("__Host-")) { c.secure = true; c.path = "/"; c.hostOnly = true; delete c.domain; }
  return c;
}
function mergeIntoJar(jar, incoming, defaultHost) {
  if (!incoming.domain && defaultHost) { incoming.hostOnly = true; incoming.domain = defaultHost; }
  // remove existing same (name, domain, path)
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

// Debounce DNR updates per tab (hot path: onHeadersReceived may fire rapidly).
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

  const addRules = [{
    id: ruleIdFor(tabId),
    priority: 1,
    condition: {
      tabIds: [tabId],
      requestDomains: [binding.domainKey],
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

// Remove a cookie from the global browser jar (best effort).
async function scrubFromGlobalJar(cookie) {
  const url = cookieUrl(cookie);
  try {
    const opts = { url, name: cookie.name };
    if (cookie.storeId) opts.storeId = cookie.storeId;
    await chrome.cookies.remove(opts);
  } catch {}
}

// ---------- webRequest: absorb Set-Cookie headers ----------
chrome.webRequest.onHeadersReceived.addListener((details) => {
  const tabId = details.tabId;
  if (tabId < 0) return;
  const binding = tabBindings.get(tabId);
  if (!binding) return;
  try {
    const u = new URL(details.url);
    if (domainKeyOf(u.hostname) !== binding.domainKey) return;
    let jar = tabJars.get(tabId);
    if (!jar) { jar = []; tabJars.set(tabId, jar); }
    let touched = false;
    for (const h of details.responseHeaders || []) {
      if ((h.name || "").toLowerCase() !== "set-cookie") continue;
      const line = h.value || "";
      // A single header may contain multiple cookies separated by newline in Chrome's model.
      for (const one of line.split(/\r?\n/)) {
        const c = parseSetCookie(one);
        if (!c) continue;
        mergeIntoJar(jar, c, u.hostname);
        touched = true;
        // Also remove from global jar shortly after so other (unbound) tabs don't inherit it.
        setTimeout(() => scrubFromGlobalJar({ ...c, secure: c.secure || u.protocol === "https:" }), 50);
      }
    }
    if (touched) scheduleRuleUpdate(tabId); // debounced refresh for subsequent requests
  } catch (e) { console.warn("[SwitchCookie] onHeadersReceived error", e); }
}, { urls: ["<all_urls>"] }, ["responseHeaders", "extraHeaders"]);

// ---------- tab lifecycle ----------
chrome.tabs.onRemoved.addListener(async (tabId) => {
  tabBindings.delete(tabId);
  tabJars.delete(tabId);
  tabLocalStore.delete(tabId);
  await removeRuleForTab(tabId);
  await persistSessionState();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  // If the tab navigates off-domain, keep binding but the DNR requestDomains
  // simply won't match, which is correct. Nothing to do here for now.
});

chrome.runtime.onStartup.addListener(() => { /* session rules & memory reset naturally */ });

// ---------- per-tab binding & unbinding ----------
async function bindTab(tabId, hostname, accountId) {
  const domainKey = domainKeyOf(hostname);
  const store = await loadStore();
  const acc = (store.accounts[domainKey] || []).find(a => a.id === accountId);
  if (!acc) throw new Error("账号不存在");
  tabBindings.set(tabId, { domainKey, accountId });
  tabJars.set(tabId, JSON.parse(JSON.stringify(acc.cookies || [])));
  tabLocalStore.set(tabId, JSON.parse(JSON.stringify(acc.storage?.local || {})));
  await applyRuleForTab(tabId);
  await persistSessionState();
  // Reload; on document_start the bridge will pull binding via getBinding.
  try { await chrome.tabs.reload(tabId); } catch {}
}

async function unbindTab(tabId) {
  tabBindings.delete(tabId);
  tabJars.delete(tabId);
  tabLocalStore.delete(tabId);
  await removeRuleForTab(tabId);
  await persistSessionState();
  try {
    // Notify all frames in that tab so proxies stop isolating (in case user reloads later).
    await chrome.tabs.sendMessage(tabId, { type: "sc:clear-binding" }).catch(() => {});
  } catch {}
  try { await chrome.tabs.reload(tabId); } catch {}
}

async function openInNewTab(hostname, accountId, url) {
  const targetUrl = url || `https://${hostname}/`;
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  await bindTab(tab.id, hostname, accountId);
  try { await chrome.tabs.update(tab.id, { url: targetUrl }); } catch {}
  return tab.id;
}

async function saveJarBack(tabId) {
  // Persist the tab's live cookies back into the bound account snapshot.
  const b = tabBindings.get(tabId);
  const jar = tabJars.get(tabId);
  if (!b || !jar) return;
  const store = await loadStore();
  const arr = store.accounts[b.domainKey] || [];
  const idx = arr.findIndex(a => a.id === b.accountId);
  if (idx < 0) return;
  arr[idx] = { ...arr[idx], cookies: JSON.parse(JSON.stringify(jar)), updatedAt: Date.now() };
  store.accounts[b.domainKey] = arr;
  await saveStore(store);
}

// ---------- snapshot management (mostly reused from v0.1) ----------
async function readWebStorage(tabId) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId }, world: "MAIN",
    func: () => ({
      local: (() => { const o = {}; try { for (let i=0;i<localStorage.length;i++) { const k=localStorage.key(i); o[k]=localStorage.getItem(k); } } catch {} return o; })(),
      session: (() => { const o = {}; try { for (let i=0;i<sessionStorage.length;i++) { const k=sessionStorage.key(i); o[k]=sessionStorage.getItem(k); } } catch {} return o; })()
    })
  });
  return res?.result || { local: {}, session: {} };
}

async function getDomainCookies(domainKey) {
  return chrome.cookies.getAll({ domain: domainKey });
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
  // If tab is bound, snapshot its virtual jar; else snapshot global cookies.
  const b = tabBindings.get(tabId);
  const cookies = b ? JSON.parse(JSON.stringify(tabJars.get(tabId) || [])) : await getDomainCookies(domainKey);
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
  const cookies = b ? JSON.parse(JSON.stringify(tabJars.get(tabId) || [])) : await getDomainCookies(domainKey);
  let storage = { local: {}, session: {} };
  try { storage = await readWebStorage(tabId); } catch {}
  const store = await loadStore();
  const arr = store.accounts[domainKey] || [];
  const idx = arr.findIndex(a => a.id === accountId);
  if (idx < 0) throw new Error("账号不存在");
  arr[idx] = { ...arr[idx], cookies, storage, updatedAt: Date.now() };
  store.accounts[domainKey] = arr;
  await saveStore(store);
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
    if (b.accountId === accountId) { tabBindings.delete(tid); tabJars.delete(tid); await removeRuleForTab(tid); }
  }
  await saveStore(store);
  await persistSessionState();
}
// Return the full raw snapshot (cookies + storage) for editing.
async function getAccount(hostname, accountId) {
  const domainKey = domainKeyOf(hostname);
  const store = await loadStore();
  const acc = (store.accounts[domainKey] || []).find(a => a.id === accountId);
  if (!acc) throw new Error("账号不存在");
  return JSON.parse(JSON.stringify(acc));
}

// Normalize a cookie edited in the UI. Missing fields fall back to safe defaults.
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
    else { c.session = true; }
  } else {
    c.session = true;
  }
  if (c.name.startsWith("__Host-")) { c.secure = true; c.path = "/"; c.hostOnly = true; delete c.domain; }
  if (!c.name) return null;
  if (c.expirationDate && c.expirationDate <= now) return null;
  return c;
}

// Persist edited cookies/storage back to the snapshot; sync any bound tabs.
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
    const keyOf = (x) => `${x.name}\u0000${(x.domain || "").replace(/^\./, "").toLowerCase()}\u0000${x.path || "/"}`;
    for (const raw of patch.cookies) {
      const c = normalizeCookieForSave(raw, hostname);
      if (!c) continue;
      const k = keyOf(c);
      if (seen.has(k)) {
        const dup = cleaned.findIndex(x => keyOf(x) === k);
        if (dup >= 0) cleaned.splice(dup, 1);
      }
      seen.add(k);
      cleaned.push(c);
    }
    acc.cookies = cleaned;
  }
  if (patch?.storage) {
    const local = patch.storage.local && typeof patch.storage.local === "object" ? patch.storage.local : (acc.storage?.local || {});
    const session = patch.storage.session && typeof patch.storage.session === "object" ? patch.storage.session : (acc.storage?.session || {});
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

  // Sync any live tabs currently bound to this account.
  for (const [tid, b] of tabBindings.entries()) {
    if (b.domainKey !== domainKey || b.accountId !== accountId) continue;
    if (Array.isArray(patch?.cookies)) {
      tabJars.set(tid, JSON.parse(JSON.stringify(acc.cookies)));
      await applyRuleForTab(tid);
    }
    if (patch?.storage) {
      tabLocalStore.set(tid, JSON.parse(JSON.stringify(acc.storage?.local || {})));
      try {
        chrome.tabs.sendMessage(tid, {
          type: "sc:apply-binding",
          local: acc.storage?.local || {}
        }).catch(() => {});
      } catch {}
    }
  }
  await persistSessionState();
  return summary(acc);
}

// Clear current tab's session (isolated if bound, else global for the domain).
async function logoutCurrent(tabId, hostname) {
  const b = tabBindings.get(tabId);
  const domainKey = domainKeyOf(hostname);
  if (b) {
    tabJars.set(tabId, []);
    await applyRuleForTab(tabId);
    await persistSessionState();
  } else {
    const cur = await getDomainCookies(domainKey);
    await Promise.all(cur.map(c => chrome.cookies.remove({ url: cookieUrl(c), name: c.name, storeId: c.storeId }).catch(()=>{})));
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId }, world: "MAIN",
      func: () => { try { localStorage.clear(); } catch {} try { sessionStorage.clear(); } catch {} }
    });
  } catch {}
  try { await chrome.tabs.reload(tabId); } catch {}
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
        case "openIn":    { const id = await openInNewTab(msg.hostname, msg.accountId, msg.url); return sendResponse({ ok: true, data: { tabId: id } }); }

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
            if (domainKeyOf(u.hostname) !== b.domainKey) return sendResponse({ ok: true, data: { bound: false } });
          } catch {}
          return sendResponse({ ok: true, data: { bound: true, storage: { local: tabLocalStore.get(tabId) || {} } } });
        }
        case "storageChanged": {
          const tabId = sender.tab?.id;
          if (tabId != null && tabBindings.has(tabId)) tabLocalStore.set(tabId, msg.local || {});
          return sendResponse({ ok: true });
        }
        default: sendResponse({ ok: false, error: "unknown: " + msg.type });
      }
    } catch (e) {
      console.error("[SwitchCookie]", e);
      sendResponse({ ok: false, error: e?.message || String(e), code: e?.message === "LOCKED" ? "LOCKED" : undefined });
    }
  })();
  return true;
});

