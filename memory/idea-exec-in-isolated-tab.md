---
name: idea-exec-in-isolated-tab
description: "To-discuss: run an exec that needs NO window (e.g. just ml.fetch) in an isolated background tab / clean realm to dodge a page's Trusted Types + CSP, erroring only if it actually touches window/DOM"
metadata:
  node_type: memory
  type: project
---

Shane's pain: on a Trusted-Types / strict-CSP site (github.com), the page blocks the extension's `eval`-backed
`exec` — but often the model's JS does NO window/DOM ops at all, it just wants `ml.fetch(url)` + some pure JS.
Getting blocked by "Safe Types shit" for a call that never touches the page is dumb.

**Idea:** run such an exec in an ISOLATED realm that has no Trusted-Types policy — an off-page **background tab**
(or an extension-origin worker / offscreen doc / sandboxed iframe) — and **error out cleanly if the code
actually needs `window`/`document`** (ReferenceError → "this exec touched the page; it can't run isolated,
retry on-page"). So a page-free exec (ml.fetch + compute) succeeds where the on-page eval was Trusted-Types-blocked;
a DOM-touching exec fails fast with an actionable message rather than silently.

**Notes / open questions:**
- The read-only interpreter ([[idea-readonly-exec-ml-introspection]], readonly-exec.ts) ALREADY dodges Trusted
  Types — it never compiles a string, so a read-only survey clears Gmail/github. The gap is the NON-readonly,
  approved exec that needs real `eval` on a TT page. This idea targets that.
- Realm choice: an **offscreen doc / dedicated worker** is extension-origin (no page TT policy, `'wasm'`-style
  CSP we control) and already exists for python_exec — could host a JS eval too. A background TAB is heavier
  (spawn+close) and is a real navigation (cookies) — the worker/offscreen is lighter for a pure-compute+fetch
  exec. But a worker has no `window` at all → the "error if it needs window" is automatic (ReferenceError).
- `ml.*` availability in that realm: the isolated realm has no `window.ml`. So the exec's `ml.fetch` would need
  the realm to expose a bridge to the background's FETCH_URL (like python's full mode reaching network). Design
  needed — probably a minimal `ml` shim in the realm that round-trips to the background (same choke-point
  consent as the page's ml.fetch).
- Security: same gate as on-page exec (approval); the realm can't touch the page, so it's STRICTLY less
  capable — good. The consent for ml.fetch/host-access is unchanged (background-enforced).

Related: [[idea-rendered-fetch]] (a background tab that RENDERS a page — different goal, same "isolated tab"
mechanic). Status: TO-DISCUSS / backlog idea, memory only.
