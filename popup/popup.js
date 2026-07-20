// SwitchCookie popup (v0.2 - per-tab isolation)
const $ = (id) => document.getElementById(id);

const state = {
  tabId: null, url: null, hostname: null, domainKey: null,
  supported: false,
  encrypted: false, locked: false,
  boundAccountId: null, boundDomainKey: null,
  list: [],
  editing: null,
  editorTab: "cookies",
  editorFilter: ""
};

function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp?.ok) {
        const err = new Error(resp?.error || "未知错误");
        err.code = resp?.code;
        return reject(err);
      }
      resolve(resp.data);
    });
  });
}

let toastTimer = null;
function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 1800);
}

function showPrompt(title, initial = "", type = "text") {
  return new Promise((resolve) => {
    const dlg = $("dialog");
    $("dialogTitle").textContent = title;
    const input = $("dialogInput");
    input.type = type;
    input.value = initial;
    dlg.hidden = false;
    setTimeout(() => input.focus(), 30);
    const done = (v) => {
      dlg.hidden = true;
      $("dialogOk").onclick = null;
      $("dialogCancel").onclick = null;
      input.onkeydown = null;
      dlg.querySelector(".dialog-mask").onclick = null;
      resolve(v);
    };
    $("dialogOk").onclick = () => done(input.value.trim());
    $("dialogCancel").onclick = () => done(null);
    dlg.querySelector(".dialog-mask").onclick = () => done(null);
    input.onkeydown = (e) => {
      if (e.key === "Enter") done(input.value.trim());
      else if (e.key === "Escape") done(null);
    };
  });
}
function showConfirm(title, body) {
  return new Promise((resolve) => {
    const dlg = $("confirmDialog");
    $("confirmTitle").textContent = title;
    $("confirmBody").textContent = body;
    dlg.hidden = false;
    const done = (v) => {
      dlg.hidden = true;
      $("confirmOk").onclick = null;
      $("confirmCancel").onclick = null;
      dlg.querySelector(".dialog-mask").onclick = null;
      resolve(v);
    };
    $("confirmOk").onclick = () => done(true);
    $("confirmCancel").onclick = () => done(false);
    dlg.querySelector(".dialog-mask").onclick = () => done(false);
  });
}

function initialsOf(name) {
  if (!name) return "?";
  const s = name.trim(); if (!s) return "?";
  const first = s.charAt(0);
  if (/[\u4e00-\u9fa5]/.test(first)) return first;
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}
function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts), diff = (Date.now() - d) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return Math.floor(diff/60) + " 分钟前";
  if (diff < 86400) return Math.floor(diff/3600) + " 小时前";
  if (diff < 86400*7) return Math.floor(diff/86400) + " 天前";
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function iconSvg(name) {
  const paths = {
    open:  '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    update:'<polyline points="23 4 23 10 17 10"/><path d="M20.49 15A9 9 0 1 1 18.36 5.64L23 10"/>',
    rename:'<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>',
    delete:'<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>',
    edit:  '<path d="M12 20h9"/><path d="M4 20l4-1 10-10a2.121 2.121 0 0 0-3-3L5 16l-1 4z"/>'
  };
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}

