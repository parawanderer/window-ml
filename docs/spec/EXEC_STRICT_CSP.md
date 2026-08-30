# `exec` on strict-CSP / Trusted-Types pages — CDP `Runtime.evaluate`

## Problem

The `exec` tool's non-readonly path runs `new Function(...)`/`eval` in the page's
**main world** (`injected.js`). On a page whose CSP omits `'unsafe-eval'` (github,
Google apps) or enforces Trusted Types `require-trusted-types-for 'script'`, that eval
**throws** — the agent can't run *any* imperative exec there, even code that only wants
`ml.fetch(url)` + pure JS and never touches the DOM. Reported repeatedly (the
"Safe Type'd" errors).

## Spike finding — the "isolated world" route is DEAD in MV3

Gemini's brainstorm (`tmp/exec_gemini_summary.md`) proposed routing the eval to the
**content-script isolated world**, claiming it's exempt from the page's CSP/TT. **Verified
false** with `chrome.scripting.executeScript` ({world:"MAIN"} vs {world:"ISOLATED"}, each
doing `new Function`) against pages served `script-src 'self'`,
`require-trusted-types-for 'script'`, and both:

| page CSP | MAIN | ISOLATED |
| --- | --- | --- |
| `script-src 'self'` | ❌ page CSP | ❌ **extension CSP** |
| `require-trusted-types-for 'script'` | ❌ TT | ❌ **extension CSP** |

The isolated world doesn't *escape* CSP — it swaps the page's CSP for the **extension's**
(`script-src 'self' 'wasm-unsafe-eval'` — no `unsafe-eval`), which **MV3 forbids relaxing**.
So string-eval is blocked in the isolated world too. The readonly Pratt interpreter clears
TT precisely because it *never compiles a string* — the only CSP/TT-proof path today.

## Decision — CDP `Runtime.evaluate` via `chrome.debugger`

The devtools console evals on github fine because **the debugger is exempt from page
CSP/TT**. So run the escalated exec through `chrome.debugger` `Runtime.evaluate` — the same
`chrome.debugger` foundation as [[CDP_CLICK]] (which is also not-yet-built; building this
builds that foundation). This is the ONLY mechanism that actually clears a strict page.

```
background: chrome.debugger.attach({tabId}, "1.3")
          → Runtime.evaluate({ expression, awaitPromise:true, returnByValue:true,
                               userGesture:true, contextId:<main world> })
          → detach
```

`returnByValue` serializes the result back; `awaitPromise` handles the `await`/`return`
async body (wrap the source the same way the main-world exec does). Runs in the page's
**main world context** — so `window.ml`, page globals, and the live DOM are all reachable
(unlike the DOM-less Pyodide worker), just via the debugger's exempt evaluator.

## Tier routing (extends the readonly dialect)

1. **Tier 1 — readonly interpreter** (`readonly-exec.ts`, unchanged): side-effect-free
   surveys run in the mediated interpreter, no eval, no CSP/TT issue, auto-approved.
2. **Tier 2 — imperative exec** (out of dialect → the human gate):
   - **Permissive page** (feature-detect: `!window.trustedTypes?.defaultPolicy`-ish AND a
     probe eval succeeds): main-world `eval` as today (fast, no banner).
   - **Strict page** (main-world eval would throw): route to **CDP `Runtime.evaluate`**.
   Detection: try the cheap main-world eval first; on a CSP/TT `EvalError`, fall back to
   CDP. (Cheaper than sniffing headers; the throw IS the signal — mirrors the readonly
   try's degrade-on-throw pattern.)

## Security gating (same posture as CDP_CLICK)

CDP eval is arbitrary main-world code execution bypassing the page's CSP — powerful. Gate
identically to the click case:
- **Approval-gated** — an escalated exec is already `requiresApproval`; the CDP path is
  only reached AFTER the human approves the code (they see the exact source).
- **Runtime `debugger` permission** — request `chrome.debugger` at first use
  (`chrome.permissions`), not held ambiently.
- **A flag** — `cdpExec` config, off by default (like `cdpClick`).
- **The banner** — the unsuppressible "being debugged" bar IS the honest "the browser is
  being driven" signal. Appears only when CDP eval actually fires (a strict page), so it
  correlates with "the agent just ran privileged code on a locked-down page."

The asymmetry from CDP_CLICK holds: this is **write/execute** (approval-gated), not the
deliberately-unbuilt SOP-bypassing **read**.

## Payoff for the reported cache-miss bug

Today a readonly `ml.fetch` **cache miss** silently downgrades to approve + main-world eval
→ CSP hard-fail on github (the "why did step 16 auto-approve but 17 didn't" report). With
CDP eval the fallback **succeeds** instead of hitting the CSP wall — the downgrade becomes
seamless. (Independent nicety: make the cache-miss downgrade *visible* — a "ml.fetch cache
miss → needs approval" note — so it isn't mysterious.)

## Slices

1. **CDP foundation** (shared with CDP_CLICK): `chrome.debugger` attach/detach lifecycle,
   the runtime `debugger` permission request, the `cdpExec`/`cdpClick` flags. Pure
   attach/detach + a `Runtime.evaluate` wrapper, unit-testable against a fake debugger.
2. **Exec routing**: main-world eval → on CSP/TT throw → CDP `Runtime.evaluate`. Feature
   detect + the async-body wrap + result serialization (`returnByValue`).
3. **Consent + banner UX**: the flag, the permission prompt, and surfacing "ran via CDP
   (debugger)" in the step render so the human knows which path executed.
4. **e2e**: a strict-CSP page (the harness already serves one) where main-world exec throws
   but CDP eval succeeds — the inverse of the spike.

## Open questions

- Getting the main-world `contextId` for `Runtime.evaluate` (via `Runtime.enable` +
  `executionContextCreated`, or omit and let it default to the main world).
- Whether to ALSO offer CDP eval as a general fallback for the `ml.fetch`-cache-miss case
  even on permissive pages (probably not — only when the cheap path throws).
- Interaction with the persistent/cross-page runtime (attach per-eval, like CDP_CLICK's
  per-reserved-click, so the banner flashes meaningfully rather than staying up all run).
