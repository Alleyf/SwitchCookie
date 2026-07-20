# SwitchCookie · 浏览器账号切换器（每标签隔离版 v0.3）

Chrome / Edge (Manifest V3) 扩展。**同一个域名可以在多个标签页里各自登录不同账号**，
Cookie 与 localStorage 均按标签隔离，互不干扰。数据本地存储，可选主密码加密。

## ✨ 功能

- **每标签隔离**（Cookie + localStorage）：绑定后，该标签的所有 HTTP 请求会被改写成使用绑定账号的 Cookie；页面 JS 读写 `localStorage` 走的是该标签的私有存储，不会互相覆盖。
- **在新标签中打开**：卡片上的↗按钮会新开一个标签并绑定好账号后再加载目标 URL。
- **完整快照**：Cookie（含 HttpOnly）、localStorage、sessionStorage 一次打包。
- **Set-Cookie 吸收**：服务器下发的新 Cookie 自动进入该标签的私有 jar，并从全局 jar 中清理。
- **主密码保护**：AES-GCM + PBKDF2 加密整个快照库。
- **编辑账号快照**：直接在插件里增删改 Cookie（含 Domain / Path / 过期时间 / Secure / HttpOnly / SameSite）以及 localStorage / sessionStorage 键值；正在被其他标签绑定的账号会即时同步。
- **精准域名归组**：内置 Public Suffix List。

## 🚀 安装

1. `chrome://extensions` → 打开右上角 **开发者模式**。
2. **加载已解压的扩展程序** → 选择本项目根目录。

## 🧭 使用

1. 正常登录 A 账号 → 打开插件 → **保存当前身份为新账号**（例如"账号 A"）。
2. 登出后再登录 B 账号 → 保存为"账号 B"。
3. **两标签同时用两个账号**：
   - 卡片右侧点↗ 在新标签以此账号打开；或
   - 新开空白标签导航到网站 → 打开插件点账号卡片进行绑定。
4. 绑定后顶部会显示"此标签已隔离绑定：xxx"，点"解除隔离"可回到全局模式。

## ⚠️ 已知边界

| 场景 | 表现 | 原因 |
| --- | --- | --- |
| 站点用 Service Worker / Web Worker 中转登录请求 | 部分请求仍走全局身份 | SW fetch `tabId = -1`，DNR 无法按标签匹配 |
| 站点用 IndexedDB / Cache Storage 存登录态 | 多个隔离标签会看到同一份 | 浏览器按 origin 隔离，扩展层无法在不刷新的前提下劫持这些 API |
| 页面 JS 用 `document.cookie` 读 cookie | 读到的是浏览器全局 jar | 该 API 无法被扩展覆盖 |
| 页面用 iframe 沙箱或 `Object.freeze(window)` 冻结 localStorage 描述符 | 该 frame 内隔离失效 | 我们 defineProperty 会静默失败 |

对**只依赖 Cookie 或 localStorage 认证**的绝大多数网站（包括大部分传统 Web、CMS、SPA），
每标签隔离能完美工作。IndexedDB 重度依赖的站点建议一次只开一个隔离标签。

## 🛠 技术要点

- **DNR session rules**：`chrome.declarativeNetRequest.updateSessionRules({ tabIds, requestDomains })` 按标签改写 `Cookie` 请求头。
- **webRequest.onHeadersReceived (extraHeaders)**：观测响应中的 `Set-Cookie`，合并进标签私有 jar，同时清理全局 jar。
- **content_scripts (MAIN world, document_start)**：`shadow.js` 用 `Object.defineProperty(window, "localStorage", ...)` 装一层 Proxy；ISOLATED world 的 `bridge.js` 通过 `CustomEvent` 与 MAIN world 通信、和 background 收发绑定状态和存储更新。
- **Web Crypto**：`PBKDF2-SHA256(250000) → AES-GCM(256)`。

## 📁 目录结构

```
SwitchCookie/
├─ manifest.json          # v0.3
├─ background.js          # DNR + webRequest + tab 状态机
├─ content/
│  ├─ shadow.js           # MAIN world: localStorage Proxy
│  └─ bridge.js           # ISOLATED world: 绑定同步 + 变更回传
├─ lib/
│  ├─ psl.js
│  └─ crypto.js
├─ popup/
│  ├─ popup.html
│  ├─ popup.css
│  └─ popup.js
└─ icons/
```

## 📝 License

MIT
