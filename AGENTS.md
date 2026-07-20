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
| MAIN world | `content/shadow.js` | Runs in page's JS context. Installs Proxy on `window.localStorage`. |
| ISOLATED world | `content/bridge.js` | Talks to BG via `chrome.runtime.sendMessage`; talks to MAIN world via `window.dispatchEvent(new CustomEvent(...))` on the same page. |

### DNR rule ID scheme

`ruleId = 1_000_000 + tabId`. Session rules only (`updateSessionRules`). Collision-free as long as tabId < 1e6 (browser enforces this).

### Cookie isolation strategy

- **Outbound**: DNR `modifyHeaders` rewrites `Cookie` header per-tab per-domain.
- **Inbound**: `webRequest.onHeadersReceived` captures `Set-Cookie` into per-tab virtual jar, then scrubs from global jar via `chrome.cookies.remove`.
- **Storage**: `shadow.js` Proxy intercepts `localStorage` reads/writes → routes to per-tab `Map` when bound.

### Storage keys (all prefixed `sc:`)

- `sc:meta` / `sc:cipher` / `sc:plain` — encrypted or plaintext account store (`chrome.storage.local`)
- `sc:session:bindings|jars|local` — per-tab binding state (`chrome.storage.session` — survives SW restart)
- Legacy keys `sc:accounts` / `sc:active` auto-migrated by `migrateLegacy()`

## Known hard limits (do not try to "fix")

- `document.cookie` reads return global jar — browser API, not interceptable.
- Service Worker / Web Worker fetches (`tabId = -1`) cannot be rewritten.
- IndexedDB / Cache Storage is per-origin shared — not isolatable without page refresh hack.
- `Object.freeze(window)` or iframe sandbox can silently break the localStorage Proxy.

## Style

- Chinese UI strings, English code comments.
- Follow existing comment style: `// --- section ---` separators.
- No external libraries permitted unless they ship as a vendored file in `lib/`.