function render() {
  $("hostLabel").textContent = state.hostname
    ? `${state.hostname}${state.domainKey && state.domainKey !== state.hostname ? "  ·  组: " + state.domainKey : ""}`
    : "当前标签页不可用";
  const bindBar = $("bindBar");
  if (state.boundAccountId) {
    const acc = state.list.find(a => a.id === state.boundAccountId);
    bindBar.hidden = false;
    bindBar.querySelector(".bind-text").textContent =
      `此标签已隔离绑定：${acc ? acc.name : state.boundAccountId.slice(0,6)}`;
  } else {
    bindBar.hidden = true;
  }

  const list = $("accountList"), empty = $("emptyState"),
        footer = $("mainFooter"), lockPanel = $("lockPanel"),
        editorView = $("editorView"), editorFooter = $("editorFooter"),
        backBtn = $("backBtn");

  if (state.editing) {
    lockPanel.hidden = true;
    list.innerHTML = "";
    list.hidden = true;
    empty.hidden = true;
    footer.hidden = true;
    editorView.hidden = false;
    editorFooter.hidden = false;
    backBtn.hidden = false;
    renderEditor();
    return;
  }
  list.hidden = false;
  editorView.hidden = true;
  editorFooter.hidden = true;
  backBtn.hidden = true;

  if (state.encrypted && state.locked) {
    lockPanel.hidden = false;
    list.innerHTML = "";
    empty.hidden = true;
    footer.hidden = true;
    return;
  }
  lockPanel.hidden = true;
  footer.hidden = false;
  list.innerHTML = "";

  if (!state.supported) {
    empty.hidden = false;
    empty.querySelector(".empty-title").textContent = "此页面暂不支持";
    empty.querySelector(".empty-desc").textContent = "请在普通的 http(s) 网站上使用 SwitchCookie。";
    $("addBtn").disabled = true;
    return;
  }
  $("addBtn").disabled = false;

  if (!state.list.length) {
    empty.hidden = false;
    empty.querySelector(".empty-title").textContent = "还没有保存的账号";
    empty.querySelector(".empty-desc").textContent = "先在网页里正常登录，然后点击下方按钮把当前身份保存起来。";
    return;
  }
  empty.hidden = true;

  for (const acc of state.list) {
    const item = document.createElement("div");
    const isBound = acc.id === state.boundAccountId;
    item.className = "account" + (isBound ? " active" : "");
    item.dataset.id = acc.id;
    const badges = [];
    badges.push(`<span class="badge">🍪 ${acc.cookieCount}</span>`);
    if (acc.expiredCount > 0) badges.push(`<span class="badge warn">⚠ ${acc.expiredCount} 过期</span>`);
    const storageTotal = acc.lsCount + acc.ssCount;
    if (storageTotal > 0) badges.push(`<span class="badge">📦 ${storageTotal}</span>`);
    badges.push(`<span class="badge">${formatTime(acc.updatedAt)}</span>`);

    item.innerHTML = `
      <div class="avatar">${escapeHtml(initialsOf(acc.name))}</div>
      <div class="account-body">
        <div class="account-name">${escapeHtml(acc.name)}${isBound ? ' <span class="tag">当前标签</span>' : ''}</div>
        <div class="account-meta">${badges.join("")}</div>
      </div>
      <div class="actions">
        <button class="action-btn" data-act="open" title="在新标签页中以此账号打开">${iconSvg("open")}</button>
        <button class="action-btn" data-act="edit" title="编辑 Cookie / 存储">${iconSvg("edit")}</button>
        <button class="action-btn" data-act="update" title="用当前身份覆盖此账号">${iconSvg("update")}</button>
        <button class="action-btn" data-act="rename" title="重命名">${iconSvg("rename")}</button>
        <button class="action-btn danger" data-act="delete" title="删除">${iconSvg("delete")}</button>
      </div>
    `;
    list.appendChild(item);
  }
}

async function refreshList() {
  if (!state.supported || (state.encrypted && state.locked)) return;
  const data = await send({ type: "list", hostname: state.hostname });
  state.list = data.list.sort((a, b) => b.updatedAt - a.updatedAt);
  render();
}

async function refreshState() {
  const s = await send({ type: "state", tabId: state.tabId, hostname: state.hostname });
  state.encrypted = s.encrypted;
  state.locked = s.locked;
  state.boundAccountId = s.boundAccountId;
  state.boundDomainKey = s.boundDomainKey;
}

async function bootstrap() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab?.id ?? null;
  state.url = tab?.url ?? "";
  try {
    const u = new URL(state.url);
    if (u.protocol === "http:" || u.protocol === "https:") {
      state.supported = true;
      state.hostname = u.hostname;
      state.domainKey = await send({ type: "domainKey", hostname: state.hostname });
    }
  } catch {}
  await refreshState();
  if (state.supported && !(state.encrypted && state.locked)) await refreshList();
  render();
}

// ---- events ----
$("addBtn").addEventListener("click", async () => {
  const name = await showPrompt("给这个账号起个名字", `账号 ${state.list.length + 1}`);
  if (name === null) return;
  try {
    await send({ type: "snapshot", tabId: state.tabId, hostname: state.hostname, name });
    toast("已保存当前身份");
    await refreshList();
  } catch (e) { toast("保存失败：" + e.message); }
});

