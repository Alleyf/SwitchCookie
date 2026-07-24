# AGENTS.md — SwitchCookie

## Project type

Chrome/Edge MV3 extension. No build step, no bundler, no package.json, no npm. All JS loaded directly by the browser.

## Install & run

`chrome://extensions` → Developer mode → **Load unpacked** → select repo root.
No build or dev server. Reload the extension after changing any file.

## Architecture (what agents get wrong)

### Three execution environments

| Env | File | Key constraint |
|---|---|---|
| Background SW | `background.js` | **Top-level `await` is disallowed in MV3 service workers.** Must wrap in IIFE. |
| MAIN world | `content/shadow.js` | Proxy on `localStorage` + `sessionStorage`; intercepts `document.cookie` **writes**. |
| ISOLATED world | `content/bridge.js` | BG via `chrome.runtime.sendMessage`; MAIN via `CustomEvent` on the page. |

### DNR rule ID scheme

`ruleId = 1_000_000 + tabId`. Session rules only (`updateSessionRules`).

### Cookie isolation strategy

- **Outbound**: DNR `modifyHeaders` rewrites `Cookie` per-tab for `domainKey` + related SSO domains + domains present in the jar.
- **Inbound**: `webRequest.onHeadersReceived` → virtual jar + scrub global jar.
- **document.cookie writes**: MAIN → `sc:cookie-write` → bridge → BG `setCookie`.
- **Storage**: proxies for local + session; bridge reports `storageChanged` with both.
- **Live sync**: jar/storage changes debounce-save back into the bound account snapshot (`saveAccountLiveState`).

### Related domain groups

`RELATED_DOMAIN_GROUPS` in `background.js` (Google/YouTube, Microsoft, GitHub, …). Used by snapshot `getDomainCookies` and DNR `requestDomains`.

### Storage keys (all prefixed `sc:`)

- `sc:meta` / `sc:cipher` / `sc:plain` — account store (`chrome.storage.local`)
- `sc:session:bindings|jars|local|session` — per-tab binding (`chrome.storage.session`)
- Legacy `sc:accounts` / `sc:active` migrated by `migrateLegacy()`

## Known hard limits (do not try to "fix")

- `document.cookie` **reads** return global jar — not interceptable.
- Service Worker / Web Worker fetches (`tabId = -1`) cannot be rewritten.
- IndexedDB / Cache Storage is per-origin shared.
- `Object.freeze(window)` or iframe sandbox can break storage proxies.
- CHIPS partitioned cookies cannot be fully simulated.

## Style

- Chinese UI strings, English code comments.
- Follow existing comment style: `// --- section ---` separators.
- No external libraries unless vendored in `lib/`.
