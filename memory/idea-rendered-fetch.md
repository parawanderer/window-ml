---
name: idea-rendered-fetch
description: "Backlog: a fetch_url `rendered` mode — open the URL in a background tab, let JS render, grab the settled DOM HTML, close it (SPA content raw fetch can't get)"
metadata:
  node_type: memory
  type: project
---

Shane's idea: `ml.fetch`/`fetch_url` today does a RAW GET — for a client-rendered SPA that returns an empty
shell + JS, that's useless. The extension CAN do what a raw fetch (or Claude Code) can't: **open the URL in a
background tab, let the JS "slop" load and render, then read the settled `document.documentElement.outerHTML`
(or innerText), then close the tab.** A specific **mode the model passes to the fetch tool** (e.g.
`fetch_url({ url, mode: "rendered" })` or `render: true`) alongside the existing raw path. Neighbours
[[project-ml-fetch-tool]] and the `ask`-mode distill (commit after 748a0d5).

**Sketch:** `chrome.tabs.create({ url, active: false })` → wait for `tabs.onUpdated` complete + a settle
heuristic (load event + a short network-idle / fixed delay, like `settle()` in util.ts) → inject a
content-script grab (`outerHTML`/`innerText`) → `chrome.tabs.remove`. Reuse `clipOut` + the same
`classifyContent`/`FetchResult` shape so it chains like a raw fetch (and could feed `ask` on top:
fetch-rendered → distill).

**Why it's NOT just raw fetch (the security weight):** a background tab is a **real navigation AS THE USER** —
it carries the user's cookies/session on that origin. So it's effectively a **credentialed** fetch + JS
execution, not the uncredentialed raw GET. It must inherit (or exceed) [[idea-credentialed-ml-fetch]]'s
discipline: ALWAYS prompt, never cached, one-time choke-point grant, no silent inline `exec` use. Extra
weight raw fetch doesn't have: it EXECUTES the page's JS (a hostile page runs in a real tab), and it spawns a
visible-ish tab (lifecycle cleanup on error/timeout is mandatory — never leak an orphan tab).

**Open questions (TBD, deferred — not this session):** settle heuristic (how long to wait for "slop"?);
active vs truly-background tab (some sites don't render when backgrounded/throttled); whether to strip
scripts before returning; consent copy ("open <url> in a background tab as you, run its JS, read the result").
Worth a small spec before building. Status: BACKLOG idea, memory only.