$("logoutBtn").addEventListener("click", async () => {
  if (!state.supported) return;
  const yes = await showConfirm(
    "清空此标签的登录状态？",
    state.boundAccountId
      ? "将清空此标签的虚拟身份 Cookie 与本地存储。已保存的账号快照不会被删除。"
      : "将清空整个浏览器在此站点的 Cookie 与本地存储（会影响其他标签）。"
  );
  if (!yes) return;
  try {
    await send({ type: "logout", tabId: state.tabId, hostname: state.hostname });
    toast("已注销");
    await refreshState();
    await refreshList();
    render();
  } catch (e) { toast("失败：" + e.message); }
});

$("unbindBtn").addEventListener("click", async () => {
  try {
    await send({ type: "unbind", tabId: state.tabId });
    toast("已解除隔离");
    await refreshState();
    render();
  } catch (e) { toast("失败：" + e.message); }
});

$("accountList").addEventListener("click", async (e) => {
  const btn = e.target.closest(".action-btn");
  const card = e.target.closest(".account");
  if (!card) return;
  const id = card.dataset.id;
  const acc = state.list.find(a => a.id === id);
  if (!acc) return;

  if (btn) {
    e.stopPropagation();
    const act = btn.dataset.act;
    try {
      if (act === "open") {
        await send({ type: "openIn", hostname: state.hostname, accountId: id, url: state.url });
        toast(`已在新标签打开：${acc.name}`);
        window.close();
        return;
      }
      if (act === "edit") {
        await openEditor(id);
        return;
      }
      if (act === "update") {
        const yes = await showConfirm("覆盖此账号？", `将用当前标签的登录状态覆盖「${acc.name}」的快照。`);
        if (!yes) return;
        await send({ type: "update", tabId: state.tabId, hostname: state.hostname, accountId: id });
        toast("已覆盖");
      } else if (act === "rename") {
        const name = await showPrompt("重命名账号", acc.name);
        if (!name) return;
        await send({ type: "rename", hostname: state.hostname, accountId: id, name });
      } else if (act === "delete") {
        const yes = await showConfirm("删除账号快照？", `将永久删除账号「${acc.name}」的快照，无法恢复。`);
        if (!yes) return;
        await send({ type: "delete", hostname: state.hostname, accountId: id });
        toast("已删除");
      }
      await refreshState();
      await refreshList();
      render();
    } catch (err) { toast("失败：" + err.message); }
    return;
  }

  // 卡片点击：绑定到当前标签（隔离）
  if (id === state.boundAccountId) { toast("当前标签已绑定此账号"); return; }
  try {
    await send({ type: "bind", tabId: state.tabId, hostname: state.hostname, accountId: id });
    toast(`已绑定「${acc.name}」到此标签`);
    window.close();
  } catch (err) { toast("失败：" + err.message); }
});

