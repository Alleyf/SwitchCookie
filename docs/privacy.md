# SwitchCookie 隐私政策

最后更新：2026-07-21

## 我们收集什么

SwitchCookie **不收集、不上传任何个人信息**，也没有任何远程服务器或分析上报。

扩展仅在你的浏览器本地处理以下数据：

- **Cookie**：你在网站上登录后保存的账号快照（含 HttpOnly Cookie）。
- **localStorage / sessionStorage**：网页本地存储的键值。
- **绑定关系**：哪个标签页绑定了哪个账号（保存在浏览器会话存储中）。

## 数据存储位置

所有账号快照仅存储在你的浏览器本地：

- `chrome.storage.local` —— 持久化的账号快照（可选主密码 AES-GCM 加密）。
- `chrome.storage.session` —— 当前浏览器会话内的标签绑定状态。

这些数据**不会以任何形式传输到 SwitchCookie 开发者或任何第三方服务器**。

## 我们如何使用数据

数据仅用于扩展的核心功能：在同一浏览器的不同标签页之间隔离不同账号的身份（Cookie 与 localStorage），实现"同一域名多账号同时登录"。

扩展**不会**：

- 将你的数据发送至外部网络；
- 出售、出租或共享你的数据；
- 用于个性化广告或数据经纪。

## 权限说明

| 权限 | 用途 |
|------|------|
| `cookies` | 读取 / 移除全局 Cookie，擦除隔离标签的 Set-Cookie 泄漏 |
| `storage` | 本地保存账号快照与绑定状态 |
| `tabs` | 查询当前标签、在新标签打开账号 |
| `scripting` | 注入脚本读取页面 localStorage / sessionStorage |
| `webRequest` | 拦截响应中的 Set-Cookie 头 |
| `declarativeNetRequest` | 按标签改写 Cookie 请求头 |
| `<all_urls>` | 对任意站点执行上述 Cookie 隔离操作 |

## 主密码

若你启用了主密码保护，账号快照会以 `PBKDF2-SHA256` 派生密钥 + `AES-GCM-256` 加密。密钥仅存在于扩展后台服务进程内存中，重启后需重新输入。

## 你的选择

你可以随时在扩展中删除任意账号快照，或卸载扩展以清除全部本地数据。

## 联系方式

隐私相关问题请联系：privacy@switchcookie.example（请替换为你的真实邮箱）

---

本政策遵循 Chrome Web Store 的「限制使用」要求：用户数据仅用于向用户提供服务所必需的功能。
