// SwitchCookie options page
const $ = (id) => document.getElementById(id);

function send(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp?.ok) return reject(new Error(resp?.error || "未知错误"));
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

function showPrompt(title, initial = "", type = "password") {
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
    $("dialogOk").onclick = () => done(input.value);
    $("dialogCancel").onclick = () => done(null);
    dlg.querySelector(".dialog-mask").onclick = () => done(null);
    input.onkeydown = (e) => {
      if (e.key === "Enter") done(input.value);
      else if (e.key === "Escape") done(null);
    };
  });
}

const state = { encrypted: false, locked: false };

async function refresh() {
  const s = await send({ type: "state", tabId: null, hostname: null });
  state.encrypted = !!s.encrypted;
  state.locked = !!s.locked;
  $("encStatus").textContent = state.encrypted
    ? (state.locked ? "已启用（已锁定）" : "已启用")
    : "未启用";
  $("toggleEncBtn").textContent = state.encrypted ? "关闭" : "启用";
  $("changePwRow").hidden = !state.encrypted;
  $("lockRow").hidden = !state.encrypted || state.locked;
}

async function bootstrap() {
  try {
    const manifest = chrome.runtime.getManifest();
    $("verLabel").textContent = "v" + manifest.version;
    $("verValue").textContent = "v" + manifest.version;
    if (manifest.homepage_url) {
      $("repoLink").href = manifest.homepage_url;
      $("issuesLink").href = manifest.homepage_url.replace(/\/?$/, "/issues");
    }
  } catch {}
  $("yearLabel").textContent = new Date().getFullYear();
  try { await refresh(); } catch (e) { toast(e.message); }
}

// ---- events ----
$("toggleEncBtn").addEventListener("click", async () => {
  if (!state.encrypted) {
    const pw = await showPrompt("设置主密码（至少 6 位）");
    if (!pw) return;
    if (pw.length < 6) return toast("密码至少 6 位");
    const pw2 = await showPrompt("再次输入主密码以确认");
    if (pw2 !== pw) return toast("两次输入不一致");
    try { await send({ type: "enableEncryption", password: pw }); toast("已启用主密码"); }
    catch (e) { toast(e.message); }
  } else {
    const pw = await showPrompt("输入主密码以关闭加密");
    if (!pw) return;
    try { await send({ type: "disableEncryption", password: pw }); toast("已关闭主密码"); }
    catch (e) { toast(e.message); }
  }
  await refresh();
});

$("changePwBtn").addEventListener("click", async () => {
  const oldPw = await showPrompt("输入当前主密码"); if (!oldPw) return;
  const newPw = await showPrompt("输入新的主密码（至少 6 位）"); if (!newPw) return;
  if (newPw.length < 6) return toast("新密码至少 6 位");
  const newPw2 = await showPrompt("再次输入新的主密码");
  if (newPw !== newPw2) return toast("两次输入不一致");
  try { await send({ type: "changePassword", oldPassword: oldPw, newPassword: newPw }); toast("已修改"); }
  catch (e) { toast(e.message); }
  await refresh();
});

$("lockNowBtn").addEventListener("click", async () => {
  try { await send({ type: "lock" }); toast("已锁定"); }
  catch (e) { toast(e.message); }
  await refresh();
});

bootstrap();