// ---- unlock ----
$("unlockBtn").addEventListener("click", async () => {
  const pw = $("unlockInput").value;
  if (!pw) return;
  try {
    await send({ type: "unlock", password: pw });
    $("unlockInput").value = "";
    await refreshState();
    await refreshList();
    render();
    toast("已解锁");
  } catch (e) { toast(e.message); }
});
$("unlockInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("unlockBtn").click(); });

// ---- settings ----
async function openSettings() {
  await refreshState();
  $("encStatus").textContent = state.encrypted
    ? (state.locked ? "已启用（已锁定）" : "已启用") : "未启用";
  $("toggleEncBtn").textContent = state.encrypted ? "关闭" : "启用";
  $("changePwRow").hidden = !state.encrypted;
  $("lockRow").hidden = !state.encrypted || state.locked;
  $("settingsDialog").hidden = false;
}
$("settingsBtn").addEventListener("click", () => { try { chrome.runtime.openOptionsPage(); window.close(); } catch { window.open(chrome.runtime.getURL("options/options.html")); } });
$("settingsClose").addEventListener("click", () => { $("settingsDialog").hidden = true; });
$("settingsDialog").querySelector(".dialog-mask").addEventListener("click", () => { $("settingsDialog").hidden = true; });
$("toggleEncBtn").addEventListener("click", async () => {
  $("settingsDialog").hidden = true;
  if (!state.encrypted) {
    const pw = await showPrompt("设置主密码（至少 6 位）", "", "password"); if (!pw) return;
    if (pw.length < 6) return toast("密码至少 6 位");
    const pw2 = await showPrompt("再次输入主密码以确认", "", "password"); if (pw2 !== pw) return toast("两次输入不一致");
    try { await send({ type: "enableEncryption", password: pw }); toast("已启用"); } catch (e) { toast(e.message); }
  } else {
    const pw = await showPrompt("输入主密码以关闭加密", "", "password"); if (!pw) return;
    try { await send({ type: "disableEncryption", password: pw }); toast("已关闭"); } catch (e) { toast(e.message); }
  }
  await refreshState(); await refreshList(); render();
});
$("changePwBtn").addEventListener("click", async () => {
  $("settingsDialog").hidden = true;
  const oldPw = await showPrompt("输入当前主密码", "", "password"); if (!oldPw) return;
  const newPw = await showPrompt("输入新的主密码（至少 6 位）", "", "password"); if (!newPw) return;
  if (newPw.length < 6) return toast("新密码至少 6 位");
  const newPw2 = await showPrompt("再次输入新的主密码", "", "password"); if (newPw !== newPw2) return toast("两次输入不一致");
  try { await send({ type: "changePassword", oldPassword: oldPw, newPassword: newPw }); toast("已修改"); }
  catch (e) { toast(e.message); }
});
$("lockNowBtn").addEventListener("click", async () => {
  $("settingsDialog").hidden = true;
  await send({ type: "lock" });
  await refreshState(); render();
  toast("已锁定");
});


// ---- editor ----
async function openEditor(accountId) {
  try {
    const acc = await send({ type: "getAccount", hostname: state.hostname, accountId });
    state.editing = {
      id: acc.id,
      name: acc.name,
      cookies: (acc.cookies || []).map(c => ({ ...c })),
      storage: {
        local: { ...(acc.storage?.local || {}) },
        session: { ...(acc.storage?.session || {}) }
      }
    };
    state.editorTab = "cookies";
    state.editorFilter = "";
    $("editorName").value = acc.name || "";
    $("editorSearch").value = "";
    for (const t of document.querySelectorAll("#editorTabs .tab")) {
      t.classList.toggle("active", t.dataset.tab === "cookies");
    }
    render();
  } catch (e) { toast("打开失败：" + e.message); }
}

function closeEditor(silent = false) {
  state.editing = null;
  render();
  if (!silent) toast("已取消编辑");
}

function formatExpiry(ts) {
  if (!ts) return "会话";
  try {
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  } catch { return "—"; }
}

function truncate(s, n = 48) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function renderEditor() {
  const editing = state.editing;
  if (!editing) return;
  $("cntCookies").textContent = editing.cookies.length;
  $("cntLocal").textContent = Object.keys(editing.storage.local).length;
  $("cntSession").textContent = Object.keys(editing.storage.session).length;
  $("editorAddLabel").textContent = state.editorTab === "cookies" ? "新增 Cookie" : "新增键值";

  const listEl = $("editorList");
  const emptyEl = $("editorEmpty");
  listEl.innerHTML = "";
  const filter = state.editorFilter.trim().toLowerCase();

  if (state.editorTab === "cookies") {
    const rows = editing.cookies
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => !filter || c.name.toLowerCase().includes(filter) || (c.domain || "").toLowerCase().includes(filter));
    if (!rows.length) {
      emptyEl.hidden = false;
      emptyEl.textContent = editing.cookies.length ? "没有匹配的 Cookie" : "暂无 Cookie，点击右上角新增";
      return;
    }
    emptyEl.hidden = true;
    for (const { c, i } of rows) {
      const item = document.createElement("div");
      item.className = "kv-item";
      item.dataset.kind = "cookie";
      item.dataset.idx = String(i);
      const chips = [];
      chips.push(`<span class="chip primary">${escapeHtml((c.domain || "host") + (c.path || "/"))}</span>`);
      chips.push(`<span class="chip">${escapeHtml(c.session ? "Session" : formatExpiry(c.expirationDate))}</span>`);
      if (c.secure) chips.push(`<span class="chip">Secure</span>`);
      if (c.httpOnly) chips.push(`<span class="chip">HttpOnly</span>`);
      if (c.hostOnly) chips.push(`<span class="chip">Host</span>`);
      if (c.sameSite && c.sameSite !== "unspecified") chips.push(`<span class="chip">SS=${escapeHtml(c.sameSite)}</span>`);
      item.innerHTML = `
        <div class="kv-main">
          <div class="kv-key">${escapeHtml(c.name)}</div>
          <div class="kv-val">${escapeHtml(truncate(c.value, 80))}</div>
          <div class="kv-meta">${chips.join("")}</div>
        </div>
        <button class="action-btn" data-act="kv-edit" title="编辑">${iconSvg("edit")}</button>
        <button class="action-btn danger" data-act="kv-del" title="删除">${iconSvg("delete")}</button>
      `;
      listEl.appendChild(item);
    }
  } else {
    const bag = editing.storage[state.editorTab] || {};
    const keys = Object.keys(bag)
      .filter(k => !filter || k.toLowerCase().includes(filter))
      .sort();
    if (!keys.length) {
      emptyEl.hidden = false;
      emptyEl.textContent = Object.keys(bag).length ? "没有匹配的键" : "暂无键值，点击右上角新增";
      return;
    }
    emptyEl.hidden = true;
    for (const k of keys) {
      const v = bag[k];
      const item = document.createElement("div");
      item.className = "kv-item";
      item.dataset.kind = state.editorTab;
      item.dataset.key = k;
      item.innerHTML = `
        <div class="kv-main">
          <div class="kv-key">${escapeHtml(k)}</div>
          <div class="kv-val">${escapeHtml(truncate(v, 120))}</div>
        </div>
        <button class="action-btn" data-act="kv-edit" title="编辑">${iconSvg("edit")}</button>
        <button class="action-btn danger" data-act="kv-del" title="删除">${iconSvg("delete")}</button>
      `;
      listEl.appendChild(item);
    }
  }
}

