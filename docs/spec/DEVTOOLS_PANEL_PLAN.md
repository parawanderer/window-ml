# DevTools panel for the debug sidebar — plan

Status: **planned, not built.** Greenlit design; captured here so it survives.

## Why

The debug sidebar is an in-page overlay (a content-script shadow-root shell hosting an
extension-origin iframe). To keep it out of the agent's `look` screenshots it must
**hide itself for every shot** (`__mlSidebarShot: hide/show` in `sidebar/shell.ts`).
That hide is inherently fragile:

- It's a hit-test hole: while `visibility:hidden`, a wheel gesture in flight falls
  through to the page and scrolls it — corrupting the shot and moving the page.
  (Mitigated now by a scroll-pin in `shell.ts`, but the whole dance is the smell.)
- It pollutes the page DOM and competes with the page's own scripts.

A **DevTools panel** is a separate browser surface: page screenshots physically cannot
include it, scroll can't leak, and it touches the page DOM zero. The catch is it only
exists while DevTools is open — so this is an **opt-in second surface, not a
replacement**. Both modes coexist; a toggle picks whether the in-page overlay also
mounts.

## Key enabler

The sidebar app is **already extension-origin**: it uses `chrome.runtime.sendMessage`
(LIST_MODELS, OLLAMA_PS, GET_SESSION…) and reads `chrome.storage` directly — all of
which work identically in a DevTools panel. Its **only** page-coupled input is one line:
`if (d.__mlDebug) onDebug(…)` inside the `window.addEventListener("message")` handler
(`sidebar/app.tsx`). So the UI is 100% reused; the work is **a second delivery pipe for
the event stream** + a thin DevTools shell.

## Behaviour decision

Events are **preserved between the overlay and the panel** — a panel opened mid-run
shows what already happened. Events are only dropped when the feature is **disabled**.
This requires a **per-tab replay buffer** in the background (the overlay never needed
one because it's always mounted when enabled; the panel connects late).

## Transport

```
injected.js  emitDebug → window.postMessage({__mlDebug})
   │
   ▼
content script (sidebar/shell.ts)
   ├─(a) → iframe overlay            (as today; when the overlay is mounted)
   └─(b) → chrome.runtime.sendMessage(ML_DEBUG_EVENT)   ← NEW, always
             │
             ▼
        background.js
             ├─ append to ring buffer[tabId]            ← NEW
             └─ relay to connected devtools port(s) for tabId
                        │
                        ▼
                 DevTools panel (panel.html → sidebar-app)
                   on connect: replay buffer[tabId], then stream live
```

## Pieces

| Piece | Size | Notes |
| --- | --- | --- |
| `manifest.json`: `"devtools_page": "devtools.html"` | trivial | one line |
| `devtools.html` + `devtools.ts` | small | `chrome.devtools.panels.create("ml", icon, "panel.html")` |
| `panel.html` | small | basically `sidebar.html`, loads the existing `sidebar-app` bundle |
| **app transport seam** (`app.tsx`) | small | when host is the panel, ingest `__mlDebug` from a `chrome.runtime` port instead of window messages; abstract the one listener |
| **background fan-out + ring buffer** (`background.ts`) | **medium** | ports keyed by `inspectedWindow.tabId`; buffer per tab; replay on connect; clean up on disconnect — the fiddly bit |
| `shell.ts`: forward `__mlDebug` → background | small | one `sendMessage` (always; harmless if no panel) |
| **toggle** (config) | small | suppress the in-page overlay when panel-only; `hideSidebarForShot` is already a no-op when the overlay isn't mounted |
| `build.mjs` | small | add `devtools` + `panel-app` (reuse `sidebar-app`) entry points; copy `devtools.html`/`panel.html` |

## Replay buffer

- Per-tab ring (cap by count, e.g. ~1000 events, or by bytes — screenshots are big, so
  prefer a modest count + drop-oldest).
- **Reset on main-frame navigation**: the content script re-injects on nav; have it send
  a `ML_DEBUG_RESET` on load, or clear on `chrome.tabs.onUpdated`/`webNavigation`
  main-frame commit. Otherwise a panel replays events from a page that's gone.
- On port connect: send the buffered events (a `replay` message the app ingests exactly
  like live ones — same `onDebug`), then stream live.
- Saved sessions still load from `chrome.storage.local` on mount regardless of the
  buffer; the buffer only matters for **live** in-flight runs (agent runs are
  `save:false`).

## Toggle semantics

- `debugEnabled` (existing): master switch — gates `emitDebug` at the source.
- New flag, e.g. `debugSurface: "overlay" | "panel" | "both"` (default `"overlay"`):
  - `overlay` — today's behaviour, no panel wiring active.
  - `panel` — don't mount the in-page overlay; use the DevTools panel only (no
    hide-for-shot ever, since nothing's in the page).
  - `both` — overlay mounts AND the panel works when DevTools is open.
- The panel is *available* whenever DevTools is open and `debugEnabled`; the flag only
  controls the in-page overlay + whether shell forwards to background (always cheap to
  forward, so it can just always forward).

## Sharp edges

1. **Port lifecycle / tabId routing** — register on `onConnect({name:"ml-devtools"})`,
   read the panel's `chrome.devtools.inspectedWindow.tabId`, route the right tab's
   events, remove on `port.onDisconnect`. Easy to leak or cross-wire; the one part to
   test carefully.
2. **Buffer reset on navigation** (above) — get it wrong and a panel shows stale events.
3. **Outbound page-directed messages** the app sends today:
   - lightbox (`__mlLightbox`) — internal to the app; fine in a panel.
   - shot hide/show — only relevant to the *overlay*; N/A in panel mode.
   - a *future* "highlight this DOM node on hover" feature would need page access from
     the panel via `chrome.devtools.inspectedWindow.eval` or a background round-trip.
     Out of scope for v1.

## Testing

- Background ring buffer + tabId routing: **unit-testable** (mock ports + `sendMessage`),
  add to `tests/background.test.js`.
- App transport seam: mockable — inject events through the abstracted source in
  `loadSidebarWorld`.
- End-to-end (panel actually renders in DevTools): **manual** — load unpacked, open
  DevTools, confirm the "ml" panel streams + replays. Can't be headless-tested here.

## Non-goals (v1)

- Panel-driven page manipulation (DOM-node highlight, click-through). View + export only,
  same as the overlay.
- Dropping the in-page overlay. It stays the default; the panel is additive.