function toLocalInputValue(sec) {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fromLocalInputValue(v) {
  if (!v) return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return t / 1000;
}

function openCookieDialog(existing) {
  const dlg = $("cookieDialog");
  const isNew = !existing;
  $("cookieDlgTitle").textContent = isNew ? "新增 Cookie" : "编辑 Cookie";
  const c = existing || {
    name: "", value: "", domain: state.hostname || "", path: "/",
    secure: false, httpOnly: false, hostOnly: true,
    sameSite: "unspecified", session: true, expirationDate: null
  };
  $("ckName").value = c.name || "";
  $("ckValue").value = c.value || "";
  $("ckDomain").value = c.domain || "";
  $("ckPath").value = c.path || "/";
  $("ckSameSite").value = c.sameSite || "unspecified";
  $("ckSecure").checked = !!c.secure;
  $("ckHttpOnly").checked = !!c.httpOnly;
  $("ckHostOnly").checked = !!c.hostOnly;
  const isSession = !!c.session || !c.expirationDate;
  $("ckSession").checked = isSession;
  $("ckExpires").value = isSession ? "" : toLocalInputValue(c.expirationDate);
  $("ckExpires").disabled = isSession;
  $("cookieDeleteBtn").hidden = isNew;
  dlg.hidden = false;

  return new Promise((resolve) => {
    const done = (result) => {
      dlg.hidden = true;
      $("cookieOkBtn").onclick = null;
      $("cookieCancelBtn").onclick = null;
      $("cookieDeleteBtn").onclick = null;
      $("ckSession").onchange = null;
      dlg.querySelector(".dialog-mask").onclick = null;
      resolve(result);
    };
    $("ckSession").onchange = () => { $("ckExpires").disabled = $("ckSession").checked; };
    $("cookieOkBtn").onclick = () => {
      const name = $("ckName").value.trim();
      if (!name) return toast("名称不能为空");
      const session = $("ckSession").checked;
      const exp = session ? null : fromLocalInputValue($("ckExpires").value);
      if (!session && !exp) return toast("请填写有效过期时间");
      done({ action: "save", cookie: {
        ...c,
        name,
        value: $("ckValue").value,
        domain: $("ckDomain").value.trim(),
        path: ($("ckPath").value.trim() || "/"),
        sameSite: $("ckSameSite").value,
        secure: $("ckSecure").checked,
        httpOnly: $("ckHttpOnly").checked,
        hostOnly: $("ckHostOnly").checked,
        session,
        expirationDate: session ? undefined : exp
      } });
    };
    $("cookieCancelBtn").onclick = () => done({ action: "cancel" });
    $("cookieDeleteBtn").onclick = () => done({ action: "delete" });
    dlg.querySelector(".dialog-mask").onclick = () => done({ action: "cancel" });
  });
}

function openKvDialog(existingKey, existingValue) {
  const dlg = $("kvDialog");
  const isNew = existingKey == null;
  $("kvDlgTitle").textContent = (isNew ? "新增" : "编辑") +
    (state.editorTab === "local" ? " localStorage" : " sessionStorage") + " 项";
  $("kvKey").value = existingKey || "";
  $("kvKey").disabled = !isNew;
  $("kvValue").value = existingValue == null ? "" : existingValue;
  $("kvDeleteBtn").hidden = isNew;
  dlg.hidden = false;
  return new Promise((resolve) => {
    const done = (result) => {
      dlg.hidden = true;
      $("kvOkBtn").onclick = null;
      $("kvCancelBtn").onclick = null;
      $("kvDeleteBtn").onclick = null;
      dlg.querySelector(".dialog-mask").onclick = null;
      resolve(result);
    };
    $("kvOkBtn").onclick = () => {
      const key = $("kvKey").value.trim();
      if (!key) return toast("键不能为空");
      done({ action: "save", key, value: $("kvValue").value });
    };
    $("kvCancelBtn").onclick = () => done({ action: "cancel" });
    $("kvDeleteBtn").onclick = () => done({ action: "delete" });
    dlg.querySelector(".dialog-mask").onclick = () => done({ action: "cancel" });
  });
}

$("editorTabs").addEventListener("click", (e) => {
  const t = e.target.closest(".tab");
  if (!t) return;
  const kind = t.dataset.tab;
  if (kind === state.editorTab) return;
  state.editorTab = kind;
  state.editorFilter = "";
  $("editorSearch").value = "";
  for (const el of document.querySelectorAll("#editorTabs .tab")) {
    el.classList.toggle("active", el.dataset.tab === kind);
  }
  renderEditor();
});

$("editorSearch").addEventListener("input", (e) => {
  state.editorFilter = e.target.value || "";
  renderEditor();
});

$("editorAddBtn").addEventListener("click", async () => {
  if (!state.editing) return;
  if (state.editorTab === "cookies") {
    const res = await openCookieDialog(null);
    if (res?.action === "save") { state.editing.cookies.push(res.cookie); renderEditor(); }
  } else {
    const res = await openKvDialog(null, "");
    if (res?.action === "save") {
      const bag = state.editing.storage[state.editorTab];
      if (bag[res.key] != null) { toast("键已存在"); return; }
      bag[res.key] = res.value;
      renderEditor();
    }
  }
});

$("editorList").addEventListener("click", async (e) => {
  const item = e.target.closest(".kv-item");
  if (!item || !state.editing) return;
  const actBtn = e.target.closest(".action-btn");
  const act = actBtn?.dataset.act || "kv-edit";
  if (item.dataset.kind === "cookie") {
    const idx = Number(item.dataset.idx);
    const cookie = state.editing.cookies[idx];
    if (!cookie) return;
    if (act === "kv-del") {
      const yes = await showConfirm("删除 Cookie？", `将从此账号快照移除「${cookie.name}」。仍需点击底部保存才会生效。`);
      if (!yes) return;
      state.editing.cookies.splice(idx, 1);
      renderEditor();
      return;
    }
    const res = await openCookieDialog(cookie);
    if (res?.action === "save") { state.editing.cookies[idx] = res.cookie; renderEditor(); }
    else if (res?.action === "delete") { state.editing.cookies.splice(idx, 1); renderEditor(); }
  } else {
    const key = item.dataset.key;
    const bag = state.editing.storage[item.dataset.kind];
    if (!(key in bag)) return;
    if (act === "kv-del") {
      const yes = await showConfirm("删除键值？", `将从此账号快照移除键「${key}」。仍需点击底部保存才会生效。`);
      if (!yes) return;
      delete bag[key];
      renderEditor();
      return;
    }
    const res = await openKvDialog(key, bag[key]);
    if (res?.action === "save") { bag[res.key] = res.value; renderEditor(); }
    else if (res?.action === "delete") { delete bag[key]; renderEditor(); }
  }
});

$("editorSaveBtn").addEventListener("click", async () => {
  if (!state.editing) return;
  const patch = {
    name: ($("editorName").value || "").trim() || undefined,
    cookies: state.editing.cookies,
    storage: state.editing.storage
  };
  try {
    await send({ type: "editAccount", hostname: state.hostname, accountId: state.editing.id, patch });
    toast("已保存修改");
    state.editing = null;
    await refreshList();
    render();
  } catch (e) { toast("保存失败：" + e.message); }
});

$("editorCancelBtn").addEventListener("click", () => closeEditor());
$("backBtn").addEventListener("click", () => { if (state.editing) closeEditor(true); });

bootstrap();